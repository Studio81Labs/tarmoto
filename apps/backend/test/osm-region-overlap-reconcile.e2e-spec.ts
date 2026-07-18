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
} from '@tarmoto/ingest';
import { AppDataSource } from '../src/data-source.js';
import { OsmImportService } from '../src/modules/roads/osm-import/osm-import.service.js';
import { osmRoadImportConfig } from '../src/modules/roads/osm-import/osm-import.config.js';
import { regionPolygon } from '../src/modules/roads/osm-import/region-polygons.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';

/**
 * Folder-model regression (Codex P1 on PR #1033) — adjacent countries' bboxes
 * OVERLAP, but each `<code>.osm` extract is a per-country Geofabrik PBF. Scoping
 * stale-by-absence tombstoning to a region's bounding RECTANGLE lets a later
 * region claim authority over an earlier region's roads that fall in the shared
 * strip and tombstone them — destroying their segment id + crowd history. The fix
 * scopes both the incoming filter and the existing-row load to the actual country
 * POLYGON (bundled `import-region-boundaries.geojson`), so a region only ever
 * reconciles its own roads.
 *
 * CZ bbox [12.09,48.55,18.86,51.06] and SK bbox [16.83,47.73,22.57,49.61] overlap
 * in lng∈[16.83,18.86] × lat∈[48.55,49.61]. The CZ road at (17.5, 49.0) sits in
 * that strip (so it is inside SK's rectangle) but is inside the CZ polygon and
 * OUTSIDE the SK polygon — the exact case the rectangle scope corrupts.
 *
 * Real Postgres/PostGIS, driven through `importRegion` (the folder-model entry
 * point) so the whole path — tile subdivision → extract parse → region filter →
 * reconcile — runs. The extracts are now per-tile `<code>-r<row>c<col>-s<span>.osm` files
 * (the sub-region tiling model); this test runs at a large tile span so each
 * region is a single r0c0 tile whose bbox equals the region bbox, keeping the
 * assertion purely about the country-POLYGON scope (#1033). The disjoint-tile
 * no-wipe property is covered separately in `osm-tile-scope-reconcile.e2e-spec.ts`.
 *
 * Isolation (Codex P2 — non-destructive): `importRegion` drives the SAME
 * production reconcile this test is proving, scoped to CZ's and SK's REAL
 * country polygons — so if the DB already holds live OSM road rows there (CZ
 * is the launch region, the most likely to be populated on a developer DB),
 * this test's tiny synthetic extract would make them look "removed" and
 * tombstone them. Rather than clearing that scope (a hard DELETE risks real
 * rows and their FK history — surface_readings, road_reviews, hazard_reports,
 * fun_zone_roads — or an FK-constraint crash), `beforeAll` COUNTs the live
 * OSM rows already in CZ's and SK's polygon ∩ bbox scope and THROWS if either
 * is non-empty, refusing to run rather than mutating a populated DB. Cleanup
 * (`afterAll`) only ever deletes this spec's own tracked synthetic way ids,
 * never a scope-wide sweep, so nothing but the fixtures is ever touched. This
 * spec's scope (CZ ∪ SK) is disjoint from the other reconcile e2e specs'
 * scopes (the RO tiles / the synthetic Alps region), so it's safe under
 * Jest's file-level parallelism. Must still run against a disposable test DB
 * with no imported OSM roads in CZ/SK — the guard just makes "populated" fail
 * loudly instead of corrupting data.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before `pnpm --filter
 * @tarmoto/backend test:e2e`.
 */
describe('OSM region-overlap reconciliation — polygon scope (#1033)', () => {
  let module: TestingModule;
  let service: OsmImportService;
  let dataSource: DataSource;
  let dir: string;

  // A tile span wider than either country, so `subdivideRegion` yields exactly
  // one r0c0 tile per region (tile bbox == region bbox) — the country polygon is
  // then the only thing scoping the reconcile, which is the #1033 property here.
  const TILE_SPAN_DEG = 100;

  // Real CZ + SK region configs; their rectangles overlap (see header).
  const CZ: PoiImportRegion = {
    code: 'CZ',
    bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
  };
  const SK: PoiImportRegion = {
    code: 'SK',
    bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
  };

  /** The single-tile extract filename for a region at `TILE_SPAN_DEG` (one r0c0
   *  tile) — the file `importRegion` reads for that region. */
  function soleTileFile(region: PoiImportRegion): string {
    const tiles = subdivideRegion(region, TILE_SPAN_DEG);
    return roadTileFileName(tiles[0]!, TILE_SPAN_DEG);
  }

  // Way ids this test owns (across both cases) — deleted in afterAll.
  const trackedWayIds = ['881001', '881002', '882001', '882003'];

  /** One drivable way with a single ~100 m N–S segment at `(lat,lng)`. Latitude
   *  is offset by ~0.0009° (≈100 m); a longitude offset would shrink with
   *  cos(lat) and segment into several rows. */
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

  async function segmentsForWay(
    osmWayId: string,
  ): Promise<Array<{ id: string; deactivated_at: Date | null }>> {
    return dataSource.query(
      `SELECT id, deactivated_at FROM road_segments WHERE osm_way_id = $1`,
      [osmWayId],
    );
  }

  /** DELETE this spec's own tracked synthetic way ids (both cases below) —
   *  never a scope-wide sweep. Used both as a crash-recovery pre-clean (a
   *  prior run that died mid-test could leave these live, which would
   *  otherwise wedge the guard below) and as the post-run cleanup. */
  async function deleteTrackedWays(): Promise<void> {
    await dataSource.query(
      `DELETE FROM road_segments WHERE osm_way_id = ANY($1::bigint[])`,
      [trackedWayIds],
    );
  }

  /** Non-destructive precondition guard (Codex P2): COUNT the live, OSM-owned
   *  `road_segments` rows already inside `region`'s country polygon ∩ bbox —
   *  the EXACT scope `importRegion`/`importTile` reconciles (at this file's
   *  `TILE_SPAN_DEG` the region's sole tile bbox equals `region.bbox`, per the
   *  header note above) — and THROW if any exist. Called before any fixture
   *  is written (see `beforeAll`), so a non-zero count is always genuine
   *  collateral, never this spec's own rows; refusing to run protects that
   *  data instead of tombstoning it. Scoped to `osm_way_id IS NOT NULL AND
   *  deactivated_at IS NULL`: the exact candidate set `reconcile` itself loads
   *  (crowd-sourced and already-tombstoned rows are never reconcile
   *  candidates), so this can never false-positive on demo/seed data. */
  async function assertCleanScope(region: PoiImportRegion): Promise<void> {
    const { minLng, minLat, maxLng, maxLat } = region.bbox;
    const rows: Array<{ count: number }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM road_segments
       WHERE osm_way_id IS NOT NULL
         AND deactivated_at IS NULL
         AND ST_Intersects(geom, ST_GeomFromGeoJSON($1))
         AND ST_Intersects(geom, ST_MakeEnvelope($2, $3, $4, $5, 4326))`,
      [regionPolygon(region.code), minLng, minLat, maxLng, maxLat],
    );
    const count = rows[0]!.count;
    if (count > 0) {
      throw new Error(
        `osm-region-overlap-reconcile e2e requires a clean scope — found ` +
          `${count} pre-existing OSM road_segments in ${region.code}'s ` +
          `polygon ∩ bbox; run against a disposable DB with no imported OSM ` +
          `roads in this area.`,
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
    dir = await mkdtemp(join(tmpdir(), 'road-overlap-e2e-'));

    await deleteTrackedWays();
    await assertCleanScope(CZ);
    await assertCleanScope(SK);
  });

  afterAll(async () => {
    await deleteTrackedWays();
    await rm(dir, { recursive: true, force: true });
    await module?.close();
  });

  it('a later region does NOT tombstone an earlier region road in the bbox-overlap strip', async () => {
    // CZ extract: one road in the CZ∩SK strip, inside the CZ polygon.
    await writeFile(
      join(dir, soleTileFile(CZ)),
      osmDoc(wayXml(881001, 49.0, 17.5)),
    );
    // SK extract: one road well inside SK (its own country), far from the CZ road.
    await writeFile(
      join(dir, soleTileFile(SK)),
      osmDoc(wayXml(881002, 48.7, 19.5)),
    );

    // 1) CZ import inserts the overlap road; capture its id (identity to preserve).
    await service.importRegion(CZ, dir);
    const seeded = await segmentsForWay('881001');
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.deactivated_at).toBeNull();
    const czRoadId = seeded[0]!.id;

    // 2) SK import — SK's rectangle contains the CZ road (overlap strip), but the
    //    CZ road is OUTSIDE the SK polygon, so it must never be a stale candidate.
    const sk = await service.importRegion(SK, dir);
    expect(sk.upserted).toBe(1); // SK's own road imported

    // 3) The CZ road survives with its ORIGINAL id and still live. On the buggy
    //    rectangle scope, SK's bbox load picks it up and tombstones it → this fails.
    const after = await segmentsForWay('881001');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(czRoadId); // identity + history preserved
    expect(after[0]!.deactivated_at).toBeNull(); // still live
  }, 30_000);

  it('drops incoming rows outside the region polygon (border overhang in the per-country extract)', async () => {
    // Geofabrik ships COMPLETE ways, so cz.osm carries a bit of neighbouring SK
    // geometry that falls in CZ's rectangle but OUTSIDE the CZ polygon. The polygon
    // filter must keep the in-country road and drop the overhang, so re-importing
    // CZ never churns the neighbour's id.
    await writeFile(
      join(dir, soleTileFile(CZ)),
      osmDoc(
        wayXml(882001, 49.0, 17.5), // inside CZ polygon → kept
        wayXml(882003, 48.7, 17.5), // SK territory, in CZ rect but outside CZ polygon → dropped
      ),
    );

    await service.importRegion(CZ, dir);

    expect(await segmentsForWay('882001')).toHaveLength(1); // in-country road imported
    expect(await segmentsForWay('882003')).toHaveLength(0); // overhang dropped, not imported
  }, 30_000);
});
