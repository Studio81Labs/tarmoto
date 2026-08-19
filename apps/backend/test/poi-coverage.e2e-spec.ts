import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { PoiDataSource } from '@tarmoto/poi-db';
import { PoiStoreService } from '../src/modules/poi/poi-store.service.js';

/**
 * Issue #944 — POI import coverage moved from a point-PROXIMITY probe (#925:
 * `bool_and(EXISTS(...))` over rim/rail sample points near already-imported
 * `pois` rows) to region-polygon MEMBERSHIP
 * (`ST_Covers(region_polygon, buffered_request)` against `poi_import_regions`,
 * gated on `imported_at IS NOT NULL`). The old sample-probe's point-radius shape
 * reported a point inside an imported country's bounding BOX — but outside its
 * actual polygon — as "covered": the border halo. This test proves the new
 * `PoiStoreService.isRequestCovered` query does NOT, by seeding
 * `poi_import_regions` with the REAL CZ + DE polygons from the committed
 * boundary asset (`src/assets/import-region-boundaries.geojson`) and driving
 * `isRequestCovered` directly against real PostGIS.
 *
 * `isRequestCovered` reads ONLY `poi_import_regions` (`geom` + `imported_at`) —
 * it never touches the `pois` table — so no POI rows need seeding here.
 *
 * Seeded under the test-only codes 'Z1' / 'Z2', not the real 'CZ' / 'DE'
 * primary keys: the dev POI DB already carries a shared 17-region boundary
 * seed (`pnpm poi:load-boundaries`) under the real ISO codes, and a real
 * `poi:import` run may stamp `imported_at` on those rows independently of this
 * test. Reusing (and then deleting) those primary keys in cleanup would
 * corrupt that shared seed for any other workflow reading the same DB. 'Z1' /
 * 'Z2' carry the identical real-world polygons (read straight from the
 * committed asset), so the geometry under test is exactly the same either way.
 *
 * Distinct primary keys alone are NOT enough isolation: `isRequestCovered`'s
 * query is table-wide (`ST_Covers(ST_Union(geom) OVER all imported regions the
 * request intersects, request)`, no `code` filter — see `poi-store.service.ts`),
 * so it matches ANY imported region row, not just this test's 'Z1'. A real
 * `poi:import DE` against this same shared dev DB would stamp the real 'DE'
 * row's `imported_at`, silently flipping the DE-wedge / route-into-wedge /
 * unimported-region assertions below from false to true. `beforeAll`
 * neutralizes this by snapshotting every existing row's `imported_at`, then
 * nulling the whole table before seeding 'Z1'/'Z2' — so 'Z1' is the ONLY
 * imported region for the run regardless of the shared DB's real state.
 * `afterAll` restores every snapshotted value exactly.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate:poi` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('poi coverage: region-polygon membership, not proximity (#944)', () => {
  let module: TestingModule;
  let service: PoiStoreService;
  let dataSource: DataSource;
  // Every OTHER region row's `imported_at` at test start, captured by
  // `beforeAll` before it neutralizes the table (see the file doc comment
  // above). Stays `undefined` if `beforeAll` fails before the snapshot query
  // completes, so `afterAll` can tell "never captured" apart from "captured,
  // table was empty" and skip the restore loop instead of restoring nothing.
  let importedAtSnapshot:
    { code: string; imported_at: Date | null }[] | undefined;

  // Test-only region codes carrying the real CZ / DE polygons — see the file
  // doc-comment for why these aren't the real 'CZ' / 'DE' primary keys.
  const CZ_TEST_CODE = 'Z1'; // imported_at = now() (an imported region)
  const DE_TEST_CODE = 'Z2'; // imported_at = NULL (never imported)
  const SK_TEST_CODE = 'Z3'; // imported_at = now() — CZ's imported neighbour

  // Real-world lat/lng points, empirically checked against the committed
  // boundary asset via ST_Covers / ST_Envelope before this test was written.
  const PRAGUE = { lat: 50.08, lng: 14.42 }; // inside CZ's actual polygon
  const BRNO = { lat: 49.2, lng: 16.6 }; // also inside CZ's actual polygon
  // Just west of Dresden: inside CZ's BOUNDING BOX (real envelope maxLat ≈
  // 51.038) but OUTSIDE CZ's actual polygon boundary — German soil (confirmed
  // ST_Covers(DE_geom, point) = true) that the old bbox/proximity probe wrongly
  // reported as CZ-covered. This is the border halo.
  const DE_WEDGE = { lat: 51.02, lng: 13.74 };
  const BERLIN = { lat: 52.52, lng: 13.405 }; // deep inside DE's actual polygon
  // Interior NW Slovakia — well away from the SK/AT/HU borders, so a buffered
  // Brno→Žilina corridor stays inside CZ∪SK (Bratislava, on the AT/HU border,
  // would spill a 2 km buffer into un-imported territory). Verified via psql.
  const ZILINA = { lat: 49.22, lng: 18.74 }; // inside SK's actual polygon

  /** Read one region's real GeoJSON geometry (by ISO code) out of the
   *  committed boundary asset — the same file `poi:load-boundaries` loads. */
  function readRegionGeometry(isoCode: string): unknown {
    const path = join(
      __dirname,
      '..',
      'src',
      'assets',
      'import-region-boundaries.geojson',
    );
    const fc = JSON.parse(readFileSync(path, 'utf8')) as {
      features: { properties: { code: string }; geometry: unknown }[];
    };
    const feature = fc.features.find((f) => f.properties.code === isoCode);
    if (!feature) {
      throw new Error(`Boundary asset missing region: ${isoCode}`);
    }
    return feature.geometry;
  }

  /** Upsert a `poi_import_regions` row under `testCode`, using `isoCode`'s real
   *  polygon from the asset, stamped `imported_at = now()` or left NULL. */
  async function seedRegion(
    testCode: string,
    isoCode: string,
    imported: boolean,
  ): Promise<void> {
    const geometry = readRegionGeometry(isoCode);
    await dataSource.query(
      `INSERT INTO poi_import_regions (code, geom, imported_at)
       VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), ${
         imported ? 'now()' : 'NULL'
       })
       ON CONFLICT (code) DO UPDATE
         SET geom = EXCLUDED.geom, imported_at = EXCLUDED.imported_at`,
      [testCode, JSON.stringify(geometry)],
    );
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ ...PoiDataSource.options, name: 'poi' }),
      ],
      providers: [PoiStoreService],
    }).compile();
    service = module.get(PoiStoreService);
    dataSource = module.get<DataSource>(getDataSourceToken('poi'));

    // `isRequestCovered` is table-wide (see the file doc comment) — snapshot
    // every real row's `imported_at` so `afterAll` can restore it exactly,
    // then null the whole table so the seed below is the only imported
    // region for the duration of this run, regardless of what a real
    // `poi:import` has stamped on the shared dev DB.
    importedAtSnapshot = await dataSource.query<
      { code: string; imported_at: Date | null }[]
    >(`SELECT code, imported_at FROM poi_import_regions`);
    await dataSource.query(`UPDATE poi_import_regions SET imported_at = NULL`);

    await seedRegion(CZ_TEST_CODE, 'CZ', true);
    await seedRegion(DE_TEST_CODE, 'DE', false);
    await seedRegion(SK_TEST_CODE, 'SK', true); // CZ's imported neighbour
  }, 30_000);

  afterAll(async () => {
    // Optional-chained: if `beforeAll` threw before `dataSource` was
    // assigned, let that original error surface instead of masking it behind
    // a secondary TypeError from calling `.query` on `undefined`.
    await dataSource?.query(
      `DELETE FROM poi_import_regions WHERE code IN ($1, $2, $3)`,
      [CZ_TEST_CODE, DE_TEST_CODE, SK_TEST_CODE],
    );
    // Skip when the snapshot was never captured (`beforeAll` failed before or
    // during that query) — there is nothing to restore.
    if (importedAtSnapshot) {
      for (const { code, imported_at } of importedAtSnapshot) {
        await dataSource?.query(
          `UPDATE poi_import_regions SET imported_at = $2 WHERE code = $1`,
          [code, imported_at],
        );
      }
    }
    await module?.close();
  });

  it('covers a radius request centred inside the imported CZ region', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'radius',
        lat: PRAGUE.lat,
        lng: PRAGUE.lng,
        radiusKm: 5,
      }),
    ).resolves.toBe(true);
  });

  it('does NOT cover a radius request in the DE wedge — inside the CZ bbox, outside the CZ polygon (the halo, gone)', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'radius',
        lat: DE_WEDGE.lat,
        lng: DE_WEDGE.lng,
        radiusKm: 5,
      }),
    ).resolves.toBe(false);
  });

  it('does NOT cover a route that crosses from inside CZ into the DE wedge', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'route',
        route: [PRAGUE, DE_WEDGE],
        bufferKm: 2,
      }),
    ).resolves.toBe(false);
  });

  it('covers a route that stays entirely inside CZ', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'route',
        route: [PRAGUE, BRNO],
        bufferKm: 2,
      }),
    ).resolves.toBe(true);
  });

  it('covers a cross-border route between two imported regions via the polygon UNION (#944 review)', async () => {
    // Brno (CZ) → Žilina (SK), both imported. No single country polygon contains
    // the whole corridor, but the UNION of the intersecting imported regions
    // does — so it is covered. (The old single-region `ST_Covers` would have
    // returned false here and merged Overpass unnecessarily.)
    await expect(
      service.isRequestCovered({
        kind: 'route',
        route: [BRNO, ZILINA],
        bufferKm: 2,
      }),
    ).resolves.toBe(true);
  });

  it('does NOT cover a cross-border route when only one side is imported', async () => {
    // Brno (CZ, imported) → the DE wedge (DE is seeded imported_at NULL). The
    // union covers only the CZ side, so the corridor is not fully covered.
    await expect(
      service.isRequestCovered({
        kind: 'route',
        route: [BRNO, DE_WEDGE],
        bufferKm: 2,
      }),
    ).resolves.toBe(false);
  });

  it('never covers a region whose imported_at is NULL, even deep inside its real polygon', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'radius',
        lat: BERLIN.lat,
        lng: BERLIN.lng,
        radiusKm: 5,
      }),
    ).resolves.toBe(false);
  });

  it('resolves a zero-length / coincident-point route without throwing (buffers to a disc — #944 Task 5/6 review gap)', async () => {
    await expect(
      service.isRequestCovered({
        kind: 'route',
        route: [PRAGUE, PRAGUE],
        bufferKm: 2,
      }),
    ).resolves.toBe(true);
  });
});
