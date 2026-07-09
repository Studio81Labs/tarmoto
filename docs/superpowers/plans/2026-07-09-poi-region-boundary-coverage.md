# Geometry-membership POI coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace point-proximity POI coverage with region-polygon membership so the store-first read's "is this request inside imported territory?" decision is exact (to the polygon's precision), removing the ~20 km border halo and the coverage-sampling machinery.

**Architecture:** A `poi_import_regions` table (in the POI PostGIS DB) holds a Natural Earth 1:50m boundary polygon per target country, gated by an importer-set `imported_at` stamp. Coverage becomes one PostGIS query — `ST_Covers(region_polygon, ST_Buffer(request_geometry))` — replacing `hasImportedCoverage(samples)` with `isRequestCovered(descriptor)`.

**Tech Stack:** NestJS 11, TypeORM (raw SQL, `@InjectDataSource('poi')`), PostgreSQL 16 + PostGIS 3.4, Node 24, pnpm. Boundary data: Natural Earth 1:50m admin-0 GeoJSON.

## Global Constraints

- POI DB is a **separate** PostGIS datasource, injected via `@InjectDataSource('poi')`; migrations live in `apps/backend/src/migrations-poi/` and are **schema-only** (data loads via scripts).
- Boundary polygons keyed by **ISO 3166-1 alpha-2** — the same codes `pois.import_region` and `DEFAULT_REGIONS[].code` use (17 target countries).
- Geometries are **SRID 4326**; server stores/serves **metric** only.
- **No new TypeORM entity** — coverage + loader use raw `dataSource.query(...)`.
- Validate: `pnpm exec jest src/modules/poi` (poi unit suites), `pnpm exec eslint "src/**/*.ts"` (backend CI lints specs too), `pnpm exec nest build --config nest-cli.openapi.json` (strict noUncheckedIndexedAccess). All run from `apps/backend/`.
- Commit style: conventional, lowercase subject, `scope=backend`, footer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Branch: `feat/poi-region-boundary-coverage` (already created from `main`).

## File Structure

- Create `apps/backend/src/migrations-poi/1800000000000-AddPoiImportRegions.ts` — table + GiST index.
- Create `apps/backend/src/scripts/derive-region-boundaries.mjs` — one-off generator (fetch NE, filter to 17 codes, write asset).
- Create `apps/backend/src/assets/import-region-boundaries.geojson` — committed FeatureCollection (generator output).
- Create `apps/backend/src/assets/README.md` — derivation note.
- Create `apps/backend/src/scripts/load-region-boundaries.ts` + `.spec.ts` — asset → DB loader + unit test.
- Modify `apps/backend/package.json`, root `package.json` — `poi:load-boundaries` command.
- Modify `apps/backend/src/modules/poi/poi-import.service.ts` (+ spec) — `imported_at` stamp.
- Modify `apps/backend/src/modules/poi/poi-store.service.ts` (+ spec) — `isRequestCovered`, remove `hasImportedCoverage`/`coverageChunkQuery`/`MAX_COVERAGE_SAMPLES`.
- Modify `apps/backend/src/modules/poi/poi.service.ts` (+ spec) — `readStoreFirst` descriptor + callers.
- Modify `apps/backend/src/modules/poi/poi-geo.ts` (+ spec) — remove `radiusCoverageSamples`/`routeCoverageSamples`/`segGeom`/`offsetKm`/`COVERAGE_BUFFER_KM`; keep `padBbox`/`Bbox`/`cumulativeLengthKm`/`projectOntoRoute` (still used elsewhere — verify).
- Create `apps/backend/test/poi-coverage.e2e-spec.ts` (or extend the existing poi integration harness) — DE-wedge halo regression against real PostGIS.

---

### Task 1: `poi_import_regions` table migration

**Files:**

- Create: `apps/backend/src/migrations-poi/1800000000000-AddPoiImportRegions.ts`
- Test: `apps/backend/src/migrations-poi/migration-registry.spec.ts` (existing — verifies every migration is registered/well-formed)

**Interfaces:**

- Produces: table `poi_import_regions (code varchar(2) PK, geom geometry(MultiPolygon,4326) NOT NULL, imported_at timestamptz NULL)` + GiST index `poi_import_regions_geom_gix`.

- [ ] **Step 1: Read an existing migration for the exact class/registration shape**

Read `apps/backend/src/migrations-poi/1799000000000-AddPoiGeographyIndex.ts` and `migration-registry.spec.ts` to copy the `MigrationInterface` class shape, the `name` convention, and how migrations are registered (the registry the spec checks).

- [ ] **Step 2: Write the migration**

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPoiImportRegions1800000000000 implements MigrationInterface {
  name = "AddPoiImportRegions1800000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "poi_import_regions" (
        "code" varchar(2) PRIMARY KEY,
        "geom" geometry(MultiPolygon, 4326) NOT NULL,
        "imported_at" timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "poi_import_regions_geom_gix"
        ON "poi_import_regions" USING GIST ("geom")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "poi_import_regions_geom_gix"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "poi_import_regions"`);
  }
}
```

- [ ] **Step 3: Register the migration** wherever `migration-registry.spec.ts` expects (mirror how `1799...` is registered — likely an array in a `migrations-poi` index/registry module).

- [ ] **Step 4: Run the registry spec + strict build**

Run: `cd apps/backend && pnpm exec jest src/migrations-poi/migration-registry.spec.ts && pnpm exec nest build --config nest-cli.openapi.json`
Expected: PASS / build OK.

- [ ] **Step 5: Apply + roll back once against a live DB to prove up/down**

Run: `pnpm db:up && pnpm db:migrate` then verify the table exists (`\d poi_import_regions`), then confirm `down` reverts cleanly (revert one migration). Expected: table + GiST index present, then gone.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations-poi/
git commit -m "feat(backend): add poi_import_regions table for geometry coverage (#944)"
```

---

### Task 2: Boundary asset (generate + commit)

**Files:**

- Create: `apps/backend/src/scripts/derive-region-boundaries.mjs`
- Create: `apps/backend/src/assets/import-region-boundaries.geojson`
- Create: `apps/backend/src/assets/README.md`

**Interfaces:**

- Produces: `import-region-boundaries.geojson` — a `FeatureCollection` where each feature has `properties.code` (ISO A2, one of the 17 `DEFAULT_REGIONS` codes) and a `MultiPolygon` geometry.

- [ ] **Step 1: List the 17 target codes** from `apps/backend/src/modules/poi/poi-import.config.ts` (`DEFAULT_REGIONS[].code`) — the generator filters to exactly these.

- [ ] **Step 2: Write the generator** (`derive-region-boundaries.mjs`)

Source: Natural Earth 1:50m admin-0 GeoJSON from the public mirror `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson`. Filter each feature to the target codes via `ISO_A2`, falling back to `ISO_A2_EH` when `ISO_A2 === '-99'`. Normalise every geometry to `MultiPolygon` (wrap a `Polygon` as a single-element `MultiPolygon`). Assert all 17 codes were found.

```javascript
// Run once: node apps/backend/src/scripts/derive-region-boundaries.mjs
// Requires network access; output is committed so runtime needs no network.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const NE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";

// Derive the target codes straight from the config so the asset can't drift from
// DEFAULT_REGIONS (a plain regex over the source avoids importing TS from .mjs).
const configSrc = readFileSync(
  join(here, "..", "modules", "poi", "poi-import.config.ts"),
  "utf8",
);
const CODES = new Set(
  [...configSrc.matchAll(/code:\s*'([A-Z]{2})'/g)].map((m) => m[1]),
);
if (CODES.size < 2) throw new Error("Failed to parse DEFAULT_REGIONS codes");

const iso2 = (props) =>
  props.ISO_A2 && props.ISO_A2 !== "-99" ? props.ISO_A2 : props.ISO_A2_EH;

const toMultiPolygon = (geom) =>
  geom.type === "MultiPolygon"
    ? geom
    : { type: "MultiPolygon", coordinates: [geom.coordinates] };

const res = await fetch(NE_URL);
if (!res.ok) throw new Error(`NE fetch failed: ${res.status}`);
const ne = await res.json();

const features = [];
const found = new Set();
for (const f of ne.features) {
  const code = iso2(f.properties);
  if (!CODES.has(code)) continue;
  found.add(code);
  features.push({
    type: "Feature",
    properties: { code },
    geometry: toMultiPolygon(f.geometry),
  });
}

const missing = [...CODES].filter((c) => !found.has(c));
if (missing.length)
  throw new Error(`Missing NE polygons for: ${missing.join(", ")}`);

const out = { type: "FeatureCollection", features };
const dest = join(here, "..", "assets", "import-region-boundaries.geojson");
writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${features.length} region polygons to ${dest}`);
```

- [ ] **Step 3: Run the generator + sanity-check the output**

Run: `mkdir -p apps/backend/src/assets && node apps/backend/src/scripts/derive-region-boundaries.mjs`
Expected: "Wrote 17 region polygons…". Then verify with `node -e "const g=require('./apps/backend/src/assets/import-region-boundaries.geojson'); console.log(g.features.length, g.features.every(f=>f.properties.code && f.geometry.type==='MultiPolygon'))"` → `17 true`. Confirm the file is `~104 KB` (`ls -lh`).

- [ ] **Step 4: Write the derivation note** (`assets/README.md`)

Record: source URL + NE version, the `ISO_A2`/`ISO_A2_EH` mapping, that it is filtered to `DEFAULT_REGIONS`, the generator path, and that regenerating requires re-running the generator + committing the output. State the licence (Natural Earth is public domain).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/scripts/derive-region-boundaries.mjs apps/backend/src/assets/
git commit -m "feat(backend): add Natural Earth boundary asset for POI coverage (#944)"
```

---

### Task 3: Boundary loader + `poi:load-boundaries` command

**Files:**

- Create: `apps/backend/src/scripts/load-region-boundaries.ts`
- Create: `apps/backend/src/scripts/load-region-boundaries.spec.ts`
- Modify: `apps/backend/package.json`, root `package.json`

**Interfaces:**

- Consumes: the `poi_import_regions` table (Task 1), the asset (Task 2), `bootstrapScriptContext()` (existing, in `apps/backend/src/scripts/bootstrap-script-context.ts`), and the POI `DataSource` (token `getDataSourceToken('poi')` from `@nestjs/typeorm`).
- Produces: `loadRegionBoundaries(ds: DataSource, features: {code:string; geometry:unknown}[]): Promise<number>` — upserts polygons, returns count; and a `main()` CLI wrapper.

- [ ] **Step 1: Read `import-pois.ts` fully** for the exact `bootstrapScriptContext()` usage and the app-shutdown pattern (`app.close()` in `finally`).

- [ ] **Step 2: Write the failing test** (`load-region-boundaries.spec.ts`)

```typescript
import { loadRegionBoundaries } from "./load-region-boundaries.js";

describe("loadRegionBoundaries", () => {
  it("upserts one row per feature with ST_GeomFromGeoJSON and ON CONFLICT keeping imported_at", async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const ds = { query } as unknown as import("typeorm").DataSource;
    const features = [
      { code: "CZ", geometry: { type: "MultiPolygon", coordinates: [] } },
      { code: "SK", geometry: { type: "MultiPolygon", coordinates: [] } },
    ];

    const n = await loadRegionBoundaries(ds, features);

    expect(n).toBe(2);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "poi_import_regions"');
    expect(sql).toContain("ST_GeomFromGeoJSON");
    expect(sql).toContain('ON CONFLICT ("code")');
    // Re-load must NOT reset imported_at.
    expect(sql).not.toContain("imported_at");
    expect(params[0]).toBe("CZ");
    expect(JSON.parse(params[1] as string)).toMatchObject({
      type: "MultiPolygon",
    });
  });

  it("rejects a feature whose code is not a 2-letter ISO code", async () => {
    const ds = { query: jest.fn() } as unknown as import("typeorm").DataSource;
    await expect(
      loadRegionBoundaries(ds, [{ code: "CZE", geometry: {} }]),
    ).rejects.toThrow(/2-letter/);
  });
});
```

- [ ] **Step 3: Run it — expect failure** (`loadRegionBoundaries` not defined)

Run: `cd apps/backend && pnpm exec jest src/scripts/load-region-boundaries.spec.ts`
Expected: FAIL (module/function not found).

- [ ] **Step 4: Implement `load-region-boundaries.ts`**

```typescript
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { bootstrapScriptContext } from "./bootstrap-script-context.js";
import { DEFAULT_REGIONS } from "../modules/poi/poi-import.config.js";

interface RegionFeature {
  code: string;
  geometry: unknown;
}

/** Upsert one polygon per feature. Idempotent; ON CONFLICT keeps imported_at so
 *  an already-imported region stays covered across a re-load. Returns the count. */
export async function loadRegionBoundaries(
  ds: DataSource,
  features: readonly RegionFeature[],
): Promise<number> {
  for (const f of features) {
    if (!/^[A-Z]{2}$/.test(f.code)) {
      throw new Error(
        `Region boundary code must be a 2-letter ISO code: ${f.code}`,
      );
    }
    await ds.query(
      `INSERT INTO "poi_import_regions" ("code", "geom")
       VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
       ON CONFLICT ("code") DO UPDATE SET "geom" = EXCLUDED."geom"`,
      [f.code, JSON.stringify(f.geometry)],
    );
  }
  return features.length;
}

function readAsset(): RegionFeature[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist layout mirrors src; the asset is copied to dist/assets at build (Step 6).
  const path = join(here, "..", "assets", "import-region-boundaries.geojson");
  const fc = JSON.parse(readFileSync(path, "utf8")) as {
    features: { properties: { code: string }; geometry: unknown }[];
  };
  return fc.features.map((f) => ({
    code: f.properties.code,
    geometry: f.geometry,
  }));
}

async function main(): Promise<void> {
  const features = readAsset();
  const targets = new Set(DEFAULT_REGIONS.map((r) => r.code));
  const present = new Set(features.map((f) => f.code));
  const missing = [...targets].filter((c) => !present.has(c));
  if (missing.length) {
    throw new Error(
      `Boundary asset missing target regions: ${missing.join(", ")}`,
    );
  }
  const app = await bootstrapScriptContext();
  try {
    const ds = app.get<DataSource>(getDataSourceToken("poi"));
    const n = await loadRegionBoundaries(ds, features);
    console.log(`Loaded ${n} region boundary polygons.`);
  } finally {
    await app.close();
  }
}

// Run as a CLI only (not when imported by the spec).
if (process.argv[1] && process.argv[1].endsWith("load-region-boundaries.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `cd apps/backend && pnpm exec jest src/scripts/load-region-boundaries.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire the commands + ensure the asset ships to `dist`**

In `apps/backend/package.json` scripts add `"poi:load-boundaries": "node dist/scripts/load-region-boundaries.js"`. Confirm the build copies `src/assets/*.geojson` to `dist/assets/` — check `nest-cli.json`'s `compilerOptions.assets` (or `tsconfig`); if `.geojson` isn't already copied, add `{"include":"assets/**/*","outDir":"dist"}` (or the repo's existing assets glob). In the root `package.json` add `"poi:load-boundaries": "pnpm shared:build && pnpm backend:build && pnpm --filter @tarmoto/backend poi:load-boundaries"` (mirror the existing `poi:import` passthrough).

- [ ] **Step 7: Smoke-test end-to-end** (needs `pnpm db:up` + migrated DB from Task 1)

Run: `pnpm poi:load-boundaries` then in psql: `SELECT code, ST_GeometryType(geom), imported_at FROM poi_import_regions ORDER BY code;`
Expected: 17 rows, `ST_MultiPolygon`, `imported_at` NULL. Re-run and confirm still 17 rows (idempotent).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/scripts/load-region-boundaries.ts apps/backend/src/scripts/load-region-boundaries.spec.ts apps/backend/package.json package.json apps/backend/nest-cli.json
git commit -m "feat(backend): load POI region boundary polygons into the store (#944)"
```

---

### Task 4: Importer `imported_at` stamp

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-import.service.ts` (in `importRegion`, after a successful write)
- Test: `apps/backend/src/modules/poi/poi-import.service.spec.ts`

**Interfaces:**

- Consumes: `poi_import_regions` table (Task 1); the import service's existing POI `DataSource`/repo access.
- Produces: on a successful (non-skipped) `importRegion`, `poi_import_regions.imported_at = now()` for that region code.

- [ ] **Step 1: Read `importRegion`** in `poi-import.service.ts` to find the success path (after the upsert/tombstone, before `return`) and how it reaches the DataSource/manager for a raw query.

- [ ] **Step 2: Write the failing test** — assert that a successful import stamps `imported_at`, and a skipped import (no extract) does NOT. Mock the manager/DataSource `query`; assert an `UPDATE "poi_import_regions" SET "imported_at" = now() WHERE "code" = $1` with the region code was issued on success and not on skip.

```typescript
it("stamps poi_import_regions.imported_at on a successful import", async () => {
  // …arrange a successful importRegion (extract present, rows upserted)…
  await service.importRegion(region);
  expect(managerQuery).toHaveBeenCalledWith(
    expect.stringContaining(
      'UPDATE "poi_import_regions" SET "imported_at" = now()',
    ),
    [region.code],
  );
});

it("does not stamp imported_at when the region is skipped (no extract)", async () => {
  // …arrange the skip path (no extract file)…
  await service.importRegion(region);
  expect(managerQuery).not.toHaveBeenCalledWith(
    expect.stringContaining("poi_import_regions"),
    expect.anything(),
  );
});
```

- [ ] **Step 3: Run it — expect failure.** Run: `pnpm exec jest src/modules/poi/poi-import.service.spec.ts` → FAIL.

- [ ] **Step 4: Implement the stamp** — on the success path of `importRegion`, after the writes, and ONLY when `this.importSource.source === 'osm'` (an FSQ-only region must not count as covered — coverage suppresses the OSM fallback), issue:

```typescript
await manager.query(
  `UPDATE "poi_import_regions" SET "imported_at" = now() WHERE "code" = $1`,
  [region.code],
);
```

Place it so the skip path (early `return { …, skipped: true }`) never reaches it. Use the same manager/DataSource the surrounding writes use.

- [ ] **Step 5: Run the test — expect pass**, plus the full import spec.

Run: `pnpm exec jest src/modules/poi/poi-import.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/poi/poi-import.service.ts apps/backend/src/modules/poi/poi-import.service.spec.ts
git commit -m "feat(backend): stamp region imported_at on successful POI import (#944)"
```

---

### Task 5: `isRequestCovered` coverage query (replaces `hasImportedCoverage`)

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-store.service.ts`
- Test: `apps/backend/src/modules/poi/poi-store.service.spec.ts`

**Interfaces:**

- Consumes: `poi_import_regions` (Task 1) + `imported_at` (Task 4); `withPoiRepo` (existing).
- Produces: exported type `CoverageDescriptor = { kind: 'radius'; lat: number; lng: number; radiusKm: number } | { kind: 'route'; route: readonly { lat: number; lng: number }[]; bufferKm: number }` and `PoiStoreService.isRequestCovered(descriptor: CoverageDescriptor): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (replace the whole `hasImportedCoverage` describe block)

```typescript
describe("isRequestCovered (#944)", () => {
  it("radius: ST_Covers over the buffered point, gated on imported_at, returns the EXISTS flag", async () => {
    repo.query.mockResolvedValueOnce([{ covered: true }]);
    const res = await service.isRequestCovered({
      kind: "radius",
      lat: 49.5,
      lng: 18.4,
      radiusKm: 25,
    });
    expect(res).toBe(true);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("poi_import_regions");
    expect(sql).toContain("r.imported_at IS NOT NULL");
    expect(sql).toContain("ST_Covers");
    expect(sql).toContain("ST_MakePoint");
    expect(sql).toContain("ST_Buffer");
    // lng, lat, radius metres.
    expect(params).toEqual([18.4, 49.5, 25000]);
  });

  it("route: buffers a [lng,lat] LineString passed as ONE GeoJSON text param", async () => {
    repo.query.mockResolvedValueOnce([{ covered: false }]);
    const res = await service.isRequestCovered({
      kind: "route",
      route: [
        { lat: 49, lng: 16 },
        { lat: 49.1, lng: 16.2 },
      ],
      bufferKm: 2,
    });
    expect(res).toBe(false);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ST_GeomFromGeoJSON");
    const line = JSON.parse(params[0] as string);
    expect(line.type).toBe("LineString");
    expect(line.coordinates).toEqual([
      [16, 49],
      [16.2, 49.1],
    ]); // [lng,lat]
    expect(params[1]).toBe(2000); // buffer metres
  });

  it("returns false for a non-finite descriptor without querying", async () => {
    const res = await service.isRequestCovered({
      kind: "radius",
      lat: Number.NaN,
      lng: 18,
      radiusKm: 5,
    });
    expect(res).toBe(false);
    expect(repo.query).not.toHaveBeenCalled();
  });

  it("treats a null/empty aggregate as not covered", async () => {
    repo.query.mockResolvedValueOnce([]);
    expect(
      await service.isRequestCovered({
        kind: "radius",
        lat: 49,
        lng: 18,
        radiusKm: 5,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure.** Run: `pnpm exec jest src/modules/poi/poi-store.service.spec.ts` → FAIL.

- [ ] **Step 3: Implement `isRequestCovered`** (and delete `hasImportedCoverage` + `coverageChunkQuery` + `MAX_COVERAGE_SAMPLES`)

```typescript
export type CoverageDescriptor =
  | { kind: 'radius'; lat: number; lng: number; radiusKm: number }
  | { kind: 'route'; route: readonly { lat: number; lng: number }[]; bufferKm: number };

// inside PoiStoreService:
async isRequestCovered(descriptor: CoverageDescriptor): Promise<boolean> {
  const built = buildCoverageRequest(descriptor);
  if (built === null) return false; // non-finite / empty → not covered, no query
  const { requestSql, params } = built;
  const sql = `
    SELECT EXISTS (
      SELECT 1 FROM poi_import_regions r
      WHERE r.imported_at IS NOT NULL
        AND ST_Covers(r.geom, ${requestSql})
    ) AS covered`;
  return withPoiRepo(this.poiDataSource, async (repo) => {
    const rows = await repo.query<{ covered: boolean | null }[]>(sql, params);
    return rows[0]?.covered === true;
  });
}
```

Module-level builder (place near the top, beside the old helpers you're deleting).
`requestSql` is the FULL buffered-request geometry (buffer baked in with its own
`$` placeholder), so `isRequestCovered` just drops it into `ST_Covers` — no
index juggling. Buffer distance is metric metres (`km * 1000`); `ST_Buffer` on
`geography` measures in metres, then casts back to geometry for `ST_Covers`.

```typescript
function isFiniteLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/** Full request-geometry SQL (buffered disc/corridor) + its positional params,
 *  or null for a degenerate/invalid descriptor → treat as uncovered. */
function buildCoverageRequest(
  d: CoverageDescriptor,
): { requestSql: string; params: (string | number)[] } | null {
  if (d.kind === "radius") {
    if (!isFiniteLatLng(d.lat, d.lng) || !Number.isFinite(d.radiusKm))
      return null;
    return {
      requestSql:
        "ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry",
      params: [d.lng, d.lat, Math.max(0, d.radiusKm) * 1000],
    };
  }
  const pts = d.route.filter((p) => isFiniteLatLng(p.lat, p.lng));
  if (pts.length === 0 || !Number.isFinite(d.bufferKm)) return null;
  // GeoJSON is [lng,lat]; a LineString needs >= 2 positions — duplicate a lone
  // point so a single-vertex route still buffers to a disc.
  const coords = pts.map((p) => [p.lng, p.lat]);
  if (coords.length === 1) coords.push(coords[0]!);
  const line = JSON.stringify({ type: "LineString", coordinates: coords });
  return {
    requestSql:
      "ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry",
    params: [line, Math.max(0, d.bufferKm) * 1000],
  };
}
```

- [ ] **Step 4: Run the tests — expect pass.** Run: `pnpm exec jest src/modules/poi/poi-store.service.spec.ts` → PASS.

- [ ] **Step 5: eslint + strict build.** Run: `pnpm exec eslint "src/**/*.ts" && pnpm exec nest build --config nest-cli.openapi.json` → clean / OK.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/poi/poi-store.service.ts apps/backend/src/modules/poi/poi-store.service.spec.ts
git commit -m "feat(backend): region-polygon membership coverage query (#944)"
```

---

### Task 6: `readStoreFirst` descriptor + callers

**Files:**

- Modify: `apps/backend/src/modules/poi/poi.service.ts`
- Test: `apps/backend/src/modules/poi/poi.service.spec.ts`

**Interfaces:**

- Consumes: `PoiStoreService.isRequestCovered` + `CoverageDescriptor` (Task 5).
- Produces: `readStoreFirst<T>(fromStore, fromProvider, coverage?: CoverageDescriptor)`; `isCovered` calls `store.isRequestCovered`.

- [ ] **Step 1: Update the service-spec store mock** — replace `hasImportedCoverage` with `isRequestCovered: jest.fn().mockResolvedValue(false)`; keep the existing frontier tests (covered→true, uncovered→false, outage→false) but they now toggle `isRequestCovered`.

- [ ] **Step 2: Run the spec — expect failure** (mock/method mismatch). Run: `pnpm exec jest src/modules/poi/poi.service.spec.ts` → FAIL.

- [ ] **Step 3: Implement** — change `readStoreFirst`'s third param to `coverage?: CoverageDescriptor`; `isCovered(coverage)` calls `await this.store.isRequestCovered(coverage)` inside the existing try/catch (outage → false). Update the three callers:

```typescript
// nearby (findPointsOfInterestNear) and accommodations (findAccommodationsNear):
{ kind: 'radius', lat, lng, radiusKm: radius }
// along-route (findPointsOfInterestAlongRoute):
{ kind: 'route', route: dto.route, bufferKm }
```

Import `CoverageDescriptor` from `./poi-store.service.js`. Remove the `radiusCoverageSamples`/`routeCoverageSamples` imports from this file.

- [ ] **Step 4: Run the spec — expect pass.** Run: `pnpm exec jest src/modules/poi/poi.service.spec.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/poi/poi.service.ts apps/backend/src/modules/poi/poi.service.spec.ts
git commit -m "feat(backend): pass coverage descriptors through readStoreFirst (#944)"
```

---

### Task 7: Remove the obsolete sampling machinery

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-geo.ts`, `apps/backend/src/modules/poi/poi-geo.spec.ts`

**Interfaces:**

- Removes: `radiusCoverageSamples`, `routeCoverageSamples`, `segGeom`, `offsetKm`, `COVERAGE_BUFFER_KM`. Keeps: `cumulativeLengthKm`, `projectOntoRoute`, `Bbox`, `padBbox` **iff still referenced**.

- [ ] **Step 1: Grep for remaining references**

Run: `cd apps/backend && grep -rn "radiusCoverageSamples\|routeCoverageSamples\|COVERAGE_BUFFER_KM\|segGeom\|offsetKm" src | grep -v poi-geo`
Expected: no matches (Tasks 5–6 removed the callers). If any remain, fix them first.

- [ ] **Step 2: Check `padBbox` / `Bbox` usage**

Run: `grep -rn "padBbox\|\bBbox\b" src | grep -v poi-geo.spec`
If unused outside `poi-geo`, delete them too; if still used (e.g. `findInBbox`), keep.

- [ ] **Step 3: Delete the obsolete exports + their `poi-geo.spec.ts` describe blocks** (`radiusCoverageSamples`, `routeCoverageSamples`, `COVERAGE_BUFFER_KM`, and any now-unused private helpers). Leave the still-used geometry helpers and their tests intact.

- [ ] **Step 4: Full poi suite + eslint + strict build**

Run: `pnpm exec jest src/modules/poi && pnpm exec eslint "src/**/*.ts" && pnpm exec nest build --config nest-cli.openapi.json`
Expected: all pass, 0 eslint errors, build OK, no unused-import/dead-code lint.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/poi/poi-geo.ts apps/backend/src/modules/poi/poi-geo.spec.ts
git commit -m "refactor(backend): drop proximity coverage sampling superseded by geometry membership (#944)"
```

---

### Task 8: Integration regression — the DE-wedge halo

**Files:**

- Create/extend: the POI integration/e2e harness that runs against real PostGIS (find it: `grep -rln "poi" apps/backend/test 2>/dev/null` or the existing store integration spec). If none targets the POI DB, add `apps/backend/test/poi-coverage.e2e-spec.ts` following the nearest existing e2e that uses a real DB.

**Interfaces:**

- Consumes: everything above, against a live migrated + boundary-loaded POI DB.

- [ ] **Step 1: Write the regression test** — seed `poi_import_regions` with CZ's real polygon (from the asset) and `imported_at = now()`; seed a handful of `pois` rows inside CZ. Then:
  - A `radius` request centred **inside CZ** → `isRequestCovered` true.
  - A `radius` request centred in the **German wedge that lies inside CZ's bounding box but outside CZ's polygon** (e.g. a point just west of the CZ border) → `isRequestCovered` **false** (the halo the old proximity probe got wrong).
  - A `route` from inside CZ crossing into that wedge → false; a route fully inside CZ → true.
  - A region with `imported_at = NULL` → its polygon never covers.

- [ ] **Step 2: Run it** against `pnpm db:up` + migrated + loaded DB.

Run: `cd apps/backend && pnpm exec jest --config <e2e-config> test/poi-coverage.e2e-spec.ts`
Expected: PASS — the wedge point is NOT covered.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/test/poi-coverage.e2e-spec.ts
git commit -m "test(backend): geometry-coverage halo regression against real PostGIS (#944)"
```

---

## Final validation (before PR)

- [ ] `cd apps/backend && pnpm exec jest src/modules/poi` — all poi unit suites pass.
- [ ] `pnpm exec eslint "src/**/*.ts"` — 0 errors.
- [ ] `pnpm exec nest build --config nest-cli.openapi.json` — strict build OK.
- [ ] `grep -rn "hasImportedCoverage\|coverageSamples\|MAX_COVERAGE_SAMPLES" src` — no matches (fully removed).
- [ ] Manual: `pnpm db:up && pnpm db:migrate && pnpm poi:load-boundaries` → 17 rows; run a real `poi:import CZ` → CZ `imported_at` stamped.
- [ ] PR against `main`, `Closes #944`, scope `backend`, with the DE-wedge regression as the headline evidence.
