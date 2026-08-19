import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppDataSource } from '../src/data-source.js';
import {
  OsmImportService,
  type RegionScope,
} from '../src/modules/roads/osm-import/osm-import.service.js';
import { RoadsService } from '../src/modules/roads/roads.service.js';
import { FeatureResolver } from '../src/modules/features/feature-resolver.service.js';
import { osmRoadImportConfig } from '../src/modules/roads/osm-import/osm-import.config.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';
import { FunZone } from '../src/entities/fun-zone.entity.js';
import type { OsmWay } from '../src/modules/roads/osm-import/segment-rows.js';

/**
 * Issue #835 / ADR-0006 — the OSM importer's split/merge reconciliation must let
 * quality/review history follow the ROAD across a snapshot in which a way's id
 * changed (split/merge), and tombstone (never delete) a row nothing matches. The
 * carry-over is an id-preserving UPDATE + the stale pass is a `deactivated_at`
 * write, both against real Postgres/PostGIS, so the only meaningful test drives
 * the real queries.
 *
 * Isolation (Codex P2 — non-destructive): `importFrom` drives the SAME
 * production reconcile this test is proving, scoped to the explicit REGION
 * below — a real ~30 km patch of map near the Alps, not a synthetic
 * no-man's-land. If the DB already holds live OSM road rows there, this
 * test's tiny two-way snapshot would make them look "removed" and tombstone
 * them. Rather than clearing that scope (a hard DELETE risks real rows and
 * their FK history — surface_readings — or an FK-constraint crash),
 * `beforeAll` COUNTs the live OSM rows already in REGION's polygon ∩ bbox
 * scope and THROWS if non-empty, refusing to run rather than mutating a
 * populated DB. Cleanup (`afterAll`) only ever deletes this run's own tracked
 * row/way ids, never a scope-wide sweep. REGION is a remote synthetic patch
 * disjoint from the other reconcile e2e specs' scopes (CZ ∪ SK / the RO
 * tiles), so it's safe under Jest's file-level parallelism. Must still run
 * against a disposable test DB with no imported OSM roads in this area — the
 * guard just makes "populated" fail loudly instead of corrupting data.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('OSM split/merge reconciliation (#835)', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let roads: RoadsService;
  let dataSource: DataSource;
  const trackedIds: string[] = [];

  // A remote corner of the map so this test's ways can't collide with seeded rows.
  const LNG = 9.11;
  const LAT = 47.03;
  // An explicit scope enclosing this test's ways so stale detection is
  // authoritative (a data-derived bbox would not tombstone) — passed directly to
  // `importFrom` now that the importer no longer reads a region off its config
  // (the folder model, Sub-project B; see `OsmImportService.importTile`). The
  // scope is now the country POLYGON (for `ST_GeomFromGeoJSON`, #1033) ∩ the tile
  // bbox (for `ST_MakeEnvelope`, sub-region tiling) — here one rectangle serving
  // as both, enclosing every test way, so the combined test behaves exactly as a
  // single authoritative boundary.
  const REGION: RegionScope = {
    polygon: JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [LNG - 0.1, LAT - 0.1],
          [LNG + 0.2, LAT - 0.1],
          [LNG + 0.2, LAT + 0.2],
          [LNG - 0.1, LAT + 0.2],
          [LNG - 0.1, LAT - 0.1],
        ],
      ],
    }),
    bbox: [LNG - 0.1, LAT - 0.1, LNG + 0.2, LAT + 0.2],
  };

  /** A single ~100 m drivable way at a given offset from the test origin. */
  function way(id: number, dLat = 0, dLng = 0): OsmWay {
    return {
      id,
      tags: { highway: 'residential' },
      coords: [
        { lat: LAT + dLat, lng: LNG + dLng },
        { lat: LAT + dLat + 0.0009, lng: LNG + dLng },
      ],
    };
  }

  async function segmentsForWay(
    osmWayId: string,
  ): Promise<
    Array<{ id: string; osm_way_id: string; deactivated_at: Date | null }>
  > {
    return dataSource.query(
      `SELECT id, osm_way_id::text AS osm_way_id, deactivated_at
       FROM road_segments WHERE osm_way_id = $1`,
      [osmWayId],
    );
  }

  /** This test's synthetic OSM way ids — 8100 (the original way), 8199 (the
   *  stale way), and 8200 (8100's re-keyed identity after the simulated
   *  split/merge). Used only for a crash-recovery pre-clean (by exact id,
   *  never a scope-wide sweep) before the guard below inspects REGION's
   *  scope — the PRIMARY cleanup is `afterAll`'s `trackedIds` (this run's
   *  actual row uuids), which also covers the FK `surface_readings` row this
   *  test attaches. */
  const FIXTURE_WAY_IDS = ['8100', '8199', '8200'];

  /** DELETE this spec's own fixture rows by their known synthetic
   *  `osm_way_id`s — never a scope-wide sweep. `surface_readings` is cleared
   *  first (FK) via a subquery on the same ids. */
  async function deleteFixtureWayIds(): Promise<void> {
    await dataSource.query(
      `DELETE FROM surface_readings WHERE road_segment_id IN (
         SELECT id FROM road_segments WHERE osm_way_id = ANY($1::bigint[])
       )`,
      [FIXTURE_WAY_IDS],
    );
    await dataSource.query(
      `DELETE FROM road_segments WHERE osm_way_id = ANY($1::bigint[])`,
      [FIXTURE_WAY_IDS],
    );
  }

  /** Non-destructive precondition guard (Codex P2): COUNT the live, OSM-owned
   *  `road_segments` rows already inside REGION's polygon ∩ bbox — the EXACT
   *  scope `importFrom` reconciles — and THROW if any exist. Called before
   *  any fixture is written (see `beforeAll`), so a non-zero count is always
   *  genuine collateral, never this spec's own rows; refusing to run protects
   *  that data instead of tombstoning it. Scoped to `osm_way_id IS NOT NULL
   *  AND deactivated_at IS NULL`: the exact candidate set `reconcile` itself
   *  loads (crowd-sourced and already-tombstoned rows are never reconcile
   *  candidates), so this can never false-positive on demo/seed data. */
  async function assertCleanScope(): Promise<void> {
    const [minLng, minLat, maxLng, maxLat] = REGION.bbox;
    const rows: Array<{ count: number }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM road_segments
       WHERE osm_way_id IS NOT NULL
         AND deactivated_at IS NULL
         AND ST_Intersects(geom, ST_GeomFromGeoJSON($1))
         AND ST_Intersects(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
      [REGION.polygon, minLng, minLat, maxLng, maxLat],
    );
    const count = rows[0]!.count;
    if (count > 0) {
      throw new Error(
        `osm-split-merge-reconcile e2e requires a clean scope — found ` +
          `${count} pre-existing OSM road_segments in REGION's polygon ∩ ` +
          `bbox (near lat ${LAT}, lng ${LNG}); run against a disposable DB ` +
          `with no imported OSM roads in this area.`,
      );
    }
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RoadSegment, FunZone]),
      ],
      providers: [
        OsmImportService,
        RoadsService,
        {
          provide: osmRoadImportConfig.KEY,
          useValue: { enabled: true, extractDir: null, regions: [] },
        },
        // RoadsService now depends on FeatureResolver (the sys_poi_ratings
        // gate); this reconcile test never exercises the review aggregate, so
        // a stub is enough to satisfy DI.
        {
          provide: FeatureResolver,
          useValue: { isSystemSwitchEnabled: () => Promise.resolve(true) },
        },
      ],
    }).compile();
    service = module.get(OsmImportService);
    roads = module.get(RoadsService);
    dataSource = module.get(DataSource);

    // Crash-recovery: a prior run that died mid-test could leave this spec's
    // own fixtures live under their known synthetic way ids; clear them
    // (never collateral) before the guard below inspects REGION's scope.
    await deleteFixtureWayIds();
    await assertCleanScope();
  });

  afterAll(async () => {
    if (trackedIds.length > 0) {
      await dataSource.query(
        `DELETE FROM surface_readings WHERE road_segment_id = ANY($1::uuid[])`,
        [trackedIds],
      );
      await dataSource.query(
        `DELETE FROM road_segments WHERE id = ANY($1::uuid[])`,
        [trackedIds],
      );
    }
    // Catch-all: if the test threw before `trackedIds` was populated (e.g.
    // the first `importFrom` call itself failed), this still removes any
    // fixture row left behind, by the same known synthetic way ids.
    await deleteFixtureWayIds();
    await module?.close();
  });

  it('carries id + history onto a re-keyed way and tombstones an unmatched row', async () => {
    // 1) Seed the existing network: way 8100 (one ~100 m segment) + a stale way
    //    8199 far away that the next snapshot won't contain.
    await service.importFrom([way(8100), way(8199, 0.05)], REGION);
    const seededMain = await segmentsForWay('8100');
    const seededStale = await segmentsForWay('8199');
    expect(seededMain).toHaveLength(1);
    expect(seededStale).toHaveLength(1);
    const originalId = seededMain[0]!.id;
    const staleId = seededStale[0]!.id;
    trackedIds.push(originalId, staleId);

    // Attach crowd history to the main segment (a surface reading FK).
    const users: { id: string }[] = await dataSource.query(
      `SELECT id FROM users LIMIT 1`,
    );
    const userId = users[0]?.id ?? null;
    if (userId) {
      await dataSource.query(
        `INSERT INTO surface_readings
           (road_segment_id, user_id, iri_value, classification, recorded_at)
         VALUES ($1, $2, 2.0, 'good', NOW())`,
        [originalId, userId],
      );
    }

    // 2) Re-import: the SAME geometry now belongs to way 8200 (a split/merge
    //    re-keyed it), and way 8199 is gone from the snapshot.
    const result = await service.importFrom([way(8200)], REGION);
    expect(result.carriedOver).toBe(1);
    expect(result.deactivated).toBe(1);

    // 3) The main segment kept its id (history intact) and adopted the new key.
    const afterMain = await segmentsForWay('8200');
    expect(afterMain).toHaveLength(1);
    expect(afterMain[0]!.id).toBe(originalId); // id preserved
    expect(afterMain[0]!.deactivated_at).toBeNull(); // live
    // Old key no longer resolves to a live row.
    expect(await segmentsForWay('8100')).toHaveLength(0);
    // The FK still resolves to the same (carried-over) segment.
    if (userId) {
      const readings: { c: string }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS c FROM surface_readings WHERE road_segment_id = $1`,
        [originalId],
      );
      expect(Number(readings[0]!.c)).toBe(1);
    }

    // 4) The unmatched way was tombstoned, not deleted.
    const afterStale = await segmentsForWay('8199');
    expect(afterStale).toHaveLength(1);
    expect(afterStale[0]!.id).toBe(staleId);
    expect(afterStale[0]!.deactivated_at).not.toBeNull();

    // 5) The tombstoned road is excluded from active discovery reads.
    const nearby = await roads.findNearby({
      lng: LNG,
      lat: LAT + 0.05,
      radius: 500,
    });
    expect(nearby.some((r) => r.id === staleId)).toBe(false);
    // …while the live carried-over road is still discoverable.
    const nearbyMain = await roads.findNearby({
      lng: LNG,
      lat: LAT,
      radius: 500,
    });
    expect(nearbyMain.some((r) => r.id === originalId)).toBe(true);
  }, 30_000);
});
