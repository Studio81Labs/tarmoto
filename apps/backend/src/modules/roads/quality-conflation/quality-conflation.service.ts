import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import { osmRoadImportConfig } from '../osm-import/osm-import.config.js';
import { qualityConflationConfig } from './quality-conflation.config.js';
import { injectSmoothnessTags } from './smoothness-injection.js';
import {
  qualityScoreToSmoothness,
  type OsmSmoothness,
} from './quality-smoothness.js';

/**
 * One OSM way's conflated road quality, ready to inject as a `smoothness` tag.
 * This is exactly the artifact {@link injectSmoothnessTags} consumes: for each
 * way id, the single `smoothness` value to write onto it.
 */
export interface WaySmoothnessAssignment {
  /** OSM way id (bigint rendered as a string — JS can't hold it as a number). */
  osmWayId: string;
  /** OSM `smoothness` tag to inject (ADR-0005). */
  smoothness: OsmSmoothness;
  /** Length-weighted mean `quality_score` across the way's live segments. */
  representativeQuality: number;
  /** How many live, scored ~100 m segments backed the representative value. */
  segmentCount: number;
}

/** Row shape of the per-way aggregation query. */
interface WayQualityRow {
  osmWayId: string;
  representativeQuality: number;
  segmentCount: number;
}

/**
 * Phase 2 of #779 (ADR-0005): conflate `road_segments` quality onto OSM ways so
 * GraphHopper's stock `smoothness` encoded value carries it.
 *
 * `buildConflation()` produces the per-way `smoothness` assignments by joining
 * our ~100 m segments back to their OSM way via `osm_way_id` and picking a
 * representative value per way; `runConflation()` then streams the input `.osm`
 * extract to the configured output, injecting those tags ({@link
 * injectSmoothnessTags}). Triggering GraphHopper to re-import the derived extract
 * is the one deployment-shaped step left to ops (documented in the module
 * README) — the graph bakes `smoothness` at import time.
 *
 * **Resolution caveat (ADR-0005):** OSM tags attach to whole ways, but quality
 * is per ~100 m segment. We collapse a way's segments to one representative with
 * a **length-weighted mean** of the segments that actually have a
 * `quality_score`, then map that to the nearest `smoothness` tier. Segments
 * without crowdsourced data (`quality_score IS NULL`) are excluded from the
 * mean, and a way whose segments are all unscored produces **no assignment** —
 * so it keeps `MISSING`/neutral weighting rather than being penalised. Splitting
 * ways at segment boundaries for full resolution is a possible future refinement
 * once the per-way loss is measured on a real region.
 *
 * **Region-bounding:** when `TARMOTO_OSM_ROAD_IMPORT_BBOX` is set, only ways with
 * geometry intersecting that rectangle are conflated — the same region the OSM
 * extract (and therefore the GraphHopper graph) covers. Unset → the whole live
 * network, matching the importer's own gating.
 *
 * Tombstoned segments (`deactivated_at IS NOT NULL`, #835) are excluded, so a
 * road removed from OSM stops contributing its stale quality to the graph.
 */
@Injectable()
export class QualityConflationService {
  private readonly logger = new Logger(QualityConflationService.name);

  constructor(
    @InjectRepository(RoadSegment)
    private readonly repo: Repository<RoadSegment>,
    @Inject(osmRoadImportConfig.KEY)
    private readonly config: ConfigType<typeof osmRoadImportConfig>,
    @Inject(qualityConflationConfig.KEY)
    private readonly conflationConfig: ConfigType<
      typeof qualityConflationConfig
    >,
  ) {}

  /** Whether the scheduled conflation job should run (default off). */
  get enabled(): boolean {
    return this.conflationConfig.enabled;
  }

  /**
   * Run the full conflation: build the per-way `smoothness` assignments and
   * inject them into a derived `.osm` extract GraphHopper can re-import.
   *
   * Reads {@link QualityConflationConfig.inputFilePath} (the extract to tag,
   * normally the same one GraphHopper imports) and writes
   * {@link QualityConflationConfig.outputFilePath}. Idempotent — a matched way's
   * existing `smoothness` is replaced, not duplicated — so re-running on the same
   * extract + scores yields the same file.
   *
   * Triggering GraphHopper to re-import the derived file is an operator/infra
   * step (the graph bakes `smoothness` at import time): point the GraphHopper
   * import at `outputFilePath`. This method only produces that file.
   *
   * The write is **atomic**: output goes to a temp sibling that is renamed onto
   * `outputFilePath` only after it finishes cleanly. A wrong input path,
   * malformed XML, full disk, or mid-run crash therefore leaves the previous
   * good extract intact (BullMQ retries), rather than truncating the very file
   * GraphHopper is documented to import.
   */
  async runConflation(): Promise<{ waysTagged: number; assignments: number }> {
    const { inputFilePath, outputFilePath } = this.conflationConfig;
    if (!inputFilePath || !outputFilePath) {
      throw new Error(
        'Quality conflation is enabled but TARMOTO_QUALITY_CONFLATION_INPUT_FILE ' +
          'and/or TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE is not set',
      );
    }
    const assignments = await this.buildConflation();
    const bySmoothness = new Map<string, OsmSmoothness>(
      assignments.map((a) => [a.osmWayId, a.smoothness]),
    );

    const tmpPath = `${outputFilePath}.tmp`;
    const input = createReadStream(inputFilePath);
    const output = createWriteStream(tmpPath);
    let waysTagged: number;
    try {
      ({ waysTagged } = await injectSmoothnessTags(
        input,
        output,
        bySmoothness,
      ));
      // The injector issues every write but doesn't close the output — flush and
      // wait for the temp file to finish before the atomic rename.
      output.end();
      await once(output, 'finish');
    } catch (err) {
      // Abandon the partial temp file; the previous good extract is untouched.
      output.destroy();
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
    await rename(tmpPath, outputFilePath);

    this.logger.log(
      `Quality conflation wrote ${outputFilePath}: ${waysTagged} way(s) tagged ` +
        `from ${bySmoothness.size} assignment(s)`,
    );
    return { waysTagged, assignments: bySmoothness.size };
  }

  /**
   * Build the per-way `smoothness` assignments for the configured region.
   *
   * The result is deterministic (ordered by way id) and idempotent — it reads
   * current aggregates only, so re-running produces the same artifact until the
   * underlying `quality_score`s change.
   */
  async buildConflation(): Promise<WaySmoothnessAssignment[]> {
    const bbox = this.config.bbox;
    // Length-weighted mean quality per way over live, scored segments. Ways with
    // no scored segment never appear (the quality_score IS NOT NULL filter), so
    // they get no tag and stay neutral. NULLIF guards a degenerate all-zero
    // length way from a divide-by-zero (yields NULL → dropped by the mapping).
    const params: unknown[] = [];
    let regionClause = '';
    if (bbox) {
      regionClause =
        'AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)\n' +
        '        AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))';
      params.push(bbox[0], bbox[1], bbox[2], bbox[3]);
    }
    const sql = `
      SELECT osm_way_id::text AS "osmWayId",
             SUM(quality_score * length_m)
               / NULLIF(SUM(length_m), 0) AS "representativeQuality",
             COUNT(*)::int AS "segmentCount"
      FROM road_segments
      WHERE deactivated_at IS NULL
        AND osm_way_id IS NOT NULL
        AND quality_score IS NOT NULL
        ${regionClause}
      GROUP BY osm_way_id
      ORDER BY osm_way_id
    `;
    // Raw query returns `any`; annotate the binding (not an `as` cast the
    // linter would strip) so both the normal and strict OpenAPI-gen builds type
    // the rows. `COUNT(*)::int` and `float8` division come back as JS numbers;
    // `osm_way_id::text` as a string.
    const rows: WayQualityRow[] = await this.repo.query(sql, params);

    const assignments: WaySmoothnessAssignment[] = [];
    for (const row of rows) {
      const smoothness = qualityScoreToSmoothness(row.representativeQuality);
      // A scored way always maps (representativeQuality is non-null here), but
      // guard defensively: never emit an assignment without a tier.
      if (!smoothness) continue;
      assignments.push({
        osmWayId: row.osmWayId,
        smoothness,
        representativeQuality: row.representativeQuality,
        segmentCount: row.segmentCount,
      });
    }
    this.logger.log(
      `Quality conflation: ${assignments.length} way(s) tagged` +
        (bbox ? ` within region [${bbox.join(', ')}]` : ' (whole network)'),
    );
    return assignments;
  }
}
