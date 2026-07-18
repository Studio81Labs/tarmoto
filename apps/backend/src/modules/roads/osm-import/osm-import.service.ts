import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  roadTileFileName,
  subdivideRegion,
  type PoiImportRegion,
  type RoadTile,
} from '@tarmoto/ingest';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  type OsmWaySource,
  type RoadSegmentRow,
  buildSegmentRows,
} from './segment-rows.js';
import { assembleWays } from './osm-assemble.js';
import { parseOsmXml } from './osm-xml-source.js';
import { osmRoadImportConfig } from './osm-import.config.js';
import { regionPolygon } from './region-polygons.js';
import { planReassignment, type ExistingSegment } from './split-merge.js';
import type { LatLng } from './segmentation.js';

/** Rows per bulk upsert — keeps each statement well under PG's 65,535-param
 *  limit (each row binds ~8 columns). */
const UPSERT_CHUNK = 500;

/** Incoming geometries per region-filter query. A national extract can carry
 *  hundreds of thousands of ways; batching the `unnest … WITH ORDINALITY`
 *  intersect keeps each statement's text-array bind bounded (2 binds/query, so
 *  the param limit is irrelevant — this bounds the array payload size instead). */
const REGION_FILTER_CHUNK = 2000;

/** Zero result — a skipped (absent / empty) region contributes nothing. Frozen:
 *  shared across every skip path, and `importAll` only ever reads its fields
 *  into a fresh accumulator, so a stray in-place mutation would otherwise leak
 *  across calls. */
const EMPTY_RESULT: OsmImportResult = Object.freeze({
  upserted: 0,
  carriedOver: 0,
  deactivated: 0,
});

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
 * The authoritative reconcile scope for ONE tile: the region's country
 * `polygon` (GeoJSON string for `ST_GeomFromGeoJSON`) intersected with the tile's
 * `bbox` (`[minLng, minLat, maxLng, maxLat]` for `ST_MakeEnvelope`). Both the
 * incoming filter ({@link OsmImportService.filterToRegion}) and the existing-row
 * load ({@link OsmImportService.loadExistingInRegion}) apply the IDENTICAL
 * combined test — a row is in-scope iff it intersects BOTH — so a border/tile-seam
 * row is judged the same on both sides (the #1033 invariant, now extended to the
 * tile bbox). Scoping to the polygon ALONE would let a tile's import tombstone the
 * region's roads that live in OTHER tiles; scoping to the bbox ALONE would let a
 * region tombstone a neighbour's roads in the overlapping strip (#1033).
 */
export interface RegionScope {
  polygon: string;
  bbox: [number, number, number, number];
}

/** A tile's `{minLng,minLat,maxLng,maxLat}` bbox as the `[minLng, minLat, maxLng,
 *  maxLat]` tuple the scope + `ST_MakeEnvelope` binds expect. */
function bboxTuple(bbox: RoadTile['bbox']): [number, number, number, number] {
  return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat];
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
 * Split/merge reconciliation (#835, ADR-0006): one tile's snapshot is buffered
 * and matched against the existing rows in its country polygon ∩ tile bbox (the
 * {@link RegionScope}), so a way that was split or merged carries its `id` +
 * history onto the incoming geometry by geometry overlap, and a row nothing
 * matches is tombstoned (`deactivated_at`), never hard-deleted (the history
 * tables FK it). Each region is subdivided into a deterministic tile grid
 * (`subdivideRegion`, shared with the producer) and imported tile-by-tile, so
 * peak memory is bounded to one tile regardless of the country's size.
 */
@Injectable()
export class OsmImportService {
  private readonly logger = new Logger(OsmImportService.name);

  constructor(
    @InjectRepository(RoadSegment)
    private readonly repo: Repository<RoadSegment>,
    @Inject(osmRoadImportConfig.KEY)
    private readonly config: ConfigType<typeof osmRoadImportConfig>,
  ) {}

  /** Whether the scheduled import is turned on (TARMOTO_OSM_ROAD_IMPORT_ENABLED). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Import every configured region's per-tile extracts from `extractDir` in one
   * pass (the folder model, Sub-project B). Each region is subdivided into a tile
   * grid and imported tile-by-tile ({@link importRegion}); results aggregate. A
   * tile whose extract is absent or empty is skipped (never tombstoned — see
   * {@link importTile}), so one missing/broken extract can't wipe a tile or abort
   * the others.
   */
  async importAll(): Promise<OsmImportResult> {
    const { extractDir, regions } = this.config;
    if (!extractDir) {
      throw new Error(
        'OSM import is enabled but TARMOTO_OSM_ROAD_IMPORT_DIR is not set',
      );
    }
    this.logger.log(
      `OSM import: ${regions.length} region(s) from ${extractDir} ` +
        `(tile span ${this.config.tileSpanDeg}°) — ` +
        `${regions.map((r) => r.code).join(', ') || '(none)'}`,
    );
    const total: OsmImportResult = {
      upserted: 0,
      carriedOver: 0,
      deactivated: 0,
    };
    for (const region of regions) {
      const r = await this.importRegion(region, extractDir);
      total.upserted += r.upserted;
      total.carriedOver += r.carriedOver;
      total.deactivated += r.deactivated;
    }
    return total;
  }

  /**
   * Import one region tile-by-tile. The region is subdivided into a deterministic
   * grid of `<= tileSpanDeg` cells ({@link subdivideRegion}, the SAME grid the
   * producer clips), and each tile's `<code>-r<row>c<col>.osm` extract is imported
   * against the country polygon ∩ that tile's bbox ({@link importTile}). Peak
   * memory is therefore bounded to one tile no matter how large the country is —
   * a whole-country buffer could otherwise OOM the import worker. Results
   * aggregate across the region's tiles.
   */
  async importRegion(
    region: PoiImportRegion,
    extractDir: string,
  ): Promise<OsmImportResult> {
    const tiles = subdivideRegion(region, this.config.tileSpanDeg);
    this.logger.log(
      `OSM import (${region.code}): ${tiles.length} tile(s) from ${extractDir}`,
    );
    const total: OsmImportResult = {
      upserted: 0,
      carriedOver: 0,
      deactivated: 0,
    };
    for (const tile of tiles) {
      const r = await this.importTile(region, tile, extractDir);
      total.upserted += r.upserted;
      total.carriedOver += r.carriedOver;
      total.deactivated += r.deactivated;
    }
    return total;
  }

  /**
   * Import one tile's `<extractDir>/<code>-r<row>c<col>.osm`. Three skip paths, all
   * of which return `EMPTY_RESULT` and NEVER tombstone (this intentionally
   * overrides `reconcile`'s authoritative-empty behavior, designed for
   * hand-supplied single-file tiles):
   *  - **Absent file → WARN.** The producer writes a file for every grid cell, so
   *    a missing tile means a partial/failed refresh — worth flagging.
   *  - **Present but 0 ways → LOG (info).** A grid cell entirely outside the
   *    country (sea-only / border cell) is a header-only extract on EVERY weekly
   *    run — expected, not suspicious, so it must not drown the real WARNs.
   *  - **Present with ways but NONE inside the country POLYGON ∩ tile bbox → WARN.**
   *    A mis-produced or misnamed extract (e.g. the wrong tile's data).
   *
   * The tile is scoped by its region's actual country POLYGON (bundled boundary)
   * intersected with the tile bbox — NOT the bbox alone (adjacent countries'
   * rectangles overlap, so a bare-bbox scope would let this region tombstone a
   * neighbour's roads in the shared strip, #1033) and NOT the polygon alone (that
   * would let this tile's import tombstone the region's roads in OTHER tiles). The
   * incoming filter ({@link filterToRegion}) and the existing-row load
   * ({@link loadExistingInRegion}) run the SAME combined PostGIS `ST_Intersects`
   * pair, so a border/tile-seam row is judged identically on both sides.
   */
  async importTile(
    region: PoiImportRegion,
    tile: RoadTile,
    extractDir: string,
  ): Promise<OsmImportResult> {
    const label = `${region.code} r${tile.row}c${tile.col}`;
    const path = join(extractDir, roadTileFileName(tile));
    if (!(await this.fileExists(path))) {
      this.logger.warn(
        `OSM import (${label}): no extract at ${path} — skipping`,
      );
      return EMPTY_RESULT;
    }
    this.logger.log(`OSM import (${label}): reading ${path}`);
    const incoming = await this.bufferRows(
      assembleWays(parseOsmXml(createReadStream(path))),
    );
    if (incoming.length === 0) {
      // Expected for a grid cell outside the country (sea-only / border cell): the
      // producer writes a header-only extract for it every run. Info, not warn, so
      // the genuinely suspicious skips (absent file, out-of-scope) stay visible.
      this.logger.log(
        `OSM import (${label}): extract parsed 0 ways — skipping ` +
          `(empty grid cell; NOT tombstoning the tile)`,
      );
      return EMPTY_RESULT;
    }
    // Scope the incoming set to the country polygon ∩ tile bbox. `osmium extract`
    // ships COMPLETE ways, so a tile extract carries a bit of neighbouring
    // (adjacent-tile / adjacent-country) geometry that must be dropped before
    // reconcile. A present, non-empty extract can also be entirely OUTSIDE the
    // scope — a mis-produced or misnamed extract (e.g. the wrong tile's data).
    // Left unguarded, reconcile would see a post-filter EMPTY set WITH a scope,
    // which it correctly treats as "the cell was cleared" and tombstones every
    // live row in it. Catch that here — before reconcile — so a bad extract skips
    // instead of wiping the cell.
    const scope: RegionScope = {
      polygon: regionPolygon(region.code),
      bbox: bboxTuple(tile.bbox),
    };
    const inScope = await this.filterToRegion(incoming, scope);
    if (inScope.length === 0) {
      this.logger.warn(
        `OSM import (${label}): extract has ${incoming.length} way(s) but none intersect the country polygon ∩ tile bbox — skipping (likely a mis-produced or misnamed extract; NOT tombstoning the tile)`,
      );
      return EMPTY_RESULT;
    }
    return this.reconcile(inScope, scope);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (err) {
      // ENOENT (genuinely absent) is the only case that means "skip this
      // region". Anything else (permission/IO error on the shared volume) is a
      // real failure that must surface — not be silently reported as "absent" —
      // so it can page/alert and let BullMQ retry.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Buffer a way source into reconcilable rows. A parse/read error propagates
   *  before any write, so a failed run can't touch existing rows. */
  private async bufferRows(source: OsmWaySource): Promise<RoadSegmentRow[]> {
    const incoming: RoadSegmentRow[] = [];
    for await (const row of buildSegmentRows(source)) {
      incoming.push(row);
    }
    return incoming;
  }

  /** Import an in-memory way source against an explicit {@link RegionScope} (the
   *  country polygon + tile bbox, or none). The source is assumed already scoped
   *  (as {@link importTile} scopes it via {@link filterToRegion}); reconcile does
   *  not re-filter. The reconcile seam used by unit tests and by
   *  {@link importTile}. */
  async importFrom(
    source: OsmWaySource,
    scope: RegionScope | null = null,
  ): Promise<OsmImportResult> {
    return this.reconcile(await this.bufferRows(source), scope);
  }

  /**
   * Reconcile the incoming snapshot against the existing rows in its scope (#835,
   * ADR-0006). `incoming` is assumed already scoped by the caller
   * ({@link importTile} via {@link filterToRegion}; direct callers pass an
   * already-in-scope set), so reconcile does NOT re-filter — `scope` (the country
   * polygon + tile bbox, or null) is used only to choose the existing-row load
   * and gate stale-by-absence tombstoning. Rows whose stable `(osm_way_id,
   * segment_index)` is unchanged upsert in place (ids preserved, #751); the
   * leftovers on each side are matched by geometry so history follows the road
   * across a split/merge — carry-over as an id-preserving UPDATE, no match as a
   * fresh insert, and an unmatched existing row as a tombstone (`deactivated_at`),
   * never a delete.
   */
  private async reconcile(
    incoming: RoadSegmentRow[],
    scope: RegionScope | null,
  ): Promise<OsmImportResult> {
    // With a configured scope an EMPTY tile is still authoritative — every road in
    // it was removed / reclassified non-drivable, so its existing rows must be
    // tombstoned. Only short-circuit the no-scope case (nothing to compare, and we
    // never tombstone without a scope). A parse error would have thrown before
    // reaching here, so an empty snapshot here is a genuine empty cell.
    if (incoming.length === 0 && !scope) {
      this.logger.log('OSM import: empty snapshot, no scope — nothing to do');
      return { upserted: 0, carriedOver: 0, deactivated: 0 };
    }

    // Stale detection is only sound over an EXPLICIT scope (the extract's
    // authoritative boundary — the country polygon ∩ tile bbox): a data-derived
    // bbox (the extent of the incoming roads) would tombstone existing rows that
    // fall in the rectangle but outside this extract, and miss removed roads
    // beyond the current extrema.
    // With a scope we load every existing row inside the POLYGON ∩ tile bbox (so
    // edge-removed roads in this cell are candidates, while neighbouring countries'
    // roads in the overlapping bbox strip — #1033 — and this region's roads in
    // OTHER tiles are NOT) and may tombstone; without one we load only the incoming
    // extent for carry-over matching and never tombstone.
    const existing = scope
      ? await this.loadExistingInRegion(scope)
      : await this.loadExistingInBbox(this.dataBbox(incoming));
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
    // the existing-row load skips NULL osm ids, so no later region could ever
    // reconcile it and it would linger live as a phantom crowd row. Two sources:
    //  - in-scope stale rows whose key the snapshot reassigned (always, even with
    //    no region — this is key reuse, not stale-by-absence);
    //  - out-of-scope LIVE owners of a claimed key: the ON CONFLICT arbiter is
    //    global but `existingByKey` is region-scoped, so a key owned by a live row
    //    just outside this region (a segment split/moved across the boundary) would
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
    // Tombstone: stale-by-absence (scope only) + reused-key holders (always).
    const deactivateIds = [
      ...new Set([
        ...(scope ? plan.stale : []),
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

    const byAbsenceSkipped = scope
      ? 0
      : plan.stale.length - inBboxReusedIds.length;
    this.logger.log(
      `OSM import: upserted ${upsertRows.length}, carried over ` +
        `${plan.carryOver.length}, deactivated ${deactivateIds.length} ` +
        `(${existing.length} existing / ${incoming.length} incoming; ` +
        `scope ${scope ? 'configured' : 'UNSET → ' + byAbsenceSkipped + ' by-absence rows left active'})`,
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

  /**
   * Existing ACTIVE, OSM-imported rows whose geometry intersects BOTH the region
   * POLYGON and the tile bbox (the {@link RegionScope}) — the reassignment
   * candidate pool for a configured tile. Applies the SAME combined
   * `ST_Intersects(geom, ST_GeomFromGeoJSON())` + `ST_Intersects(geom,
   * ST_MakeEnvelope())` test as {@link filterToRegion}, so a border/tile-seam row
   * is loaded here iff the incoming filter would keep it — the reconcile invariant
   * that stops a kept-incoming row's owner from being tombstoned (#1033, now
   * extended to the tile bbox). Crowd-sourced rows (null `osm_way_id`) are
   * excluded: they aren't part of the OSM network, so the importer never
   * reassigns or tombstones them.
   */
  private async loadExistingInRegion(scope: RegionScope): Promise<
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
      // The two `&&` (bbox-overlap) clauses are only the GiST prefilter; the two
      // `ST_Intersects` are the exact test — a row is a stale candidate only when
      // its geometry genuinely lies inside the country polygon (not merely its
      // bounding rectangle, which overlaps neighbouring countries, #1033) AND
      // inside this tile's bbox (not the region's other tiles). Kept byte-for-byte
      // parallel with `filterToRegion` so both sides judge a seam row identically.
      `SELECT id, osm_way_id::text AS osm_way_id, segment_index,
              ST_AsGeoJSON(geom)::json AS geom
       FROM ${TABLE}
       WHERE deactivated_at IS NULL
         AND osm_way_id IS NOT NULL
         AND geom && ST_GeomFromGeoJSON($1)
         AND ST_Intersects(geom, ST_GeomFromGeoJSON($1))
         AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
         AND ST_Intersects(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
      [scope.polygon, ...scope.bbox],
    );
    return rows.map((r) => ({
      id: r.id,
      osm_way_id: r.osm_way_id,
      segment_index: r.segment_index,
      coords: this.toLatLngs(r.geom),
    }));
  }

  /**
   * The subset of `rows` whose geometry intersects BOTH the region POLYGON and the
   * tile bbox (the {@link RegionScope}) — the incoming-side counterpart of
   * {@link loadExistingInRegion}, running the SAME combined PostGIS `ST_Intersects`
   * pair (NOT a JS approximation, which would disagree at the border and
   * reintroduce id loss, #1033). A national extract can carry hundreds of
   * thousands of ways, so the intersect is batched ({@link REGION_FILTER_CHUNK}
   * geometries/query) and the 1-based `WITH ORDINALITY` positions are mapped back
   * to the chunk's rows.
   */
  private async filterToRegion(
    rows: RoadSegmentRow[],
    scope: RegionScope,
  ): Promise<RoadSegmentRow[]> {
    if (rows.length === 0) return [];
    const kept: RoadSegmentRow[] = [];
    for (let start = 0; start < rows.length; start += REGION_FILTER_CHUNK) {
      const chunk = rows.slice(start, start + REGION_FILTER_CHUNK);
      // Annotate the binding (not an `as` cast) so `o` is typed under both the
      // local and strict OpenAPI-gen tsconfigs.
      const ords: Array<{ ord: number }> = await this.repo.query(
        // The SAME combined test as loadExistingInRegion: a row is kept iff it
        // intersects the country polygon AND the tile envelope — kept byte-for-byte
        // parallel so a seam row is judged identically on both sides (#1033).
        `SELECT g.ord::int AS ord
         FROM unnest($1::text[]) WITH ORDINALITY AS g(gj, ord)
         WHERE ST_Intersects(ST_GeomFromGeoJSON(g.gj), ST_GeomFromGeoJSON($2))
           AND ST_Intersects(ST_GeomFromGeoJSON(g.gj), ST_MakeEnvelope($3, $4, $5, $6, 4326))`,
        [
          chunk.map((r) => JSON.stringify(r.geom)),
          scope.polygon,
          ...scope.bbox,
        ],
      );
      for (const o of ords) {
        // `ord` is 1-based over the chunk.
        kept.push(chunk[o.ord - 1]!);
      }
    }
    return kept;
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
