import { createReadStream } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  type OsmWaySource,
  type RoadSegmentRow,
  buildSegmentRows,
} from './segment-rows.js';
import { assembleWays } from './osm-assemble.js';
import { parseOsmXml } from './osm-xml-source.js';
import { osmImportConfig } from './osm-import.config.js';

/** Rows per bulk upsert — keeps each statement well under PG's 65,535-param
 *  limit (each row binds ~8 columns). */
const UPSERT_CHUNK = 500;

/** Target table — referenced bare in the raw conflict clause to read the
 *  existing row (Postgres `DO UPDATE` refers to the target row by table name,
 *  `EXCLUDED` to the proposed one). */
const TABLE = 'road_segments';

/** Conflict target: the stable `(osm_way_id, segment_index)` identity (#751). */
const CONFLICT_COLUMNS = ['osm_way_id', 'segment_index'];

/**
 * OSM-owned columns refreshed verbatim from the incoming snapshot on every
 * conflict. Excludes the crowdsourced/identity columns (`quality_score`,
 * `confidence`, `reading_count`, `id`) — the importer never carries them in its
 * rows, so they are untouched on update and defaulted on insert (the #751
 * stable-identity guarantee). `surface_type` is handled separately below.
 */
const OSM_REFRESH_COLUMNS = [
  'geom',
  'length_m',
  'curviness_score',
  'road_name',
  'road_number',
];

/** Geometry columns derived from `geom`, nulled when the geometry changes so a
 *  downstream elevation-enrichment pass recomputes them (a NULL profile/min/max
 *  is a state every consumer already handles). */
const GEOM_DERIVED_COLUMNS = [
  'elevation_min',
  'elevation_max',
  'elevation_profile',
];

/**
 * True iff the stored geometry differs from the incoming one at the vertex
 * level. `ST_OrderingEquals` compares exact coordinate sequence (bbox-gated
 * internally), so — unlike the `=`/`IS DISTINCT FROM` operator, which only
 * compares bounding boxes — a same-bbox reshape is still detected.
 */
const GEOM_CHANGED = `NOT ST_OrderingEquals("${TABLE}"."geom", EXCLUDED."geom")`;

/**
 * True iff a rider has NOT classified this segment's surface, i.e. the OSM seed
 * is still authoritative and may be refreshed. `surface_from_reading` (#796) is
 * the durable provenance flag maintained by `update_road_quality_for_segment`;
 * unlike the raw `surface_readings` it survives the `location_retention` sweep,
 * so gating on it never clobbers a crowd-classified surface after the sweep.
 */
const OSM_OWNS_SURFACE = `NOT "${TABLE}"."surface_from_reading"`;

/**
 * The raw `ON CONFLICT … DO UPDATE …` clause. Built once.
 *
 * `surface_type`: refreshed from the OSM seed only while the segment is not
 * rider-classified ({@link OSM_OWNS_SURFACE}); once a rider classifies it the
 * value is authoritative and preserved. The OSM seed is still INSERTed for new
 * segments.
 *
 * `elevation_*`: nulled whenever the geometry changes, since they were computed
 * from the previous geometry and would otherwise be served stale by
 * `RoadsService.findById` / fun-zone detail and skew elevation math.
 *
 * `WHERE …`: skips no-op rows. A weekly snapshot re-sends mostly-identical rows;
 * without this every conflict emits an unconditional `DO UPDATE`, churning row
 * locks + WAL on a national import. The row updates only if the geometry, an OSM
 * attribute, or an un-classified segment's surface seed actually changed.
 */
function buildOnConflictClause(): string {
  const set = [
    ...OSM_REFRESH_COLUMNS.map((c) => `"${c}" = EXCLUDED."${c}"`),
    `"surface_type" = CASE WHEN ${OSM_OWNS_SURFACE} ` +
      `THEN EXCLUDED."surface_type" ELSE "${TABLE}"."surface_type" END`,
    ...GEOM_DERIVED_COLUMNS.map(
      (c) =>
        `"${c}" = CASE WHEN ${GEOM_CHANGED} THEN NULL ELSE "${TABLE}"."${c}" END`,
    ),
  ];
  const changed = [
    GEOM_CHANGED,
    ...OSM_REFRESH_COLUMNS.filter((c) => c !== 'geom').map(
      (c) => `"${TABLE}"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`,
    ),
    `(${OSM_OWNS_SURFACE} AND ` +
      `"${TABLE}"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")`,
  ];
  const target = CONFLICT_COLUMNS.map((c) => `"${c}"`).join(', ');
  return `( ${target} ) DO UPDATE SET ${set.join(', ')} WHERE ${changed.join(' OR ')}`;
}

/** Pre-built so it isn't reconstructed per chunk. */
export const ROAD_SEGMENT_ON_CONFLICT = buildOnConflictClause();

export interface OsmImportResult {
  upserted: number;
}

/**
 * Persists the OSM road network into `road_segments` (#781). Streams rows from
 * an `OsmWaySource` (the PBF parser — separate slice) through the pure
 * transform and bulk-upserts them ON CONFLICT `(osm_way_id, segment_index)`.
 *
 * The conflict clause (see {@link ROAD_SEGMENT_ON_CONFLICT}) refreshes only the
 * OSM-owned columns, leaves the crowdsourced `quality_score` / `confidence` /
 * `reading_count` and the `id` untouched (the #751 stable-identity guarantee),
 * refreshes the `surface_type` seed only until a rider classifies the surface
 * (the durable `surface_from_reading` flag, #796), nulls the geometry-derived
 * `elevation_*` columns when the geometry changes, and skips unchanged rows.
 *
 * No delete pass here: stale rows (ways removed from OSM, or split/merged) are
 * the separate split/merge slice's concern — this overwrites in place.
 */
@Injectable()
export class OsmImportService {
  private readonly logger = new Logger(OsmImportService.name);

  constructor(
    @InjectRepository(RoadSegment)
    private readonly repo: Repository<RoadSegment>,
    @Inject(osmImportConfig.KEY)
    private readonly config: ConfigType<typeof osmImportConfig>,
  ) {}

  /** Whether the scheduled import is turned on (TARMOTO_OSM_IMPORT_ENABLED). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Import the configured `.osm` XML extract: stream it through the parser and
   * way assembler into the upsert. Read-stream errors and parse errors abort the
   * import via the generator chain; the upsert never deletes, so a partial or
   * failed run can't wipe existing rows.
   */
  async importFromConfiguredFile(): Promise<OsmImportResult> {
    const { filePath } = this.config;
    if (!filePath) {
      throw new Error(
        'OSM import is enabled but TARMOTO_OSM_IMPORT_FILE is not set',
      );
    }
    this.logger.log(`OSM import: reading ${filePath}`);
    const stream = createReadStream(filePath);
    return this.importFrom(assembleWays(parseOsmXml(stream)));
  }

  async importFrom(source: OsmWaySource): Promise<OsmImportResult> {
    let batch: RoadSegmentRow[] = [];
    let upserted = 0;

    for await (const row of buildSegmentRows(source)) {
      batch.push(row);
      if (batch.length >= UPSERT_CHUNK) {
        await this.flush(batch);
        upserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.flush(batch);
      upserted += batch.length;
    }

    this.logger.log(`OSM import: upserted ${upserted} road segments`);
    return { upserted };
  }

  private async flush(rows: RoadSegmentRow[]): Promise<void> {
    // Raw conflict clause (not `repo.upsert` / the `orUpdate` array form) because
    // the DO UPDATE must (a) omit the crowdsourced columns, (b) refresh
    // `surface_type` / null `elevation_*` conditionally, and (c) skip no-op rows
    // — none of which the column-array API can express. `.values()` still builds
    // the INSERT (incl. PostGIS geometry binding); only the tail is raw.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(RoadSegment)
      .values(rows)
      .onConflict(ROAD_SEGMENT_ON_CONFLICT)
      .execute();
  }
}
