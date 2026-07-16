import { Test, type TestingModule } from "@nestjs/testing";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PoiImportRegion } from "@tarmoto/ingest";
import { AppModule } from "../src/app.module.js";
import { PoiImportService } from "../src/poi/poi-import.service.js";

/**
 * Real-Postgres proof that the POI import engine still works after the T5
 * move into apps/ingest (verbatim `git mv` of `PoiImportService` + its DI
 * wiring). Boots the REAL `apps/ingest` `AppModule` — including the migrator
 * `PoiDatabaseModule` (`migrationsRun: true`) — the same
 * `Test.createTestingModule({ imports: [AppModule] }).compile()` shape as
 * the backend's own `app.e2e-spec.ts` / `poi-coverage.e2e-spec.ts`.
 *
 * Prerequisite: `pnpm db:up` (real PostGIS on `TARMOTO_POI_DATABASE_*`,
 * defaulting to the docker-compose `poi-postgres` service).
 *
 * `TARMOTO_QUEUE_WORKER_ENABLED=false` is set in `test/jest-e2e.setup.ts`
 * (a Jest `setupFiles` entry), not here: `PoiJobsModule`'s worker/scheduler
 * gate is a plain top-level `const` read once when that module is first
 * required, which happens as soon as this file's own static `import {
 * AppModule }` above is evaluated — Jest hoists that above any assignment
 * a `beforeAll` (or even top-level code later in this file) could make, and
 * a genuine dynamic `import()` here hits ts-jest/Jest's CommonJS-sandbox
 * limitation ("a dynamic import callback was invoked without
 * --experimental-vm-modules"). `setupFiles` runs before this file's module
 * graph loads at all, so it's the one hook early enough to matter.
 *
 * ## Why a synthetic region/bbox instead of the real `CZ`
 *
 * A local/shared dev POI DB can already carry a real, substantial OSM import
 * (thousands of rows). `importRegion` for the real `CZ` region would load
 * every existing `source='osm'` row inside CZ's real (whole-country) bbox as
 * a tombstone CANDIDATE — a one-node test fixture would then look like a
 * near-total wipe of that pre-existing data. The tombstone wipe-guard
 * (`MAX_TOMBSTONE_FRACTION`) would prevent the actual deletes, but it ALSO
 * withholds the coverage stamp on trip, so the test would flakily pass or
 * fail purely based on how much real data happens to be sitting in the
 * shared DB — and worse, on a DB where the guard's row-count floor isn't
 * met, it would truly tombstone real rows.
 *
 * Instead this test imports a region under a synthetic 2-letter code ('Z9',
 * never a real ISO code / never in `DEFAULT_REGIONS`) with a bbox in the
 * middle of the Pacific ocean — verified empty of any pre-existing `pois`
 * row — so the test is fully isolated from whatever real data the shared DB
 * holds, while still exercising the real upsert + bbox-bounded tombstone +
 * coverage-stamp code path end-to-end. `PoiImportService.importRegion`
 * accepts any `{ code, bbox }` `PoiImportRegion` directly — it does not
 * require the region to be one of `this.config.regions` — so this is a
 * legitimate call shape, not a workaround.
 */
describe("apps/ingest POI import (real PG)", () => {
  let app: TestingModule;
  const dir = mkdtempSync(join(tmpdir(), "poi-e2e-"));

  // Uninhabited-by-data bbox (mid-Pacific) — confirmed via the shared dev POI
  // DB to hold zero existing `pois` rows before writing this test. 'Z9' is
  // not a real ISO code (never appears in `DEFAULT_REGIONS`), so it can't
  // collide with a real `poi_import_regions` row either.
  const TEST_REGION: PoiImportRegion = {
    code: "Z9",
    bbox: { minLng: -150.1, minLat: -0.1, maxLng: -149.9, maxLat: 0.1 },
  };
  const FRESH_EXTERNAL_ID = "osm:node:1"; // in the fixture extract → upserted
  const STALE_EXTERNAL_ID = "osm:node:999"; // pre-seeded, absent from the extract → tombstoned

  beforeAll(async () => {
    process.env.TARMOTO_POI_IMPORT_DIR = dir;

    // Minimal single-node `.osm` extract inside TEST_REGION's bbox. Filename
    // must match `<code>.osm` (lower-cased) — `OsmPoiImportSource`'s
    // resolver.
    writeFileSync(
      join(dir, "z9.osm"),
      `<?xml version="1.0"?><osm version="0.6">` +
        `<node id="1" lat="0.0" lon="-150.0"><tag k="amenity" v="restaurant"/>` +
        `<tag k="name" v="E2E Diner"/></node></osm>`,
    );

    app = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const ds = app.get<DataSource>(getDataSourceToken("poi"));

    // Seed the coverage-stamp target: a `poi_import_regions` row for the
    // synthetic code, not yet imported. The geometry only needs to be valid
    // (the stamp UPDATE keys off `code`, not `geom`) — it covers the same
    // test bbox for good measure.
    await ds.query(
      `INSERT INTO poi_import_regions (code, geom, imported_at)
       VALUES ($1, ST_GeomFromText($2, 4326), NULL)
       ON CONFLICT (code) DO UPDATE SET imported_at = NULL`,
      [
        TEST_REGION.code,
        "MULTIPOLYGON(((-150.1 -0.1, -149.9 -0.1, -149.9 0.1, -150.1 0.1, -150.1 -0.1)))",
      ],
    );

    // Seed a pre-existing "stale" POI inside the bbox, owned by this test
    // region, absent from the fixture extract above — the import must
    // soft-tombstone it (`deactivated_at` set), never delete it.
    await ds.query(
      `INSERT INTO pois
         (source, external_id, kind, name, geom, last_imported_at, deactivated_at, import_region)
       VALUES ('osm', $1, 'restaurant', 'Stale Diner',
         ST_SetSRID(ST_MakePoint(-150.05, 0.02), 4326), now(), NULL, $2)
       ON CONFLICT (source, external_id) DO UPDATE
         SET deactivated_at = NULL, import_region = EXCLUDED.import_region`,
      [STALE_EXTERNAL_ID, TEST_REGION.code],
    );
  }, 30_000);

  afterAll(async () => {
    if (app) {
      const ds = app.get<DataSource>(getDataSourceToken("poi"));
      await ds.query(`DELETE FROM pois WHERE import_region = $1`, [
        TEST_REGION.code,
      ]);
      await ds.query(`DELETE FROM poi_import_regions WHERE code = $1`, [
        TEST_REGION.code,
      ]);
      await app.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts the fresh row, tombstones the stale one, and stamps region coverage", async () => {
    const svc = app.get(PoiImportService);

    const result = await svc.importRegion(TEST_REGION);

    expect(result.skipped).toBeUndefined();
    expect(result.warning).toBeNull();
    expect(result.upserted).toBeGreaterThanOrEqual(1);
    expect(result.tombstoned).toBeGreaterThanOrEqual(1);

    const ds = app.get<DataSource>(getDataSourceToken("poi"));

    const [fresh] = await ds.query<{ deactivated_at: Date | null }[]>(
      `SELECT deactivated_at FROM pois WHERE source = 'osm' AND external_id = $1`,
      [FRESH_EXTERNAL_ID],
    );
    expect(fresh?.deactivated_at ?? null).toBeNull();

    const [stale] = await ds.query<{ deactivated_at: Date | null }[]>(
      `SELECT deactivated_at FROM pois WHERE source = 'osm' AND external_id = $1`,
      [STALE_EXTERNAL_ID],
    );
    expect(stale?.deactivated_at).toBeTruthy();

    const [region] = await ds.query<{ imported_at: Date | null }[]>(
      `SELECT imported_at FROM poi_import_regions WHERE code = $1`,
      [TEST_REGION.code],
    );
    expect(region?.imported_at).toBeTruthy();
  });
});
