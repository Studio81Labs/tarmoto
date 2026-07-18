import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppDataSource } from '../src/data-source.js';
import {
  OsmImportService,
  type RegionScope,
} from '../src/modules/roads/osm-import/osm-import.service.js';
import { RoadsService } from '../src/modules/roads/roads.service.js';
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
 * Isolation (Codex P2): `importFrom` drives the SAME production reconcile this
 * test is proving, scoped to the explicit REGION below — a real ~30 km patch of
 * map near the Alps, not a synthetic no-man's-land. If the DB already holds
 * live OSM road rows there, this test's tiny two-way snapshot would make them
 * look "removed" and tombstone them, and cleanup only deletes this test's own
 * tracked row ids, never restoring collateral. `beforeEach` therefore DELETEs
 * every `road_segments` row in REGION's bbox first, so the test starts from a
 * clean scope — this spec owns that scope and must run against a disposable
 * test DB, never one with road data you care about.
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

  /** DELETE every OSM-owned road_segments row (live or tombstoned) whose
   *  geometry overlaps REGION's bbox — this spec owns that scope (see the
   *  isolation note above), so each test starts clean and `reconcile` has
   *  nothing pre-existing left to tombstone. REGION's bbox IS its polygon
   *  here (a synthetic rectangle), so this clears exactly reconcile's real
   *  scope. Scoped to `osm_way_id IS NOT NULL`: crowd-sourced rows are never
   *  reconcile candidates (the importer's own existing-row loaders exclude
   *  them the same way), so narrowing here keeps this from nuking real
   *  demo/seed data on a developer DB. */
  async function clearRegionScope(): Promise<void> {
    const [minLng, minLat, maxLng, maxLat] = REGION.bbox;
    await dataSource.query(
      `DELETE FROM road_segments
       WHERE osm_way_id IS NOT NULL
         AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
      [minLng, minLat, maxLng, maxLat],
    );
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
      ],
    }).compile();
    service = module.get(OsmImportService);
    roads = module.get(RoadsService);
    dataSource = module.get(DataSource);
  });

  beforeEach(async () => {
    await clearRegionScope();
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
    await clearRegionScope();
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
    const originalId = seededMain[0].id;
    const staleId = seededStale[0].id;
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
    expect(afterMain[0].id).toBe(originalId); // id preserved
    expect(afterMain[0].deactivated_at).toBeNull(); // live
    // Old key no longer resolves to a live row.
    expect(await segmentsForWay('8100')).toHaveLength(0);
    // The FK still resolves to the same (carried-over) segment.
    if (userId) {
      const readings: { c: string }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS c FROM surface_readings WHERE road_segment_id = $1`,
        [originalId],
      );
      expect(Number(readings[0].c)).toBe(1);
    }

    // 4) The unmatched way was tombstoned, not deleted.
    const afterStale = await segmentsForWay('8199');
    expect(afterStale).toHaveLength(1);
    expect(afterStale[0].id).toBe(staleId);
    expect(afterStale[0].deactivated_at).not.toBeNull();

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
