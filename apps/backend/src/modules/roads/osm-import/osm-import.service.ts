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
 * conflict. Excludes the rider-derived columns (`confidence`, `reading_count`)
 * and the blended `quality_score` (gated separately below). `surface_type` and
 * `quality_score` are handled with CASE gates further down.
 */
const OSM_REFRESH_COLUMNS = [
  'geom',
  'length_m',
  'curviness_score',
  'road_name',
  'road_number',
  'osm_quality_seed',
  'quality_source',
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

/** True iff no rider has contributed to this segment, so the OSM seed is still
 *  the effective quality and may be (re)seeded. The blend (migration
 *  1811000000000) owns quality_score once readings exist. */
const OSM_OWNS_QUALITY = `"${TABLE}"."reading_count" = 0`;

/**
 * The raw `ON CONFLICT … DO UPDATE …` clause. Built once.
 *
 * `surface_type`: refreshed from the OSM seed only while the segment is not
 * rider-classified ({@link OSM_OWNS_SURFACE}); once a rider classifies it the
 * value is authoritative and preserved. The OSM seed is still INSERTed for new
 * segments.
 *
 * `quality_score`: seeded/refreshed from `osm_quality_seed` only while no rider
 * has contributed a reading ({@link OSM_OWNS_QUALITY}); once `reading_count > 0`
 * the blend (migration 1811000000000) owns it and the importer leaves it alone.
 *
 * `elevation_*`: nulled whenever the geometry changes, since they were computed
 * from the previous geometry and would otherwise be served stale by
 * `RoadsService.findById` / fun-zone detail and skew elevation math.
 *
 * `WHERE …`: skips no-op rows. A weekly snapshot re-sends mostly-identical rows;
 * without this every conflict emits an unconditional `DO UPDATE`, churning row
 * locks + WAL on a national import. The row updates only if the geometry, an OSM
 * attribute, an un-classified segment's surface seed, or a rider-less segment's
 * quality seed actually changed.
 */
function buildOnConflictClause(): string {
  const set = [
    ...OSM_REFRESH_COLUMNS.map((c) => `"${c}" = EXCLUDED."${c}"`),
    `"surface_type" = CASE WHEN ${OSM_OWNS_SURFACE} ` +
      `THEN EXCLUDED."surface_type" ELSE "${TABLE}"."surface_type" END`,
    `"quality_score" = CASE WHEN ${OSM_OWNS_QUALITY} ` +
      `THEN EXCLUDED."osm_quality_seed" ELSE "${TABLE}"."quality_score" END`,
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
    `(${OSM_OWNS_QUALITY} AND ` +
      `"${TABLE}"."quality_score" IS DISTINCT FROM EXCLUDED."osm_quality_seed")`,
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
 * columns (including the quality seed + source), refresh the `surface_type` seed
 * only while the segment isn't rider-classified and `quality_score` only while
 * it's rider-less, and NULL the geometry-derived `elevation_*` (a carry-over is a
 * reshape by definition, so they'd be stale). Also clears `deactivated_at` so a
 * road that returns is revived rather than left tombstoned. Params: $1 osm_way_id,
 * $2 segment_index, $3 geojson, $4 length_m, $5 curviness_score, $6 road_name,
 * $7 road_number, $8 surface_type, $9 id, $10 osm_quality_seed, $11 quality_source.
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
    osm_quality_seed = $10,
    quality_source = $11,
    quality_score = CASE WHEN ${OSM_OWNS_QUALITY}
      THEN $10 ELSE "${TABLE}"."quality_score" END,
    elevation_min = NULL,
    elevation_max = NULL,
    elevation_profile = NULL,
    deactivated_at = NULL,
    last_updated = NOW()
  WHERE id = $9
`;

/**
 * Does the line segment (x0,y0)-(x1,y1) intersect the axis-aligned rectangle
 * [xmin,ymin,xmax,ymax]? Liang–Barsky parametric clip: the segment enters the rect
 * iff its clipped [t0,t1] range is non-empty. Matches PostGIS `ST_Intersects` for a
 * linestring vs an envelope, so the incoming-row filter agrees exactly with the
 * existing-row load (a corner-clipping segment is kept/dropped the same way).
 */
function segmentIntersectsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false; // parallel and outside this edge
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

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
 * OSM-owned columns, leaves the rider-derived `confidence` / `reading_count` and
 * the `id` untouched (the #751 stable-identity guarantee), refreshes the
 * `surface_type` seed only until a rider classifies the surface (the durable
 * `surface_from_reading` flag, #796), reseeds `quality_score` from the OSM prior
 * only while the segment stays rider-less (`reading_count = 0` — the blend owns
 * it once readings exist), nulls the geometry-derived `elevation_*` columns when
 * the geometry changes, and skips unchanged rows.
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
    // incoming snapshot against the existing rows in the same area — it can't be a
    // pure per-chunk stream like a plain upsert. This is region-scoped by design,
    // so the operator sizes the extract/bbox to the worker heap and tiles a large
    // area into several sub-imports (see the module README, "Memory & scale"). A
    // parse/read error propagates out of the buffering loop before any write, so a
    // failed run can't touch existing rows.
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
    rawIncoming: RoadSegmentRow[],
  ): Promise<OsmImportResult> {
    // `osmium extract -b` does NOT clip geometries — it emits every COMPLETE way
    // that crosses the bbox, so a boundary-crossing way yields full-length rows
    // outside the configured region. Constrain the incoming set to the region:
    // otherwise one tile would upsert out-of-tile keys whose old out-of-tile rows
    // (loaded only from THIS bbox) can't carry over, and an adjacent tile would
    // then see those keys as unchanged and tombstone the old rows, orphaning
    // history. A segment straddling the edge is kept by both tiles — the upsert is
    // idempotent on identical geometry.
    const region = this.config.bbox;
    const incoming = region
      ? rawIncoming.filter((r) => this.intersectsRegion(r, region))
      : rawIncoming;

    // With a configured region an EMPTY tile is still authoritative — every road
    // in it was removed / reclassified non-drivable, so its existing rows must be
    // tombstoned. Only short-circuit the no-region case (nothing to compare, and
    // we never tombstone without a region). A parse error would have thrown before
    // reaching here, so an empty snapshot here is a genuine empty region.
    if (incoming.length === 0 && !region) {
      this.logger.log('OSM import: empty snapshot, no region — nothing to do');
      return { upserted: 0, carriedOver: 0, deactivated: 0 };
    }

    // Stale detection is only sound over an EXPLICIT region (the extract's
    // boundary, TARMOTO_OSM_IMPORT_BBOX): a data-derived bbox (the extent of the
    // incoming roads) would tombstone existing rows that fall in the rectangle but
    // outside this extract, and miss removed roads beyond the current extrema.
    // With a region we load every existing row inside it (so edge-removed roads
    // are candidates) and may tombstone; without one we load only the incoming
    // extent for carry-over matching and never tombstone.
    const existing = await this.loadExistingInBbox(
      region ?? this.dataBbox(incoming),
    );
    const existingByKey = new Map(
      existing.map((e) => [this.identityKey(e.osm_way_id, e.segment_index), e]),
    );

    // A key match is "unchanged" (straight upsert, id preserved) only when it is
    // still the same ROAD. An OSM split can KEEP the way id on a downstream piece,
    // so `(osm_way_id, segment_index)` can appear in both snapshots for DIFFERENT
    // geometry; upserting that in place would move the old row's history onto the
    // wrong road. So a key match whose geometry no longer overlaps is pushed into
    // the geometry-reassignment pool instead — regardless of region. Identical
    // geometry short-circuits the (relatively costly) overlap check.
    const unchanged: RoadSegmentRow[] = [];
    const newIncoming: RoadSegmentRow[] = [];
    const keptKeys = new Set<string>();
    for (const r of incoming) {
      const key = this.identityKey(r.osm_way_id, r.segment_index);
      const match = existingByKey.get(key);
      const isUnchanged =
        match !== undefined &&
        (this.coordsEqual(match.coords, r.geom.coordinates) ||
          this.sameRoad(match.coords, r.geom));
      if (isUnchanged) {
        unchanged.push(r);
        keptKeys.add(key);
      } else {
        newIncoming.push(r);
      }
    }
    const leftoverExisting = existing.filter(
      (e) => !keptKeys.has(this.identityKey(e.osm_way_id, e.segment_index)),
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
    const carryTargetIds = plan.carryOver.map((c) => c.existingId);
    const claimedKeys = new Set(
      [...unchanged, ...newIncoming].map((r) =>
        this.identityKey(r.osm_way_id, r.segment_index),
      ),
    );
    const staleSet = new Set(plan.stale);

    // A key the new snapshot assigns to a DIFFERENT row must have its old holder
    // vacated so the re-key/insert doesn't collide. We TOMBSTONE those holders
    // (rather than null their identity): a reused key is definitive proof the old
    // holder lost that identity, and nulling `osm_way_id` would orphan the row —
    // `loadExistingInBbox` skips NULL osm ids, so no later tile could ever
    // reconcile it and it would linger live as a phantom crowd row. Two sources:
    //  - in-bbox stale rows whose key the snapshot reassigned (always, even with
    //    no region — this is key reuse, not stale-by-absence);
    //  - out-of-bbox LIVE owners of a claimed key: the ON CONFLICT arbiter is
    //    global but `existingByKey` is bbox-scoped, so a key owned by a live row
    //    just outside this tile (a segment split/moved across the boundary) would
    //    otherwise be silently overwritten in place.
    const inBboxReusedIds = leftoverExisting
      .filter(
        (e) =>
          staleSet.has(e.id) &&
          claimedKeys.has(this.identityKey(e.osm_way_id, e.segment_index)),
      )
      .map((e) => e.id);
    const outOfBboxOwnerIds = await this.loadOutOfBboxKeyOwners(
      newIncoming,
      new Set(existing.map((e) => e.id)),
    );
    // Tombstone: stale-by-absence (region only) + reused-key holders (always).
    const deactivateIds = [
      ...new Set([
        ...(region ? plan.stale : []),
        ...inBboxReusedIds,
        ...outOfBboxOwnerIds,
      ]),
    ];

    await this.repo.manager.transaction(async (tx) => {
      // Apply order matters — a split/merge can move an `(osm_way_id,
      // segment_index)` key from one live row to another, so free every key that's
      // being reassigned BEFORE anything claims it, or the partial unique index
      // rejects the re-key.
      // 1. Tombstone stale + reused-key rows: the partial index then drops their
      //    keys, preserving the row (and its history FKs) rather than orphaning it.
      if (deactivateIds.length > 0) {
        await tx.query(
          `UPDATE ${TABLE} SET deactivated_at = NOW()
           WHERE id = ANY($1) AND deactivated_at IS NULL`,
          [deactivateIds],
        );
      }
      // 2. Null the carry-over targets' OLD identity (they're immediately re-keyed
      //    in step 3) so a rotation swapping keys between live rows can't collide.
      if (carryTargetIds.length > 0) {
        await tx.query(
          `UPDATE ${TABLE} SET osm_way_id = NULL, segment_index = NULL
           WHERE id = ANY($1)`,
          [carryTargetIds],
        );
      }
      // 3. Carry-over: set the new identity + geometry on each freed row.
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
          row.osm_quality_seed,
          row.quality_source,
        ]);
      }
      // 4. Upsert unchanged + fresh inserts — the keys they need are free now.
      for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK) {
        await this.flush(tx, upsertRows.slice(i, i + UPSERT_CHUNK));
      }
    });

    const byAbsenceSkipped = region
      ? 0
      : plan.stale.length - inBboxReusedIds.length;
    this.logger.log(
      `OSM import: upserted ${upsertRows.length}, carried over ` +
        `${plan.carryOver.length}, deactivated ${deactivateIds.length} ` +
        `(${existing.length} existing / ${incoming.length} incoming; ` +
        `region ${region ? 'configured' : 'UNSET → ' + byAbsenceSkipped + ' by-absence rows left active'})`,
    );
    return {
      upserted: upsertRows.length,
      carriedOver: plan.carryOver.length,
      deactivated: deactivateIds.length,
    };
  }

  /** Live rows OUTSIDE the loaded bbox that own one of the incoming `newIncoming`
   *  keys — the global-uniqueness owners the bbox load can't see. They are
   *  tombstoned (not identity-nulled, which would orphan them) so the upsert
   *  doesn't silently overwrite an out-of-tile road. */
  private async loadOutOfBboxKeyOwners(
    newIncoming: RoadSegmentRow[],
    bboxIds: Set<string>,
  ): Promise<string[]> {
    if (newIncoming.length === 0) return [];
    // Annotate the binding (not an `as` cast) so `r` is typed under both the local
    // and strict OpenAPI-gen tsconfigs, which disagree on whether a cast is
    // redundant.
    const rows: Array<{ id: string }> = await this.repo.query(
      `SELECT rs.id
       FROM ${TABLE} rs
       JOIN unnest($1::bigint[], $2::int[]) AS k(w, i)
         ON rs.osm_way_id = k.w AND rs.segment_index = k.i
       WHERE rs.deactivated_at IS NULL`,
      [
        newIncoming.map((r) => r.osm_way_id),
        newIncoming.map((r) => r.segment_index),
      ],
    );
    return rows.map((r) => r.id).filter((id) => !bboxIds.has(id));
  }

  /** Same road as far as the reassignment matcher is concerned — identical or a
   *  reshape that still overlaps. Reuses `planReassignment` on the singleton pair
   *  so a key match with NON-overlapping geometry (a split that kept the way id on
   *  a different piece) is caught and pushed into reassignment. */
  private sameRoad(
    existingCoords: LatLng[],
    incoming: GeoJSON.LineString,
  ): boolean {
    return (
      planReassignment(
        [{ id: '_', coords: existingCoords }],
        [this.toLatLngs(incoming)],
      ).carryOver.length > 0
    );
  }

  /** Cheap vertex-wise equality (≈1 cm tolerance) so an unchanged re-import skips
   *  the overlap check; `ST_AsGeoJSON` rounding won't defeat it. */
  private coordsEqual(a: LatLng[], b: GeoJSON.Position[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (
        Math.abs(a[i]!.lng - b[i]![0]!) > 1e-7 ||
        Math.abs(a[i]!.lat - b[i]![1]!) > 1e-7
      ) {
        return false;
      }
    }
    return true;
  }

  private identityKey(osmWayId: string, segmentIndex: number): string {
    return `${osmWayId}:${segmentIndex}`;
  }

  /** Whether the segment's geometry actually intersects the rectangle `[minLng,
   *  minLat, maxLng, maxLat]` — the SAME exact test `loadExistingInBbox` runs in
   *  Postgres (`ST_Intersects`), so a segment clipping a tile corner is judged
   *  identically on both sides. A bbox-overlap check would over-keep such a
   *  segment on the incoming side only, leaking out-of-region rows. Each leg is
   *  clipped against the rectangle (Liang–Barsky); any leg that survives means the
   *  polyline enters it. */
  private intersectsRegion(
    row: RoadSegmentRow,
    [minLng, minLat, maxLng, maxLat]: [number, number, number, number],
  ): boolean {
    const coords = row.geom.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const [x0, y0] = coords[i - 1]!;
      const [x1, y1] = coords[i]!;
      if (
        segmentIntersectsRect(
          x0!,
          y0!,
          x1!,
          y1!,
          minLng,
          minLat,
          maxLng,
          maxLat,
        )
      ) {
        return true;
      }
    }
    return false;
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
      // `&&` (bbox overlap) is only the GiST prefilter — a curved/L-shaped segment
      // OUTSIDE the region can still have a bounding box that clips the envelope.
      // `ST_Intersects` is the exact test, so a row is a stale candidate only when
      // its geometry genuinely lies in the region.
      `SELECT id, osm_way_id::text AS osm_way_id, segment_index,
              ST_AsGeoJSON(geom)::json AS geom
       FROM ${TABLE}
       WHERE deactivated_at IS NULL
         AND osm_way_id IS NOT NULL
         AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
         AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))`,
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
