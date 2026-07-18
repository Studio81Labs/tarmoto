import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  roadTileFileName,
  type PoiImportRegion,
  type RoadTile,
} from '@tarmoto/ingest';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  OsmImportService,
  ROAD_SEGMENT_ON_CONFLICT,
  type RegionScope,
} from './osm-import.service.js';
import { osmRoadImportConfig } from './osm-import.config.js';
import { regionPolygon } from './region-polygons.js';
import type { OsmWay, RoadSegmentRow } from './segment-rows.js';

/** A single ~100 m drivable way (two nodes → one segment). */
function straightWay(id: number): OsmWay {
  return {
    id,
    tags: { highway: 'residential' },
    // ~0.0009° lat ≈ 100 m → one ~100 m segment.
    coords: [
      { lat: 0, lng: 0 },
      { lat: 0.0009, lng: 0 },
    ],
  };
}

/** A rectangle region as a GeoJSON Polygon string — the polygon half of a
 *  {@link RegionScope} (for `ST_GeomFromGeoJSON`). The exact coordinates are
 *  opaque to these unit tests (the geometry queries are mocked); only
 *  scope-set-vs-null and the value passed to the load matter. */
function poly(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): string {
  return JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  });
}

/** A {@link RegionScope} covering the rectangle — the country polygon + the
 *  enclosing tile bbox tuple. `reconcile`/`importFrom` now take this scope (both
 *  the polygon AND the tile bbox), not a bare polygon string (#1033 + tiling).
 *  The bbox is opaque to the mocked geometry queries; it only has to be present
 *  and to travel through to the load's `ST_MakeEnvelope` binds. */
function scope(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): RegionScope {
  return {
    polygon: poly(minLng, minLat, maxLng, maxLat),
    bbox: [minLng, minLat, maxLng, maxLat],
  };
}

/** A drivable ~100 m N–S way at latitude `lat` (longitude fixed at 0). Distinct
 *  `lat`s are far enough apart that the reassignment matcher never carries one
 *  over another; a longitude offset would shrink with cos(lat) and segment into
 *  several rows, so the offset is on latitude. */
function wayAtLat(id: number, lat: number): OsmWay {
  return {
    id,
    tags: { highway: 'residential' },
    coords: [
      { lat, lng: 0 },
      { lat: lat + 0.0009, lng: 0 },
    ],
  };
}

/** An existing row shaped like `loadExistingInRegion`'s raw query result (the
 *  service maps `geom` → `coords`). `coords` are `[lng, lat]` pairs. */
function existingRow(
  id: string,
  osmWayId: string,
  segmentIndex: number,
  coords: Array<[number, number]>, // [lng, lat]
) {
  return {
    id,
    osm_way_id: osmWayId,
    segment_index: segmentIndex,
    geom: { type: 'LineString', coordinates: coords },
  };
}

/** An existing ~100 m N–S row at latitude `lat`, key `(wayId, 0)` — the
 *  existing-side counterpart of {@link wayAtLat}, so a matching pair is judged
 *  "unchanged" and distinct `lat`s never carry over onto each other. */
function existingAtLat(id: string, wayId: string, lat: number) {
  return existingRow(id, wayId, 0, [
    [0, lat],
    [0, lat + 0.0009],
  ]);
}

describe('ROAD_SEGMENT_ON_CONFLICT clause', () => {
  it('targets the (osm_way_id, segment_index) identity', () => {
    // Partial-index arbiter: the conflict target carries the live-row predicate.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '( "osm_way_id", "segment_index" ) WHERE "deactivated_at" IS NULL DO UPDATE SET',
    );
  });

  it('refreshes the OSM-owned columns from EXCLUDED', () => {
    for (const col of [
      'geom',
      'length_m',
      'curviness_score',
      'road_name',
      'road_number',
    ]) {
      expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
        `"${col}" = EXCLUDED."${col}"`,
      );
    }
  });

  it('refreshes surface_type only while OSM still owns it (durable flag)', () => {
    // Gated on the durable surface_from_reading flag (#796), NOT the raw
    // surface_readings (which the retention sweep deletes) — so a rider-classified
    // surface is preserved even after the sweep, while an unclassified seed
    // refreshes on the OSM cycle.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"surface_type" = CASE WHEN NOT "road_segments"."surface_from_reading" ' +
        'THEN EXCLUDED."surface_type" ELSE "road_segments"."surface_type" END',
    );
    // Surface ownership is never inferred from the raw surface_readings table
    // (reading_count legitimately appears below, as the quality_score gate).
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain('surface_readings');
  });

  it('refreshes the OSM quality seed + source every import, and seeds quality_score only for rider-less segments', () => {
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"osm_quality_seed" = EXCLUDED."osm_quality_seed"',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"quality_source" = EXCLUDED."quality_source"',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"quality_score" = CASE WHEN "road_segments"."reading_count" = 0 ' +
        'THEN EXCLUDED."osm_quality_seed" ELSE "road_segments"."quality_score" END',
    );
    // A changed seed on a rider-less segment must trigger the update.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '("road_segments"."reading_count" = 0 AND ' +
        '"road_segments"."quality_score" IS DISTINCT FROM EXCLUDED."osm_quality_seed")',
    );
  });

  it('nulls the geometry-derived elevation columns when geometry changes', () => {
    for (const col of ['elevation_min', 'elevation_max', 'elevation_profile']) {
      expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
        `"${col}" = CASE WHEN NOT ST_OrderingEquals("road_segments"."geom", ` +
          `EXCLUDED."geom") THEN NULL ELSE "road_segments"."${col}" END`,
      );
    }
  });

  it('detects geometry changes at the vertex level (not bbox)', () => {
    // ST_OrderingEquals compares the exact coordinate sequence, so a same-bbox
    // reshape is still caught — the `=` / IS DISTINCT FROM operator would not.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      'NOT ST_OrderingEquals("road_segments"."geom", EXCLUDED."geom")',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(
      '"road_segments"."geom" IS DISTINCT FROM',
    );
  });

  it('never writes the crowdsourced / identity / provenance columns', () => {
    // surface_from_reading is aggregation-owned; the importer only reads it.
    // quality_score is CASE-gated (see test above); surface_type is similarly gated.
    for (const col of [
      'confidence',
      'reading_count',
      'id',
      'surface_from_reading',
    ]) {
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(`"${col}" = EXCLUDED`);
      expect(ROAD_SEGMENT_ON_CONFLICT).not.toContain(
        `"${col}" = "road_segments"`,
      );
    }
  });

  it('skips no-op rows via a change guard (WHERE over geom + OSM + surface)', () => {
    // The guard leads with the vertex-level geometry check…
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      'WHERE NOT ST_OrderingEquals("road_segments"."geom", EXCLUDED."geom")',
    );
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '"road_segments"."road_name" IS DISTINCT FROM EXCLUDED."road_name"',
    );
    // …and updates an unclassified segment whose only change is the surface seed.
    expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
      '(NOT "road_segments"."surface_from_reading" AND ' +
        '"road_segments"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")',
    );
  });
});

describe('OsmImportService', () => {
  let service: OsmImportService;
  let qb: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    onConflict: jest.Mock;
    execute: jest.Mock;
  };
  let createQueryBuilder: jest.Mock;
  let loadExisting: jest.Mock;
  let filterRegion: jest.Mock;
  let managerQuery: jest.Mock;
  let managerTransaction: jest.Mock;
  let osmConfig: {
    enabled: boolean;
    extractDir: string | null;
    regions: PoiImportRegion[];
    tileSpanDeg: number;
  };

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  beforeEach(async () => {
    // `tileSpanDeg` large by default so a single-region test region → one 1×1
    // tile (r0c0); the multi-tile `importRegion` test overrides it.
    osmConfig = {
      enabled: false,
      extractDir: null,
      regions: [],
      tileSpanDeg: 100,
    };
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    createQueryBuilder = jest.fn().mockReturnValue(qb);
    // `loadExistingInRegion` / `loadExistingInBbox` / `loadOutOfBboxKeyOwners` —
    // no existing rows by default, so every incoming segment is a fresh insert (no
    // carry-over / stale). The transaction runs the callback against a manager
    // whose insert builder is the shared `qb`.
    loadExisting = jest.fn().mockResolvedValue([]);
    // `filterToRegion`'s `unnest … WITH ORDINALITY` query — default: every incoming
    // row is in-region (return its 1-based ordinal). Tests override for the
    // out-of-region case (return no ordinals → nothing in region).
    filterRegion = jest.fn((_sql: string, params: unknown[]) =>
      Promise.resolve((params[0] as string[]).map((_g, i) => ({ ord: i + 1 }))),
    );
    // Reads AND writes now run on the transaction's EntityManager (the region tx
    // when importRegion drives, else the reconcile dispatcher's own) — never on
    // `repo` directly — so ONE mock manager serves as both `repo.manager` (a direct
    // importTile's filter reads on it; the dispatcher opens `.transaction` on it)
    // AND the manager handed to every transaction callback. Its `query` dispatches
    // by SQL:
    //  - the incoming filter (`unnest … WITH ORDINALITY`, the only one carrying it),
    //  - the ordered writes (any `UPDATE …` — rows-affected is unused → undefined),
    //  - the existing-row + out-of-bbox owner loads (the remaining SELECTs, driven
    //    by `loadExisting`'s call order).
    // The filter + the loads BOTH reference `ST_MakeEnvelope` now (the tile-bbox
    // half of the scope), so `WITH ORDINALITY` / the `UPDATE` prefix — not
    // `ST_MakeEnvelope` — is what separates the three.
    managerQuery = jest.fn((sql: string, params: unknown[]): unknown => {
      if (sql.includes('WITH ORDINALITY')) {
        return filterRegion(sql, params) as unknown;
      }
      if (sql.trimStart().toUpperCase().startsWith('UPDATE')) return undefined;
      return loadExisting(sql, params) as unknown;
    });
    const manager: {
      createQueryBuilder: jest.Mock;
      query: jest.Mock;
      transaction: jest.Mock;
    } = { createQueryBuilder, query: managerQuery, transaction: jest.fn() };
    // Run the callback against the SAME manager (so its reads/writes reach
    // `managerQuery` + `qb`), mirroring a real `EntityManager.transaction`. Both
    // importRegion's per-region tx and the dispatcher's direct tx resolve here, so
    // a rejecting callback rejects the returned promise — the atomic-region test
    // asserts exactly ONE such tx wraps every tile.
    manager.transaction.mockImplementation(
      (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
    );
    managerTransaction = manager.transaction;
    const repo = { manager } as unknown as Repository<RoadSegment>;
    const moduleRef = await Test.createTestingModule({
      providers: [
        OsmImportService,
        {
          provide: getRepositoryToken(RoadSegment),
          useValue: repo,
        },
        {
          provide: osmRoadImportConfig.KEY,
          useValue: osmConfig,
        },
      ],
    }).compile();
    service = moduleRef.get(OsmImportService);
  });

  it('upserts with the road-segment conflict clause', async () => {
    const result = await service.importFrom([straightWay(1), straightWay(2)]);

    expect(result.upserted).toBe(2);
    expect(qb.execute).toHaveBeenCalledTimes(1);
    expect(qb.onConflict).toHaveBeenCalledWith(ROAD_SEGMENT_ON_CONFLICT);
    const rows = valuesOnCall(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      osm_way_id: '1',
      segment_index: 0,
      geom: { type: 'LineString' },
    });
  });

  it('never carries the rider-derived columns in the inserted rows', async () => {
    await service.importFrom([straightWay(1)]);

    for (const row of valuesOnCall(0)) {
      // Absent from the row → defaulted on insert, untouched on update.
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('reading_count');
    }
    // …but the OSM surface + quality seed ARE present (inserted for new
    // segments; refreshed every import while the segment stays rider-less).
    expect(valuesOnCall(0)[0]).toHaveProperty('surface_type');
    expect(valuesOnCall(0)[0]).toHaveProperty('osm_quality_seed');
    expect(valuesOnCall(0)[0]).toHaveProperty('quality_source');
    expect(valuesOnCall(0)[0]).toHaveProperty('quality_score');
  });

  it('skips non-drivable ways (no statement for them)', async () => {
    const footpath: OsmWay = {
      id: 9,
      tags: { highway: 'footway' },
      coords: [
        { lat: 0, lng: 0 },
        { lat: 0.0009, lng: 0 },
      ],
    };
    const result = await service.importFrom([footpath]);

    expect(result.upserted).toBe(0);
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('chunks large imports into multiple bounded statements', async () => {
    const ways = Array.from({ length: 1100 }, (_, i) => straightWay(i + 1));

    const result = await service.importFrom(ways);

    expect(result.upserted).toBe(1100);
    // 1100 rows / 500-row chunks → 3 statements (500 + 500 + 100).
    expect(qb.execute).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((n) => valuesOnCall(n).length)).toEqual([
      500, 500, 100,
    ]);
  });

  it('consumes an async source (the streaming PBF parser shape)', async () => {
    async function* source(): AsyncGenerator<OsmWay> {
      await Promise.resolve(); // emulate the streaming parser's async boundary
      yield straightWay(1);
      yield straightWay(2);
    }

    const result = await service.importFrom(source());

    expect(result.upserted).toBe(2);
    expect(qb.execute).toHaveBeenCalledTimes(1);
  });

  describe('split/merge reconciliation (#835)', () => {
    it('carries an existing id onto a re-keyed incoming segment (same geometry)', async () => {
      // The way's id changed (1 → 2) but the geometry is identical, so the old
      // row's id + history must follow it rather than being inserted fresh.
      loadExisting.mockResolvedValueOnce([
        existingRow('old-uuid', '1', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
      ]);

      const result = await service.importFrom([straightWay(2)]);

      expect(result).toMatchObject({
        upserted: 0,
        carriedOver: 1,
        deactivated: 0,
      });
      // Carry-over is an id-preserving UPDATE (that also revives + re-keys) — find
      // it among the transaction's statements (a free-key null precedes it).
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry).toBeDefined();
      expect(carry![0]).toContain('UPDATE road_segments SET');
      expect(carry![1][0]).toBe('2'); // new osm_way_id
      expect(carry![1][8]).toBe('old-uuid'); // WHERE id
      // The target's old key is freed first so the re-key can't hit the index.
      const freeKey = calls.find(([sql]) =>
        sql.includes('osm_way_id = NULL, segment_index = NULL'),
      );
      expect(freeKey).toBeDefined();
      expect(freeKey![1]).toEqual([['old-uuid']]);
      // Nothing inserted for the carried segment.
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('does NOT upsert onto a reused (osm_way_id, segment_index) that is a different road', async () => {
      // A split kept way 100 on the DOWNSTREAM piece: old 100/0 = upstream, new
      // 100/0 = downstream. A straight key-match upsert would move the upstream
      // row's history onto the downstream geometry. With a region, the key match is
      // routed to geometry reassignment instead: the downstream row carries the
      // key, the upstream row is tombstoned.
      loadExisting.mockResolvedValueOnce([
        existingRow('upstream', '100', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
        existingRow('downstream', '100', 1, [
          [0, 0.0009],
          [0, 0.0018],
        ]),
      ]);
      // Incoming way 100 is now the downstream ~100 m (its segment 0 == downstream).
      const incomingDownstream: OsmWay = {
        id: 100,
        tags: { highway: 'residential' },
        coords: [
          { lat: 0.0009, lng: 0 },
          { lat: 0.0018, lng: 0 },
        ],
      };

      const result = await service.importFrom(
        [incomingDownstream],
        scope(-1, -1, 20, 20),
      );

      expect(result).toMatchObject({ carriedOver: 1, deactivated: 1 });
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      // The DOWNSTREAM row carries the reused key (100, 0) — not the upstream row.
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry![1][1]).toBe(0); // segment_index
      expect(carry![1][8]).toBe('downstream'); // WHERE id
      // The old upstream row (which shared the key) is tombstoned, not overwritten.
      const deactivate = calls.find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );
      expect(deactivate![1]).toEqual([['upstream']]);
    });

    it('checks reused keys even without a region (vacates, does not overwrite)', async () => {
      // No region: the geometry check still runs, so a reused key (old 100/0 =
      // upstream, incoming 100/0 = downstream) is NOT straight-upserted onto the
      // upstream row. Downstream carries the key; the upstream keeps living but its
      // now-reused identity is nulled (we don't tombstone by absence without a
      // region).
      loadExisting.mockResolvedValueOnce([
        existingRow('upstream', '100', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
        existingRow('downstream', '100', 1, [
          [0, 0.0009],
          [0, 0.0018],
        ]),
      ]);
      const incomingDownstream: OsmWay = {
        id: 100,
        tags: { highway: 'residential' },
        coords: [
          { lat: 0.0009, lng: 0 },
          { lat: 0.0018, lng: 0 },
        ],
      };

      const result = await service.importFrom([incomingDownstream]);

      expect(result).toMatchObject({ carriedOver: 1, deactivated: 1 });
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      // Downstream carries the reused key; upstream is not overwritten.
      const carry = calls.find(([sql]) =>
        sql.includes('deactivated_at = NULL'),
      );
      expect(carry![1][8]).toBe('downstream');
      // The old upstream holder is tombstoned (history survives), not orphaned.
      const deactivate = calls.find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );
      expect(deactivate![1]).toEqual([['upstream']]);
      // Only the carry-over target's identity is nulled (it's re-keyed next).
      const free = calls.find(([sql]) =>
        sql.includes('osm_way_id = NULL, segment_index = NULL'),
      );
      expect(free![1]).toEqual([['downstream']]);
    });

    it('tombstones an out-of-bbox live owner of a claimed key before upserting', async () => {
      // The global ON CONFLICT arbiter can match a live row OUTSIDE this tile that
      // owns the incoming key (a segment split across the boundary). It isn't in the
      // bbox load, so the upsert would overwrite it in place. It is tombstoned (not
      // identity-nulled, which would orphan it) so the incoming inserts fresh.
      // call 1: loadExistingInBbox → none in-bbox; call 2: loadOutOfBboxKeyOwners
      // → an out-of-tile live row owns the incoming key.
      loadExisting
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'out-of-tile' }]);

      const result = await service.importFrom(
        [straightWay(1)],
        scope(-1, -1, 1, 1),
      );

      expect(result).toMatchObject({
        upserted: 1,
        carriedOver: 0,
        deactivated: 1,
      });
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate).toBeDefined();
      expect(deactivate![1]).toEqual([['out-of-tile']]);
      // The incoming inserts fresh (its own key is now free).
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('tombstones every existing row when a small configured region imports empty (below the guard floor)', async () => {
      // A configured region that imports to ZERO in-scope rows is authoritative —
      // its rows are deactivated. With a single in-scope row the tile is below the
      // wipe-guard's row floor (MIN_ROWS_FOR_TOMBSTONE_GUARD), so the removal
      // propagates freely (a sparse tile's small blast radius is never withheld);
      // the ≥50-row authoritative-empty WITHHOLD is covered in the guard describe.
      loadExisting.mockResolvedValueOnce([
        existingRow('cleared', '7', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
      ]);

      const result = await service.importFrom([], scope(-1, -1, 20, 20));

      expect(result.deactivated).toBe(1);
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate![1]).toEqual([['cleared']]);
    });

    it('tombstones an existing row nothing matches — only with an explicit region', async () => {
      // Stale detection is region-authoritative: with a scope an unmatched row is
      // tombstoned. A single sub-floor row propagates freely (the wipe-guard only
      // arms at MIN_ROWS_FOR_TOMBSTONE_GUARD in-scope rows). The absent row lives far
      // from the incoming way → no match.
      loadExisting.mockResolvedValueOnce([
        existingRow('gone-uuid', '5', 0, [
          [10, 10],
          [10, 10.0009],
        ]),
      ]);

      const result = await service.importFrom(
        [straightWay(2)],
        scope(-1, -1, 20, 20),
      );

      expect(result).toMatchObject({
        upserted: 1, // the incoming way inserted fresh
        carriedOver: 0,
        deactivated: 1,
      });
      // A deactivate UPDATE bounded to the stale id — never a DELETE.
      const calls = managerQuery.mock.calls as Array<[string, unknown[]]>;
      const deactivate = calls.find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );
      expect(deactivate).toBeDefined();
      expect(deactivate![1]).toEqual([['gone-uuid']]);
      expect(deactivate![0]).not.toMatch(/DELETE/i);
    });

    it('does NOT re-filter incoming — the caller pre-scopes to the region (importRegion → filterToRegion)', async () => {
      // reconcile now assumes `incoming` is already region-scoped, so it never
      // drops rows by geometry itself: scoping is done once, in the DB, by
      // importRegion's filterToRegion (whose PostGIS test matches the existing-row
      // load exactly — the #1033 invariant). This guards against re-introducing a
      // JS incoming filter, whose polygon test could diverge from the SQL load and
      // tombstone a kept-incoming row's owner. straightWay sits at (0,0), well
      // outside the region polygon, yet is still reconciled + inserted.
      const result = await service.importFrom(
        [straightWay(1)],
        scope(100, 100, 101, 101),
      );

      expect(result.upserted).toBe(1);
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // importFrom does not filter — only importRegion runs filterToRegion.
      expect(filterRegion).not.toHaveBeenCalled();
    });

    it('does NOT tombstone when no region is configured (data bbox is not authoritative)', async () => {
      // Without an explicit region a data-derived bbox can't distinguish "removed"
      // from "outside this extract", so an unmatched row is left active.
      loadExisting.mockResolvedValueOnce([
        existingRow('outside-uuid', '5', 0, [
          [10, 10],
          [10, 10.0009],
        ]),
      ]);

      const result = await service.importFrom([straightWay(2)]);

      expect(result.deactivated).toBe(0);
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate).toBeUndefined();
    });
  });

  describe('stale-by-absence tombstone-fraction guard (authoritative empty)', () => {
    // `n` in-scope existing rows at distinct latitudes (far enough apart that the
    // reassignment matcher never carries one over another), keys
    // (1000,0)…(1000+n-1,0).
    const manyExisting = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        existingAtLat(`e${i}`, String(1000 + i), i),
      );

    /** The tombstone UPDATE among the transaction's statements, if any. */
    const deactivateCall = () =>
      (managerQuery.mock.calls as Array<[string, unknown[]]>).find(([sql]) =>
        sql.includes('deactivated_at = NOW()'),
      );

    it('propagates a sub-floor removal even above 50% (a sparse tile is never withheld)', async () => {
      // 3 in-scope rows, incoming keeps 1 → 2 absent (67% > 50%), but the tile is
      // below the wipe-guard's row floor (MIN_ROWS_FOR_TOMBSTONE_GUARD = 50), so the
      // removal PROPAGATES — a sparse tile's small blast radius is never withheld
      // (else a correct-but-small extract would withhold + warn every run forever).
      loadExisting.mockResolvedValueOnce(manyExisting(3));

      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importFrom(
        [wayAtLat(1000, 0)],
        scope(-1, -1, 20, 20),
      );

      expect(result).toMatchObject({
        upserted: 1,
        carriedOver: 0,
        deactivated: 2,
      });
      expect(warn).not.toHaveBeenCalled();
      // Both absent rows (e1, e2) tombstoned — never the kept e0.
      const deactivate = deactivateCall();
      expect(deactivate).toBeDefined();
      expect(new Set(deactivate![1][0] as string[])).toEqual(
        new Set(['e1', 'e2']),
      );
    });

    it('propagates a partial (<50%) removal on a dense (≥50-row) tile', async () => {
      // 60 in-scope rows (above the floor); incoming re-sends 40 unchanged → the
      // other 20 (33% < 50%) are genuinely absent and tombstoned. Below the fraction,
      // so a real deletion still propagates rather than being withheld.
      loadExisting.mockResolvedValueOnce(manyExisting(60));
      const incoming = Array.from({ length: 40 }, (_, i) =>
        wayAtLat(1000 + i, i),
      );

      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importFrom(incoming, scope(-1, -1, 20, 20));

      expect(result).toMatchObject({
        upserted: 40,
        carriedOver: 0,
        deactivated: 20,
      });
      expect(warn).not.toHaveBeenCalled();
      // The 20 absent rows (e40…e59) are tombstoned — never a kept row (e0…e39).
      const deactivate = deactivateCall();
      expect(deactivate).toBeDefined();
      const ids = deactivate![1][0] as string[];
      expect(ids).toHaveLength(20);
      expect(ids).not.toContain('e0');
    });

    it('withholds a mass (>50%) wipe on a dense tile (warn) but still applies the definitive reused-key tombstone', async () => {
      // 60 in-scope rows (above the floor). Incoming keeps e0 unchanged and re-keys
      // e1's identity (1001,0) onto a DIFFERENT road (empty lat 80, no overlap) → e1
      // is a definitive reused-key tombstone. The remaining 58 (e2…e59) are pure
      // stale-by-absence (≈97% > 50%), an implausible mass wipe that must be WITHHELD
      // (rows kept live + warn), while the reused-key tombstone + upserts still apply.
      loadExisting.mockResolvedValueOnce(manyExisting(60));
      const incoming = [
        wayAtLat(1000, 0), // e0 unchanged
        wayAtLat(1001, 80), // reuses e1's key on a different road (empty latitude)
      ];

      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importFrom(incoming, scope(-1, -1, 20, 20));

      // e0 upserts unchanged, the re-keyed road inserts fresh (2 upserts); only the
      // definitive reused-key row is deactivated — the 58 by-absence rows withheld.
      expect(result).toMatchObject({
        upserted: 2,
        carriedOver: 0,
        deactivated: 1,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('withheld 58/60 stale-by-absence'),
      );
      const deactivate = deactivateCall();
      expect(deactivate).toBeDefined();
      expect(deactivate![1]).toEqual([['e1']]); // ONLY the reused-key row
      expect(qb.execute).toHaveBeenCalledTimes(1); // incoming still upserted
    });

    it('withholds an authoritative-empty wipe on a dense tile: importFrom([], scope) keeps all rows live + warns', async () => {
      // 60 in-scope rows (above the floor); a present tile that reconciles to zero
      // in-scope rows would tombstone 100% of the cell — the guard withholds it
      // entirely (keeps every row live + warn) rather than deactivating a whole tile
      // off one possibly-mis-produced extract.
      loadExisting.mockResolvedValueOnce(manyExisting(60));

      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importFrom([], scope(-1, -1, 20, 20));

      expect(result).toMatchObject({
        upserted: 0,
        carriedOver: 0,
        deactivated: 0,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('withheld 60/60 stale-by-absence'),
      );
      // deactivateIds is empty → the tombstone UPDATE is skipped entirely.
      expect(deactivateCall()).toBeUndefined();
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('no-ops an empty sea cell (0 existing, empty incoming) without warning', async () => {
      // The guard is gated on the in-scope existing rows (both the row floor and the
      // fraction), so a genuinely empty cell (no roads on either side) is a harmless
      // no-op — NOT a false mass-wipe warning.
      loadExisting.mockResolvedValueOnce([]); // no existing rows in scope

      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importFrom([], scope(-1, -1, 20, 20));

      expect(result).toMatchObject({
        upserted: 0,
        carriedOver: 0,
        deactivated: 0,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(deactivateCall()).toBeUndefined();
    });
  });

  it('reflects the enabled flag', () => {
    expect(service.enabled).toBe(false);
    osmConfig.enabled = true;
    expect(service.enabled).toBe(true);
  });

  // A minimal valid <osm> XML extract with one drivable way, at `(lat, lng)`
  // (default 50.0N, 14.0E — inside the CZ test region below). The second node
  // offsets LATITUDE by ~0.0009° (matching `straightWay` above) for a single
  // ~100 m segment — longitude degrees shrink with cos(lat), so the same delta
  // there would span several hundred metres and segmentation would cut it into
  // multiple ~100 m rows. The default covers every CZ-only call site verbatim;
  // `importAll`'s cross-region test overrides the coordinates for its second
  // (SK) region so the way falls inside SK rather than colliding with CZ.
  function wayXml(id: number, lat = 50.0, lng = 14.0): string {
    return (
      `<osm version="0.6">` +
      `<node id="${id}0" lat="${lat}" lon="${lng}"/>` +
      `<node id="${id}1" lat="${lat + 0.0009}" lon="${lng}"/>` +
      `<way id="${id}"><nd ref="${id}0"/><nd ref="${id}1"/>` +
      `<tag k="highway" v="residential"/></way></osm>`
    );
  }

  const CZ: PoiImportRegion = {
    code: 'CZ',
    bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
  };
  // A single 1×1 tile equal to the CZ bbox (what `subdivideRegion(CZ, span≥6.77)`
  // yields) — file `roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)`. Its bbox
  // travels into the scope's `ST_MakeEnvelope` binds.
  const CZ_TILE: RoadTile = { code: 'CZ', row: 0, col: 0, bbox: CZ.bbox };
  // A second CZ tile (col 1) — used by the multi-tile `importRegion` tests below.
  const CZ_TILE_R0C1: RoadTile = { code: 'CZ', row: 0, col: 1, bbox: CZ.bbox };
  const SK_TILE: RoadTile = {
    code: 'SK',
    row: 0,
    col: 0,
    bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
  };

  describe('importTile', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'road-import-tile-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('skips a tile whose extract file is absent (no tombstone)', async () => {
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importTile(CZ, CZ_TILE, dir);
      expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
      // reconcile never ran → no load/transaction
      expect(loadExisting).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('reconciles a present-but-empty tile at info (no existing rows → harmless no-op, no warn)', async () => {
      // A present 0-way extract is AUTHORITATIVE (the producer's refresh is atomic
      // keep-last-good — it never writes an empty file on failure), so it now
      // REACHES reconcile instead of being pre-empted. With no existing in-scope
      // rows it's a harmless no-op: an info log (empty cell is expected), never a
      // warn, and reconcile ran (the existing-row load WAS issued).
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        '<osm version="0.6"></osm>',
      );
      loadExisting.mockResolvedValue([]); // empty sea/border cell
      const warn = jest.spyOn(service['logger'], 'warn');
      const log = jest.spyOn(service['logger'], 'log');
      const result = await service.importTile(CZ, CZ_TILE, dir);
      expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
      expect(loadExisting).toHaveBeenCalled(); // reconcile RAN (not skipped)
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('reconciling authoritatively'),
      );
    });

    it('reaches reconcile for a present-but-empty tile WITH existing rows and tombstones the now-absent row (sub-floor)', async () => {
      // The behavior Change 1 unlocks: a present 0-way tile whose cell still holds a
      // live row is no longer skipped — it reconciles, and the row (now absent from
      // the authoritative extract) is tombstoned so the removal propagates. This
      // single-row cell is below the wipe-guard's row floor, so it deactivates freely
      // (no warn); the ≥50-row withhold is covered in the guard describe.
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        '<osm version="0.6"></osm>',
      );
      loadExisting.mockResolvedValueOnce([
        existingRow('live', '7', 0, [
          [14, 50],
          [14, 50.0009],
        ]),
      ]);
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importTile(CZ, CZ_TILE, dir);
      expect(loadExisting).toHaveBeenCalled(); // reconcile RAN (not skipped)
      expect(result.deactivated).toBe(1); // the now-absent row propagates
      expect(warn).not.toHaveBeenCalled(); // below the floor → no withhold warn
    });

    it('reconciles a present tile whose ways are all out-of-scope authoritatively (reaches reconcile)', async () => {
      // A present, non-empty extract whose ways ALL fall outside the polygon ∩ bbox
      // is no longer pre-empted with a skip: it reaches reconcile, and a genuine
      // removal within the cell propagates (this single-row cell is below the
      // wipe-guard's floor, so the now-absent row is tombstoned). The guard — not a
      // pre-reconcile skip — is what would withhold a mass wipe on a dense tile.
      // (filterToRegion returns no ordinals → inScope empty → authoritative empty.)
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        wayXml(1, 60, 30),
      );
      filterRegion.mockResolvedValueOnce([]); // nothing inside the polygon ∩ bbox
      loadExisting.mockResolvedValueOnce([
        existingRow('live', '7', 0, [
          [14, 50],
          [14, 50.0009],
        ]),
      ]);
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importTile(CZ, CZ_TILE, dir);
      expect(loadExisting).toHaveBeenCalled(); // reconcile RAN (not skipped)
      expect(result.deactivated).toBe(1); // the now-absent row propagates
      expect(warn).not.toHaveBeenCalled(); // below the floor → no withhold warn
    });

    it('reconciles a non-empty tile scoped to the country polygon ∩ tile bbox', async () => {
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        wayXml(1),
      );
      loadExisting.mockResolvedValue([]); // no existing rows
      const result = await service.importTile(CZ, CZ_TILE, dir);
      expect(result.upserted).toBe(1);
      // loadExistingInRegion is called with the CZ country polygon AND the tile
      // bbox tuple — the SAME combined scope filterToRegion filtered the incoming
      // set to (the #1033 invariant, extended to the tile bbox).
      expect(loadExisting).toHaveBeenCalledWith(expect.any(String), [
        regionPolygon('CZ'),
        CZ.bbox.minLng,
        CZ.bbox.minLat,
        CZ.bbox.maxLng,
        CZ.bbox.maxLat,
      ]);
      // Both sides of the invariant run the combined polygon + envelope test:
      // the incoming filter (unnest … WITH ORDINALITY) and the existing-row load
      // (road_segments) BOTH reference ST_MakeEnvelope.
      const filterSql = (filterRegion.mock.calls[0] as [string, unknown[]])[0];
      expect(filterSql).toContain('WITH ORDINALITY');
      expect(filterSql).toContain('ST_MakeEnvelope');
      const loadSql = (loadExisting.mock.calls[0] as [string, unknown[]])[0];
      expect(loadSql).toContain('road_segments');
      expect(loadSql).toContain('ST_MakeEnvelope');
    });
  });

  describe('importRegion', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'road-import-region-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('subdivides a region into >1 tile and imports every tile file', async () => {
      // span 4° over CZ (width 6.77°, height 2.51°) → ceil(6.77/4)=2 cols ×
      // ceil(2.51/4)=1 row → 2 tiles: r0c0 + r0c1. Each tile file carries its own
      // way, so the per-tile loop reads both and the upserts aggregate.
      osmConfig.tileSpanDeg = 4;
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        wayXml(1),
      );
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE_R0C1, osmConfig.tileSpanDeg)),
        wayXml(2),
      );
      loadExisting.mockResolvedValue([]);
      const result = await service.importRegion(CZ, dir);
      // Both tiles imported (1 way each) → 2 upserts, one reconcile flush per tile.
      expect(result.upserted).toBe(2);
      expect(qb.execute).toHaveBeenCalledTimes(2);
    });

    it('skips the region tiles with no extract, imports the ones present', async () => {
      // span 4° → 2 tiles; only r0c1 has an extract. The absent r0c0 skips (warn,
      // no tombstone), r0c1 imports — a region needn't have every cell on disk
      // (all-water/empty cells are simply never written by the producer).
      osmConfig.tileSpanDeg = 4;
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE_R0C1, osmConfig.tileSpanDeg)),
        wayXml(2),
      );
      loadExisting.mockResolvedValue([]);
      const result = await service.importRegion(CZ, dir);
      expect(result.upserted).toBe(1);
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('runs every tile of a region in ONE transaction and rejects when a later tile fails (atomic per-region, Codex P1)', async () => {
      // span 4° → 2 tiles (r0c0 + r0c1). r0c0 is a valid extract (one way → one
      // flush issued on the region tx); r0c1 is MALFORMED XML, so its parse throws
      // mid-region. The region must run under a SINGLE manager.transaction and
      // REJECT — the atomic-per-region guarantee. The mock can't model rollback, so
      // it proves one-tx-for-all-tiles + rejection here; the e2e proves the earlier
      // tile's write actually rolls back against real PostGIS.
      osmConfig.tileSpanDeg = 4;
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        wayXml(1),
      );
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE_R0C1, osmConfig.tileSpanDeg)),
        // A present-but-malformed extract (mismatched close tag → sax rejects) — a
        // genuine parse failure, NOT an absent file, so importTile throws and the
        // region rejects (an absent tile would skip without throwing).
        '<osm version="0.6"><node id="1" lat="50" lon="14"></nope></osm>',
      );
      loadExisting.mockResolvedValue([]);

      await expect(service.importRegion(CZ, dir)).rejects.toThrow();
      // ONE transaction wrapped BOTH tiles (not one-per-tile), so the later tile's
      // failure rolls the earlier tile's writes back with it.
      expect(managerTransaction).toHaveBeenCalledTimes(1);
      // The earlier tile's upsert DID run — on that same (now-failed) region tx.
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('importAll', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'road-import-all-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('loops the configured regions (tile-by-tile) and aggregates upserts', async () => {
      // tileSpanDeg default (100°) → each region is a single r0c0 tile. CZ's way
      // sits inside CZ, SK's inside SK (48.5N, 19.5E). In real runs importTile
      // scopes each extract to its country polygon ∩ tile bbox via filterToRegion
      // (a DB query, mocked here to accept every incoming way), so both regions
      // contribute one upsert.
      // tileSpanDeg is still the beforeEach default (100) here — unchanged by
      // this test — so both filenames use osmConfig.tileSpanDeg for the span.
      await writeFile(
        join(dir, roadTileFileName(CZ_TILE, osmConfig.tileSpanDeg)),
        wayXml(1),
      );
      await writeFile(
        join(dir, roadTileFileName(SK_TILE, osmConfig.tileSpanDeg)),
        wayXml(2, 48.5, 19.5),
      );
      osmConfig.extractDir = dir;
      osmConfig.regions = [
        {
          code: 'CZ',
          bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
        },
        {
          code: 'SK',
          bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
        },
      ];
      loadExisting.mockResolvedValue([]);
      const result = await service.importAll();
      expect(result.upserted).toBe(2);
    });

    it('throws when extractDir is unset', async () => {
      osmConfig.extractDir = null;
      await expect(service.importAll()).rejects.toThrow(
        /TARMOTO_OSM_ROAD_IMPORT_DIR/,
      );
    });
  });
});
