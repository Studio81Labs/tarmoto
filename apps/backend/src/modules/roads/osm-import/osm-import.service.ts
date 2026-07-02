import { createReadStream } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  type OsmWaySource,
  type RoadSegmentRow,
  buildSegmentRows,
} from './segment-rows.js';
import { assembleWays } from './osm-assemble.js';
import { parseOsmXml } from './osm-xml-source.js';
import { osmImportConfig } from './osm-import.config.js';
import { planReassignment, type ExistingSegment } from './split-merge.js';
import type { LatLng } from './segmentation.js';

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
  // The identity index is partial on live rows (#835), so the arbiter must carry
  // its predicate — a conflict only ever matches a LIVE row, never a tombstone.
  return (
    `( ${target} ) WHERE "deactivated_at" IS NULL ` +
    `DO UPDATE SET ${set.join(', ')} WHERE ${changed.join(' OR ')}`
  );
}

/** Pre-built so it isn't reconstructed per chunk. */
export const ROAD_SEGMENT_ON_CONFLICT = buildOnConflictClause();

/**
 * Carry-over UPDATE (ADR-0006 / #835): re-point an EXISTING row — keeping its
 * `id` and every FK/crowdsourced column — onto an incoming segment that inherited
 * it across a split/merge. Mirrors the conflict clause: refresh the OSM-owned
 * columns, refresh the `surface_type` seed only while the segment isn't
 * rider-classified, and NULL the geometry-derived `elevation_*` (a carry-over is a
 * reshape by definition, so they'd be stale). Also clears `deactivated_at` so a
 * road that returns is revived rather than left tombstoned. Params: $1 osm_way_id,
 * $2 segment_index, $3 geojson, $4 length_m, $5 curviness_score, $6 road_name,
 * $7 road_number, $8 surface_type, $9 id.
 */
const CARRY_OVER_UPDATE = `
  UPDATE ${TABLE} SET
    osm_way_id = $1,
    segment_index = $2,
    geom = ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
    length_m = $4,
    curviness_score = $5,
    road_name = $6,
    road_number = $7,
    surface_type = CASE WHEN ${OSM_OWNS_SURFACE}
      THEN $8 ELSE "${TABLE}"."surface_type" END,
    elevation_min = NULL,
    elevation_max = NULL,
    elevation_profile = NULL,
    deactivated_at = NULL,
    last_updated = NOW()
  WHERE id = $9
`;

export interface OsmImportResult {
  /** Rows inserted or updated in place through the conflict upsert. */
  upserted: number;
  /** Existing rows re-pointed onto an incoming segment across a split/merge,
   *  preserving id + history. */
  carriedOver: number;
  /** Existing rows nothing in the snapshot matched — tombstoned, not deleted. */
  deactivated: number;
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
 * Split/merge reconciliation (#835, ADR-0006): the whole regional snapshot is
 * buffered and matched against the existing rows in its bbox, so a way that was
 * split or merged carries its `id` + history onto the incoming geometry by
 * geometry overlap, and a row nothing matches is tombstoned (`deactivated_at`),
 * never hard-deleted (the history tables FK it).
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
    // Buffer the region's rows so split/merge reconciliation can compare the whole
    // incoming snapshot against the existing rows in the same area. The input is a
    // regional extract (config file / bbox), so this is bounded; a parse/read
    // error propagates out of the buffering loop before any write, so a failed run
    // can't touch existing rows.
    const incoming: RoadSegmentRow[] = [];
    for await (const row of buildSegmentRows(source)) {
      incoming.push(row);
    }
    return this.reconcile(incoming);
  }

  /**
   * Reconcile the incoming snapshot against the existing rows in its bbox (#835,
   * ADR-0006). Rows whose stable `(osm_way_id, segment_index)` is unchanged upsert
   * in place (ids preserved, #751); the leftovers on each side are matched by
   * geometry so history follows the road across a split/merge — carry-over as an
   * id-preserving UPDATE, no match as a fresh insert, and an unmatched existing row
   * as a tombstone (`deactivated_at`), never a delete.
   */
  private async reconcile(
    incoming: RoadSegmentRow[],
  ): Promise<OsmImportResult> {
    if (incoming.length === 0) {
      this.logger.log('OSM import: empty snapshot, nothing to reconcile');
      return { upserted: 0, carriedOver: 0, deactivated: 0 };
    }

    // Stale detection is only sound over an EXPLICIT region (the extract's
    // boundary, TARMOTO_OSM_IMPORT_BBOX): a data-derived bbox (the extent of the
    // incoming roads) would tombstone existing rows that fall in the rectangle but
    // outside this extract, and miss removed roads beyond the current extrema.
    // With a region we load every existing row inside it (so edge-removed roads
    // are candidates) and may tombstone; without one we load only the incoming
    // extent for carry-over matching and never tombstone.
    const region = this.config.bbox;
    const existing = await this.loadExistingInBbox(
      region ?? this.dataBbox(incoming),
    );
    const incomingKeys = new Set(
      incoming.map((r) => this.identityKey(r.osm_way_id, r.segment_index)),
    );
    const existingKeys = new Set(
      existing.map((e) => this.identityKey(e.osm_way_id, e.segment_index)),
    );

    // Unchanged identity → straight upsert (id preserved by the conflict clause).
    // New identity → carry-over or fresh-insert candidate. Existing rows the
    // snapshot no longer contains → carry-over or stale candidate.
    const unchanged = incoming.filter((r) =>
      existingKeys.has(this.identityKey(r.osm_way_id, r.segment_index)),
    );
    const newIncoming = incoming.filter(
      (r) => !existingKeys.has(this.identityKey(r.osm_way_id, r.segment_index)),
    );
    const leftoverExisting = existing.filter(
      (e) => !incomingKeys.has(this.identityKey(e.osm_way_id, e.segment_index)),
    );

    const plan = planReassignment(
      leftoverExisting.map<ExistingSegment>((e) => ({
        id: e.id,
        coords: e.coords,
      })),
      newIncoming.map((r) => this.toLatLngs(r.geom)),
    );
    const carried = new Set(plan.carryOver.map((c) => c.incomingIndex));
    const upsertRows = [
      ...unchanged,
      ...newIncoming.filter((_, i) => !carried.has(i)),
    ];
    // Only tombstone when the region is authoritative (see above).
    const staleIds = region ? plan.stale : [];

    await this.repo.manager.transaction(async (tx) => {
      for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK) {
        await this.flush(tx, upsertRows.slice(i, i + UPSERT_CHUNK));
      }
      for (const c of plan.carryOver) {
        const row = newIncoming[c.incomingIndex]!;
        await tx.query(CARRY_OVER_UPDATE, [
          row.osm_way_id,
          row.segment_index,
          JSON.stringify(row.geom),
          row.length_m,
          row.curviness_score,
          row.road_name,
          row.road_number,
          row.surface_type,
          c.existingId,
        ]);
      }
      if (staleIds.length > 0) {
        await tx.query(
          `UPDATE ${TABLE} SET deactivated_at = NOW()
           WHERE id = ANY($1) AND deactivated_at IS NULL`,
          [staleIds],
        );
      }
    });

    const skippedStale = region ? 0 : plan.stale.length;
    this.logger.log(
      `OSM import: upserted ${upsertRows.length}, carried over ` +
        `${plan.carryOver.length}, deactivated ${staleIds.length} ` +
        `(${existing.length} existing / ${incoming.length} incoming; ` +
        `region ${region ? 'configured' : 'UNSET → stale detection off, ' + skippedStale + ' unmatched left active'})`,
    );
    return {
      upserted: upsertRows.length,
      carriedOver: plan.carryOver.length,
      deactivated: staleIds.length,
    };
  }

  private identityKey(osmWayId: string, segmentIndex: number): string {
    return `${osmWayId}:${segmentIndex}`;
  }

  private toLatLngs(line: GeoJSON.LineString): LatLng[] {
    return line.coordinates.map(([lng, lat]) => ({ lat: lat!, lng: lng! }));
  }

  /** Bounding box `[minLng, minLat, maxLng, maxLat]` of the incoming geometries —
   *  used for carry-over matching only when no explicit region is configured
   *  (never for stale detection; see `reconcile`). */
  private dataBbox(
    incoming: RoadSegmentRow[],
  ): [number, number, number, number] {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const r of incoming) {
      for (const [lng, lat] of r.geom.coordinates) {
        if (lng! < minLng) minLng = lng!;
        if (lng! > maxLng) maxLng = lng!;
        if (lat! < minLat) minLat = lat!;
        if (lat! > maxLat) maxLat = lat!;
      }
    }
    return [minLng, minLat, maxLng, maxLat];
  }

  /**
   * Existing ACTIVE, OSM-imported rows overlapping `bbox` — the reassignment
   * candidate pool. Crowd-sourced rows (null `osm_way_id`) are excluded: they
   * aren't part of the OSM network, so the importer never reassigns or tombstones
   * them.
   */
  private async loadExistingInBbox(
    bbox: [number, number, number, number],
  ): Promise<
    Array<{
      id: string;
      osm_way_id: string;
      segment_index: number;
      coords: LatLng[];
    }>
  > {
    // Annotate the binding (rather than an `as` cast) so `r` is typed under both
    // the local and strict OpenAPI-gen tsconfigs, which disagree on whether a cast
    // is redundant.
    const rows: Array<{
      id: string;
      osm_way_id: string;
      segment_index: number;
      geom: GeoJSON.LineString;
    }> = await this.repo.query(
      `SELECT id, osm_way_id::text AS osm_way_id, segment_index,
              ST_AsGeoJSON(geom)::json AS geom
       FROM ${TABLE}
       WHERE deactivated_at IS NULL
         AND osm_way_id IS NOT NULL
         AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
      bbox,
    );
    return rows.map((r) => ({
      id: r.id,
      osm_way_id: r.osm_way_id,
      segment_index: r.segment_index,
      coords: this.toLatLngs(r.geom),
    }));
  }

  private async flush(
    manager: EntityManager,
    rows: RoadSegmentRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // Raw conflict clause (not `repo.upsert` / the `orUpdate` array form) because
    // the DO UPDATE must (a) omit the crowdsourced columns, (b) refresh
    // `surface_type` / null `elevation_*` conditionally, and (c) skip no-op rows
    // — none of which the column-array API can express. `.values()` still builds
    // the INSERT (incl. PostGIS geometry binding); only the tail is raw.
    await manager
      .createQueryBuilder()
      .insert()
      .into(RoadSegment)
      .values(rows)
      .onConflict(ROAD_SEGMENT_ON_CONFLICT)
      .execute();
  }
}
