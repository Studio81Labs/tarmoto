import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  roadTileFileName,
  subdivideRegion,
  type PoiImportRegion,
  type RoadTile,
} from '@tarmoto/ingest';
import { AppDataSource } from '../src/data-source.js';
import { OsmImportService } from '../src/modules/roads/osm-import/osm-import.service.js';
import { osmRoadImportConfig } from '../src/modules/roads/osm-import/osm-import.config.js';
import { regionPolygon } from '../src/modules/roads/osm-import/region-polygons.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';

/**
 * Authoritative-empty tile reconciliation — a road REMOVED from a tile's
 * re-import must propagate as a tombstone (removals are authoritative now that a
 * PRESENT extract flows through to reconcile), while an implausible mass by-absence
 * wipe on a DENSE tile is WITHHELD by the guard (a row floor
 * `MIN_ROWS_FOR_TOMBSTONE_GUARD` + `MAX_TOMBSTONE_FRACTION`, mirroring the POI
 * importer). A SPARSE tile (below the row floor) propagates its removals freely even
 * past 50% — a small blast radius is never withheld. All against real
 * Postgres/PostGIS, driven through the public `importTile` so the whole path —
 * present extract → polygon ∩ tile bbox filter → reconcile → tombstone/withhold —
 * runs.
 *
 * A remote, tightly-clustered interior corner of Romania (Timișoara, tile r0c0 at
 * a 2.5° span) is used so this test's roads occupy their own tile, disjoint from
 * the other reconcile e2e specs (Bucharest r0c2 / Cluj r1c1 / CZ / SK / the
 * synthetic split-merge scope). Each test's `afterEach` deletes only this spec's
 * own tracked synthetic way ids (the 3-road sparse cluster + the 60-road dense
 * cluster) — never a scope-wide sweep — so the guard's denominator (the in-scope
 * existing rows) is exactly this test's seeded roads, independent of any seed/
 * other data.
 *
 * Isolation (Codex P2 — non-destructive): `importTile` drives the SAME
 * production reconcile this test is proving, scoped to RO's real country
 * polygon ∩ this tile's bbox — so if the DB already holds live OSM road rows
 * there (RO is a configured import region), this test's tiny synthetic
 * extract would make them look "removed" and tombstone them. Rather than
 * clearing that scope (a hard DELETE risks real rows and their FK history, or
 * an FK-constraint crash), `beforeEach` COUNTs the live OSM rows already in
 * the tile's polygon ∩ bbox scope and THROWS if non-empty, refusing to run
 * rather than mutating a populated DB — safe to run before every test because
 * `afterEach` always leaves the scope holding nothing but (at most) this
 * spec's own fixtures, which it just deleted. This spec's Timișoara tile
 * scope is disjoint from the other reconcile e2e specs' scopes, so it's safe
 * under Jest's file-level parallelism. Must still run against a disposable
 * test DB with no imported OSM roads in this area — the guard just makes
 * "populated" fail loudly instead of corrupting data.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before `pnpm --filter
 * @tarmoto/backend test:e2e`.
 */
describe('OSM authoritative-empty tile reconciliation — remove propagates, mass-wipe withheld', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let dataSource: DataSource;
  let dir: string;
  let testTile: RoadTile;

  const TILE_SPAN_DEG = 2.5;
  const RO: PoiImportRegion = {
    code: 'RO',
    bbox: { minLng: 20.26, minLat: 43.62, maxLng: 29.71, maxLat: 48.27 },
  };
  // Three roads tightly clustered around Timișoara (western RO interior), ~780 m
  // apart, so all three fall inside the RO polygon AND a single tile.
  const ROADS = [
    { wayId: 884001, lng: 21.2, lat: 45.75 },
    { wayId: 884002, lng: 21.21, lat: 45.75 },
    { wayId: 884003, lng: 21.22, lat: 45.75 },
  ];
  const trackedWayIds = ROADS.map((r) => String(r.wayId));

  // A DENSE set: 60 distinct roads packed ~46 m apart through central Timișoara —
  // all inside RO ∩ the same tile, and enough (>= MIN_ROWS_FOR_TOMBSTONE_GUARD = 50)
  // to ARM the wipe-guard so a >50% removal is withheld (unlike the 3-road sparse
  // tile above, which is below the floor and propagates freely).
  const DENSE_COUNT = 60;
  const denseRoads = Array.from({ length: DENSE_COUNT }, (_, i) => ({
    wayId: 884101 + i,
    lng: 21.22 + i * 0.0006,
    lat: 45.75,
  }));

  // Every synthetic way id this spec's tests can ever create (the sparse trio +
  // the dense 60) — the ONLY rows `deleteFixtureRows` ever touches, by exact id,
  // never a scope-wide sweep.
  const allFixtureWayIds = [
    ...trackedWayIds,
    ...denseRoads.map((r) => String(r.wayId)),
  ];

  /** One drivable way with a single ~100 m N–S segment at `(lat,lng)`. Latitude
   *  is offset by ~0.0009° (≈100 m); a longitude offset would shrink with cos(lat)
   *  and segment into several rows. */
  function wayXml(id: number, lat: number, lng: number): string {
    return (
      `<node id="${id}0" lat="${lat}" lon="${lng}"/>` +
      `<node id="${id}1" lat="${lat + 0.0009}" lon="${lng}"/>` +
      `<way id="${id}"><nd ref="${id}0"/><nd ref="${id}1"/>` +
      `<tag k="highway" v="residential"/></way>`
    );
  }
  function osmDoc(...ways: string[]): string {
    return `<osm version="0.6">${ways.join('')}</osm>`;
  }

  /** Write the test tile's extract carrying exactly the given roads (by index into
   *  ROADS). Overwrites the previous extract — the re-import reads the new set. */
  async function writeTile(...roadIdx: number[]): Promise<void> {
    await writeFile(
      join(dir, roadTileFileName(testTile, TILE_SPAN_DEG)),
      osmDoc(
        ...roadIdx.map((i) => {
          const r = ROADS[i]!;
          return wayXml(r.wayId, r.lat, r.lng);
        }),
      ),
    );
  }

  async function segmentsForWay(
    osmWayId: string,
  ): Promise<Array<{ id: string; deactivated_at: Date | null }>> {
    return dataSource.query(
      `SELECT id, deactivated_at FROM road_segments WHERE osm_way_id = $1`,
      [osmWayId],
    );
  }

  /** DELETE this spec's own tracked synthetic way ids (the sparse trio + the
   *  dense 60) — never a scope-wide sweep. Run after EVERY test (`afterEach`)
   *  so the tile is empty again before the next test's `assertCleanScope`
   *  guard runs — the mass-wipe fraction denominator each test computes is
   *  then exactly its own seeded roads, independent of any sibling test or
   *  other data — and once more as a crash-recovery pre-clean in `beforeAll`
   *  (a prior run that died mid-test could leave these live, which would
   *  otherwise wedge the guard). */
  async function deleteFixtureRows(): Promise<void> {
    await dataSource.query(
      `DELETE FROM road_segments WHERE osm_way_id = ANY($1::bigint[])`,
      [allFixtureWayIds],
    );
  }

  /** Non-destructive precondition guard (Codex P2): COUNT the live, OSM-owned
   *  `road_segments` rows already inside the test tile's country polygon ∩
   *  bbox — the EXACT scope `importTile` reconciles — and THROW if any exist.
   *  Runs in `beforeEach`, so it only ever sees genuine collateral: `afterEach`
   *  guarantees the previous test (if any) left this tile holding nothing but
   *  what it just deleted. Scoped to `osm_way_id IS NOT NULL AND
   *  deactivated_at IS NULL`: the exact candidate set `reconcile` itself loads
   *  (crowd-sourced and already-tombstoned rows are never reconcile
   *  candidates), so this can never false-positive on demo/seed data. */
  async function assertCleanScope(): Promise<void> {
    const { minLng, minLat, maxLng, maxLat } = testTile.bbox;
    const rows: Array<{ count: number }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM road_segments
       WHERE osm_way_id IS NOT NULL
         AND deactivated_at IS NULL
         AND ST_Intersects(geom, ST_GeomFromGeoJSON($1))
         AND ST_Intersects(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
      [regionPolygon(RO.code), minLng, minLat, maxLng, maxLat],
    );
    const count = rows[0]!.count;
    if (count > 0) {
      throw new Error(
        `osm-authoritative-empty-reconcile e2e requires a clean scope — ` +
          `found ${count} pre-existing OSM road_segments in RO tile ` +
          `r${testTile.row}c${testTile.col}'s polygon ∩ bbox; run against a ` +
          `disposable DB with no imported OSM roads in this area.`,
      );
    }
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RoadSegment]),
      ],
      providers: [
        OsmImportService,
        {
          provide: osmRoadImportConfig.KEY,
          useValue: {
            enabled: true,
            extractDir: null,
            regions: [],
            tileSpanDeg: TILE_SPAN_DEG,
          },
        },
      ],
    }).compile();
    service = module.get(OsmImportService);
    dataSource = module.get(DataSource);
    dir = await mkdtemp(join(tmpdir(), 'road-authempty-e2e-'));

    // The tile containing the Timișoara cluster; assert all three roads share it
    // (interior points, no seam ambiguity) so the "one tile" premise holds.
    const tiles = subdivideRegion(RO, TILE_SPAN_DEG);
    const tile = tiles.find(
      (t) =>
        ROADS[0]!.lng >= t.bbox.minLng &&
        ROADS[0]!.lng <= t.bbox.maxLng &&
        ROADS[0]!.lat >= t.bbox.minLat &&
        ROADS[0]!.lat <= t.bbox.maxLat,
    );
    if (!tile) throw new Error('no RO tile contains the Timișoara cluster');
    testTile = tile;
    for (const r of ROADS) {
      const inTile =
        r.lng >= tile.bbox.minLng &&
        r.lng <= tile.bbox.maxLng &&
        r.lat >= tile.bbox.minLat &&
        r.lat <= tile.bbox.maxLat;
      if (!inTile) throw new Error(`road ${r.wayId} is not in the test tile`);
    }

    // Crash-recovery: a prior run that died mid-test could leave this spec's
    // own tracked fixtures live; clear them by exact id (never collateral —
    // see deleteFixtureRows) before the first test's guard inspects the scope.
    await deleteFixtureRows();
  });

  beforeEach(async () => {
    await assertCleanScope();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  afterAll(async () => {
    await deleteFixtureRows();
    await rm(dir, { recursive: true, force: true });
    await module?.close();
  });

  it('propagates a sub-50% road removal: the dropped road is tombstoned, id preserved', async () => {
    // 1) Seed three roads in the tile (proves each is inside RO ∩ the tile).
    await writeTile(0, 1, 2);
    const seed = await service.importTile(RO, testTile, dir);
    expect(seed.result.upserted).toBe(3);
    const seededC = await segmentsForWay(trackedWayIds[2]!);
    expect(seededC).toHaveLength(1);
    expect(seededC[0]!.deactivated_at).toBeNull();
    const roadCId = seededC[0]!.id;
    const roadAId = (await segmentsForWay(trackedWayIds[0]!))[0]!.id;

    // 2) Re-import the SAME tile WITHOUT road C (the extract shrank): 1/3 = 33% of
    //    the tile's roads removed — below the guard (both floor and fraction), so
    //    the removal propagates.
    await writeTile(0, 1);
    const reimport = await service.importTile(RO, testTile, dir);
    expect(reimport.result.deactivated).toBe(1); // exactly road C

    // 3) Road C is TOMBSTONED (deactivated_at set) with its id preserved — a
    //    soft-delete UPDATE, never a row deletion (its history FKs survive).
    const afterC = await segmentsForWay(trackedWayIds[2]!);
    expect(afterC).toHaveLength(1);
    expect(afterC[0]!.id).toBe(roadCId);
    expect(afterC[0]!.deactivated_at).not.toBeNull();

    // 4) Road A (still in the extract) stays live with its original id.
    const afterA = await segmentsForWay(trackedWayIds[0]!);
    expect(afterA).toHaveLength(1);
    expect(afterA[0]!.id).toBe(roadAId);
    expect(afterA[0]!.deactivated_at).toBeNull();
  }, 30_000);

  it('propagates a majority (>50%) removal on a SPARSE tile below the guard floor', async () => {
    // Seed three roads, then re-import with only ONE (2/3 = 67% > 50% removed). This
    // tile has just 3 in-scope rows — below MIN_ROWS_FOR_TOMBSTONE_GUARD (50) — so
    // the guard does NOT arm: the two absent roads are tombstoned, a small tile's
    // genuine removals propagate freely rather than being withheld + warned forever.
    await writeTile(0, 1, 2);
    await service.importTile(RO, testTile, dir);

    await writeTile(0);
    const reimport = await service.importTile(RO, testTile, dir);
    expect(reimport.result.deactivated).toBe(2); // both dropped roads propagate

    // Roads B + C, absent from the shrunken extract, are TOMBSTONED (not deleted).
    for (const wayId of [trackedWayIds[1]!, trackedWayIds[2]!]) {
      const rows = await segmentsForWay(wayId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deactivated_at).not.toBeNull();
    }
    // Road A (still present) stays live.
    const afterA = await segmentsForWay(trackedWayIds[0]!);
    expect(afterA).toHaveLength(1);
    expect(afterA[0]!.deactivated_at).toBeNull();
  }, 30_000);

  it('withholds a >50% mass by-absence wipe on a DENSE (>= 50-row) tile: the dropped roads stay live', async () => {
    // Seed 60 roads (>= MIN_ROWS_FOR_TOMBSTONE_GUARD), then re-import keeping only 20
    // (40 removed = 67% > 50%). NOW the tile is dense enough for a mass wipe to be
    // implausible, so the guard ARMS and WITHHOLDS the by-absence tombstones — the 40
    // dropped roads stay LIVE (a mis-produced / shrunken extract must not wipe a dense
    // tile). This is the end-to-end counterpart of the sparse case above.
    const seedDoc = osmDoc(
      ...denseRoads.map((r) => wayXml(r.wayId, r.lat, r.lng)),
    );
    await writeFile(
      join(dir, roadTileFileName(testTile, TILE_SPAN_DEG)),
      seedDoc,
    );
    const seed = await service.importTile(RO, testTile, dir);
    expect(seed.result.upserted).toBe(DENSE_COUNT); // premise: all 60 inside RO ∩ the tile

    const kept = denseRoads.slice(0, 20);
    await writeFile(
      join(dir, roadTileFileName(testTile, TILE_SPAN_DEG)),
      osmDoc(...kept.map((r) => wayXml(r.wayId, r.lat, r.lng))),
    );
    const reimport = await service.importTile(RO, testTile, dir);
    expect(reimport.result.deactivated).toBe(0); // withheld — nothing tombstoned

    // Sample of the 40 dropped roads (last + a middle one) — both remain LIVE.
    for (const r of [denseRoads[DENSE_COUNT - 1]!, denseRoads[40]!]) {
      const rows = await segmentsForWay(String(r.wayId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deactivated_at).toBeNull();
    }
  }, 30_000);
});
