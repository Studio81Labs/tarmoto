import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppDataSource } from '../src/data-source.js';
import { OsmImportService } from '../src/modules/roads/osm-import/osm-import.service.js';
import { osmImportConfig } from '../src/modules/roads/osm-import/osm-import.config.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';
import type { OsmWay } from '../src/modules/roads/osm-import/segment-rows.js';

/**
 * Issue #835 / ADR-0006 — the OSM importer's split/merge reconciliation must let
 * quality/review history follow the ROAD across a snapshot in which a way's id
 * changed (split/merge), and tombstone (never delete) a row nothing matches. The
 * carry-over is an id-preserving UPDATE + the stale pass is a `deactivated_at`
 * write, both against real Postgres/PostGIS, so the only meaningful test drives
 * the real queries.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('OSM split/merge reconciliation (#835)', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let dataSource: DataSource;
  const trackedIds: string[] = [];

  // A remote corner of the map so this test's ways can't collide with seeded rows.
  const LNG = 9.11;
  const LAT = 47.03;

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

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RoadSegment]),
      ],
      providers: [
        OsmImportService,
        {
          provide: osmImportConfig.KEY,
          // An explicit region enclosing this test's ways so stale detection is
          // authoritative (a data-derived bbox would not tombstone).
          useValue: {
            enabled: true,
            filePath: null,
            bbox: [LNG - 0.1, LAT - 0.1, LNG + 0.2, LAT + 0.2],
          },
        },
      ],
    }).compile();
    service = module.get(OsmImportService);
    dataSource = module.get(DataSource);
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
    await module?.close();
  });

  it('carries id + history onto a re-keyed way and tombstones an unmatched row', async () => {
    // 1) Seed the existing network: way 8100 (one ~100 m segment) + a stale way
    //    8199 far away that the next snapshot won't contain.
    await service.importFrom([way(8100), way(8199, 0.05)]);
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
    const result = await service.importFrom([way(8200)]);
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
  }, 30_000);
});
