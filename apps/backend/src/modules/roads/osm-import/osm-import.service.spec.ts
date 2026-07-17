import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { PoiImportRegion } from '@tarmoto/ingest';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  OsmImportService,
  ROAD_SEGMENT_ON_CONFLICT,
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

/** A rectangle region as a GeoJSON Polygon string — the reconcile/importFrom
 *  region param is now the country polygon (for `ST_GeomFromGeoJSON`), not a bbox
 *  tuple. The exact coordinates are opaque to these unit tests (the geometry
 *  queries are mocked); only region-set-vs-null and the string value passed to the
 *  load matter. */
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
  let osmConfig: {
    enabled: boolean;
    extractDir: string | null;
    regions: PoiImportRegion[];
  };

  /** Rows passed to `.values()` on the Nth (0-based) insert statement. */
  const valuesOnCall = (n: number): RoadSegmentRow[] =>
    (qb.values.mock.calls[n] as [RoadSegmentRow[]])[0];

  beforeEach(async () => {
    osmConfig = { enabled: false, extractDir: null, regions: [] };
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
    managerQuery = jest.fn().mockResolvedValue(undefined);
    const manager = { createQueryBuilder, query: managerQuery };
    // `repo.query` serves three raw queries; dispatch by SQL: the region filter
    // (`unnest … WITH ORDINALITY`) vs the existing-row load + out-of-bbox owner
    // load (both hit `road_segments`, driven by `loadExisting`'s call order).
    const repoQuery = jest.fn((sql: string, params: unknown[]): unknown =>
      sql.includes('WITH ORDINALITY')
        ? (filterRegion(sql, params) as unknown)
        : (loadExisting(sql, params) as unknown),
    );
    const repo = {
      query: repoQuery,
      manager: {
        transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
          cb(manager),
        ),
      },
    } as unknown as Repository<RoadSegment>;
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
    /** An existing row shaped like `loadExistingInBbox`'s raw query result. */
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
        poly(-1, -1, 20, 20),
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
        poly(-1, -1, 1, 1),
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

    it('tombstones every existing row when a configured region imports empty', async () => {
      // A configured region with zero drivable rows is authoritative: the region
      // was cleared, so its existing rows must be deactivated (not left live).
      loadExisting.mockResolvedValueOnce([
        existingRow('cleared', '7', 0, [
          [0, 0],
          [0, 0.0009],
        ]),
      ]);

      const result = await service.importFrom([], poly(-1, -1, 20, 20));

      expect(result.deactivated).toBe(1);
      const deactivate = (
        managerQuery.mock.calls as Array<[string, unknown[]]>
      ).find(([sql]) => sql.includes('deactivated_at = NOW()'));
      expect(deactivate![1]).toEqual([['cleared']]);
    });

    it('tombstones an existing row nothing matches — only with an explicit region', async () => {
      // Stale detection is region-authoritative: set a bbox so an unmatched row is
      // tombstoned. Existing row lives far from the incoming way → no match.
      loadExisting.mockResolvedValueOnce([
        existingRow('gone-uuid', '5', 0, [
          [10, 10],
          [10, 10.0009],
        ]),
      ]);

      const result = await service.importFrom(
        [straightWay(2)],
        poly(-1, -1, 20, 20),
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
        poly(100, 100, 101, 101),
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

  describe('importRegion', () => {
    let dir: string;
    const CZ: PoiImportRegion = {
      code: 'CZ',
      bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
    };
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'road-import-test-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('skips a region whose extract file is absent (no tombstone)', async () => {
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importRegion(CZ, dir);
      expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
      // reconcile never ran → no load/transaction
      expect(loadExisting).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('skips a present-but-empty extract with a warning (no tombstone)', async () => {
      await writeFile(join(dir, 'cz.osm'), '<osm version="0.6"></osm>');
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importRegion(CZ, dir);
      expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
      expect(loadExisting).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('skips an extract whose ways are all outside the region polygon (no tombstone)', async () => {
      // A present, non-empty extract that landed in the wrong file (e.g. SK data
      // written to cz.osm) — filterToRegion finds NONE of its ways inside the CZ
      // polygon. Must NOT reach `reconcile`: a post-filter-empty set WITH a region
      // would otherwise tombstone every live CZ row. (filterToRegion is the DB
      // `unnest … WITH ORDINALITY` query; here it returns no in-region ordinals.)
      await writeFile(join(dir, 'cz.osm'), wayXml(1, 60, 30));
      filterRegion.mockResolvedValueOnce([]); // nothing inside the CZ polygon
      const warn = jest.spyOn(service['logger'], 'warn');
      const result = await service.importRegion(CZ, dir);
      expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
      // reconcile never ran → the existing-row load was never issued.
      expect(loadExisting).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('reconciles a non-empty extract scoped to the region polygon', async () => {
      await writeFile(join(dir, 'cz.osm'), wayXml(1));
      loadExisting.mockResolvedValue([]); // no existing rows
      const result = await service.importRegion(CZ, dir);
      expect(result.upserted).toBe(1);
      // loadExistingInRegion is called with the CZ country polygon (not a bbox
      // tuple) — the same geometry filterToRegion scoped the incoming set to.
      expect(loadExisting).toHaveBeenCalledWith(expect.any(String), [
        regionPolygon('CZ'),
      ]);
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

    it('loops the configured regions and aggregates upserts', async () => {
      await writeFile(join(dir, 'cz.osm'), wayXml(1));
      // SK's way sits inside SK (48.5N, 19.5E). In real runs importRegion scopes
      // each extract to its country polygon via filterToRegion (a DB query, mocked
      // here to accept every incoming way), so both regions contribute one upsert.
      await writeFile(join(dir, 'sk.osm'), wayXml(2, 48.5, 19.5));
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
