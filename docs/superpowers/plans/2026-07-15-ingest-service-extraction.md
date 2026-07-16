# apps/ingest Service Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a dedicated NestJS `apps/ingest` service that owns the entire automated POI write path (extract + scheduled import) and the POI-DB schema, leaving `apps/backend` a read-only consumer plus a thin admin front-door.

**Architecture:** Phase 2 of the POI-ingestion extraction (builds on Phase 1's `@tarmoto/ingest` contract hoist, PR #1001). The POI schema (entities + migrations + DataSource factory) moves into a new `@tarmoto/poi-db` package consumed by both apps; the pure mappers/parsers + the `poi.import` queue constants move into the existing `@tarmoto/ingest` library; the DB-coupled import engine (service + processor + scheduler + recorder + CLIs) moves wholly into `apps/ingest`. The seam between the two apps is the existing BullMQ `poi.import` queue over shared Redis + the shared `/data/poi-extracts` volume — the backend enqueues, `apps/ingest` processes.

**Tech Stack:** Node 24+, pnpm 11 workspaces, NestJS 11, TypeORM 0.3.28 + PostGIS, BullMQ 5 on Redis, TypeScript strict (NodeNext ESM), Vitest (packages) / Jest (apps), Docker (Debian base carrying osmium-tool + duckdb), GitHub Actions + Coolify API deploys.

## Global Constraints

_(Every task's requirements implicitly include this section. Values are exact.)_

- Three distinct names: **`@tarmoto/ingest`** (existing pure lib, grows), **`@tarmoto/poi-db`** (NEW TypeORM schema pkg), **`@tarmoto/ingest-service`** (NEW NestJS app at `apps/ingest`).
- **Zero behaviour change on moved code** — verbatim relocation, no logic edits; compiler + existing tests (now resolving to new homes) verify. Only import paths change (+ prettier reformat).
- **Seam = the existing BullMQ `poi.import` queue.** Import engine lives wholly in `apps/ingest`; backend keeps only the queue **producer** + a slimmed admin front-door + POI **reads**.
- **Schema ownership:** `apps/ingest` runs POI `migrationsRun: true`; backend flips to `migrationsRun: false`, reads only, tolerant of an ahead schema.
- CJS packages mirror `@tarmoto/shared` (no `"type"`, `main`/`types`, no `exports`, Vitest). `@tarmoto/poi-db` additionally needs `typeorm` + `pg` + `reflect-metadata` runtime deps and `experimentalDecorators`+`emitDecoratorMetadata` in its tsconfig (TypeORM entity decorators).
- **No OpenAPI/mobile/companion contract change** — `pnpm openapi:gen` stays exit 0 and the generated spec/client BYTE-IDENTICAL after every task (no controller/DTO moves).
- POI migration list lives in ONE home (`@tarmoto/poi-db`), consumed by both the runtime TypeORM factory and the CLI DataSource; keep the `migration-registry`-style guard pointed at that home.
- Conventional commits; scope `cross`/`backend`/`ingest`/`infra` as apt; lowercase subject; `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Cross-cutting invariants for every non-docs task's gate:**

- `pnpm openapi:gen` exits 0 **and** `git status --porcelain packages/openapi` prints nothing (generated spec + clients byte-identical). No POI controller/DTO moves in any task, so this must always hold.
- `tsconfig.base.json` is `NodeNext` ESM — all relative imports carry the `.js` extension. It does **not** set `experimentalDecorators`/`emitDecoratorMetadata`; apps set them in their own tsconfig, and `@tarmoto/poi-db` must add them (T1).
- The migration timestamps in play are the 8 POI migrations `1787000000000-AddPois` … `1803000000000-AddPoiImportRunWarning`.

**Migration-cutover ordering (load-bearing across T2→T5):** The backend keeps `migrationsRun: true` for the POI DB through T2, **T3, and T4** so the schema is never orphaned while `apps/ingest` does not yet exist as a migrator. Only in **T5** — the task that stands up `apps/ingest` as the POI-DB owner — does the backend flip to `migrationsRun: false` and `apps/ingest` take `migrationsRun: true`. Deploy order at cutover: `apps/ingest` first (applies pending POI migrations), then the slimmed backend.

---

### Task 1: Scaffold `@tarmoto/poi-db` (empty package)

Stands up the new TypeORM-aware schema package as an empty, buildable shell that T2 fills. Cloning the `@tarmoto/ingest` package pattern but adding the DB runtime deps + decorator tsconfig flags the entities will need.

**Files:**

- Create: `packages/poi-db/package.json`
- Create: `packages/poi-db/tsconfig.json`
- Create: `packages/poi-db/vitest.config.ts`
- Create: `packages/poi-db/src/index.ts`
- Test: `packages/poi-db/src/index.spec.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: the `@tarmoto/poi-db` package shell — an installed workspace package whose `pnpm --filter @tarmoto/poi-db build` succeeds and whose barrel `src/index.ts` T2 will populate. Runtime deps present: `typeorm@^0.3.28`, `pg@^8.20.0`, `reflect-metadata@^0.2.2`, `geojson@^0.5.0`.

**Notes on decisions:**

- `tsconfig.base.json` does NOT set `experimentalDecorators`/`emitDecoratorMetadata` (verified), so this tsconfig adds both — the entities T2 moves in are decorated.
- `@types/pg` is NOT a backend dependency (pg types ship via typeorm), so it is omitted here to mirror the backend.
- `@nestjs/config` + `@nestjs/typeorm` are NOT added here — they arrive in T2 with `poiDatabaseConfig` / `buildPoiTypeOrmOptions`.
- Vitest `setupFiles: ['reflect-metadata']` so entity-decorator metadata is available when T2's entity/guard specs run.

- [ ] **Step 1: Write the failing test**

Create `packages/poi-db/src/index.spec.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as poiDb from "./index.js";

describe("@tarmoto/poi-db barrel", () => {
  it("is importable (shell in place; T2 populates it)", () => {
    expect(poiDb).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/poi-db test`
Expected: FAIL — pnpm errors with `No projects matched the filters` (the package does not exist yet).

- [ ] **Step 3: Create the package files**

`packages/poi-db/package.json`:

```json
{
  "name": "@tarmoto/poi-db",
  "version": "0.0.1",
  "description": "POI database schema for Tarmoto (TypeORM entities, migrations, DataSource factory)",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "geojson": "^0.5.0",
    "pg": "^8.20.0",
    "reflect-metadata": "^0.2.2",
    "typeorm": "^0.3.28"
  },
  "devDependencies": {
    "@types/geojson": "^7946.0.16",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.2",
    "vitest": "^4.1.5"
  }
}
```

`packages/poi-db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts", "src/**/*.test.ts"]
}
```

`packages/poi-db/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["reflect-metadata"],
  },
});
```

`packages/poi-db/src/index.ts`:

```ts
export {};
```

- [ ] **Step 4: Install + run test to verify it passes**

Run: `pnpm install && pnpm --filter @tarmoto/poi-db build && pnpm --filter @tarmoto/poi-db test`
Expected: install updates `pnpm-lock.yaml` for the new package; build exits 0; test PASSES.

- [ ] **Step 5: Verify OpenAPI unaffected**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output (byte-identical).

- [ ] **Step 6: Commit**

```bash
git add packages/poi-db pnpm-lock.yaml
git commit -m "feat(ingest): scaffold @tarmoto/poi-db package shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Move POI schema into `@tarmoto/poi-db` + rewire the backend

Atomic move of the entities, migrations, config, and CLI DataSource into the new package, consolidating today's duplicated migration array into one exported const, then repointing every backend importer. The backend still runs POI `migrationsRun: true` (the cutover to `false` is T5).

**Files:**

- Move: `apps/backend/src/entities/poi.entity.ts` → `packages/poi-db/src/entities/poi.entity.ts`
- Move: `apps/backend/src/entities/poi-import-run.entity.ts` → `packages/poi-db/src/entities/poi-import-run.entity.ts`
- Move: `apps/backend/src/entities/poi-import-run.entity.spec.ts` → `packages/poi-db/src/entities/poi-import-run.entity.spec.ts` (jest→vitest; `jest.*`-free, so `globals: true` covers it)
- Move: `apps/backend/src/config/poi-database.config.ts` → `packages/poi-db/src/config.ts`
- Move: `apps/backend/src/data-source.poi.ts` → `packages/poi-db/src/data-source.ts`
- Move: all 8 of `apps/backend/src/migrations-poi/1787000000000-AddPois.ts` … `1803000000000-AddPoiImportRunWarning.ts` → `packages/poi-db/src/migrations/`
- Move: `apps/backend/src/migrations-poi/migration-registry.spec.ts` → `packages/poi-db/src/migrations/migration-registry.spec.ts` (rewritten for the single array + vitest)
- Create: `packages/poi-db/src/migrations/index.ts` (the `POI_MIGRATIONS` const)
- Create: `packages/poi-db/src/typeorm-options.ts` (`buildPoiTypeOrmOptions` + `CONNECT_TIMEOUT_MS`)
- Create: `packages/poi-db/src/typeorm-options.spec.ts` (migrationsRun-gating assertions moved out of the backend module spec)
- Modify: `packages/poi-db/src/index.ts` (barrel)
- Modify: `packages/poi-db/package.json` (add `@nestjs/config`, `@nestjs/typeorm` deps)
- Modify: `apps/backend/package.json` (add `@tarmoto/poi-db` workspace dep + root chain already there)
- Modify: `apps/backend/src/modules/poi/poi-database.module.ts` (drop inline `buildPoiTypeOrmOptions` + migration imports; call the package's)
- Modify: `apps/backend/src/modules/poi/poi-import.service.ts:14` — `Poi` import
- Modify: `apps/backend/src/modules/poi/poi-repo.ts:3` — `Poi` import
- Modify: `apps/backend/src/modules/poi/poi-store.service.ts:4` — `Poi` import
- Modify: `apps/backend/src/modules/poi/poi-store.service.spec.ts:6` — `Poi` import
- Modify: `apps/backend/src/modules/poi/poi-repo.spec.ts:3` — `Poi` import
- Modify: `apps/backend/src/modules/poi/poi-import-run.recorder.ts:7` — `PoiImportRun` import
- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts:26` — `PoiImportRun` import
- Modify: `apps/backend/src/modules/poi/poi.module.ts:20` — `PoiImportRun` import
- Modify: `apps/backend/src/modules/poi/poi-import-run.recorder.spec.ts:3` — `PoiImportRun` import
- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.spec.ts:53` — `PoiImportRun` type import
- Modify: `apps/backend/src/modules/poi/poi-database.module.spec.ts` — repoint imports; move `buildPoiTypeOrmOptions` assertions to the package spec, keep the `createPoiDataSource` tolerate-down assertions
- Modify: `apps/backend/test/poi-coverage.e2e-spec.ts:6` — `PoiDataSource` import → `@tarmoto/poi-db`
- Modify: `package.json` (root) — add `poi-db:build`; insert it into every backend-building chain
- Modify: `.github/workflows/_build-openapi.yml` — add a "Build poi-db package" step
- Delete: the now-empty `apps/backend/src/migrations-poi/` directory and `apps/backend/src/data-source.poi.ts`, `apps/backend/src/config/poi-database.config.ts`, `apps/backend/src/entities/poi.entity.ts`, `apps/backend/src/entities/poi-import-run.entity.ts` (handled by `git mv`)

**Interfaces:**

- Consumes: the `@tarmoto/poi-db` shell (T1).
- Produces (the `@tarmoto/poi-db` barrel, consumed by T5 + the backend):
  - `Poi` (entity class), `PoiImportRun` (entity class), `PoiImportRunStatus`, `PoiImportTrigger` (types)
  - `POI_MIGRATIONS: readonly Function[]` — the single ordered migration array
  - `PoiDataSource: DataSource` — CLI DataSource for `db:migrate:poi`
  - `poiDatabaseConfig` — the `registerAs('poiDatabase', …)` config
  - `buildPoiTypeOrmOptions(config: ConfigService, options: { migrationsRun: boolean }): TypeOrmModuleOptions` — **exact signature T5 consumes.** Internally `migrationsRun: options.migrationsRun && !isOpenApiExport` so `OPENAPI_EXPORT` still forces migrations off (byte-identical `openapi:gen`); returns the full option set incl. `name: 'poi'`, `manualInitialization: true`, `retryAttempts: 0`, `connectTimeoutMS`, `extra.connectionTimeoutMillis`.

**Notes on decisions (spec-vs-recon reconciliation):**

- `createPoiDataSource` (the ADR-0007 tolerate-down connector) and `isPoiConnectionError` STAY in the backend: the spec keeps `poi-repo.ts` (which owns `isPoiConnectionError`) in the backend as a reader concern, and the package must not depend on backend code. So the package exports the pure options builder + schema; the backend's `poi-database.module.ts` keeps `createPoiDataSource` and simply calls the package's `buildPoiTypeOrmOptions`.
- The entities import only `typeorm` + `geojson` (no `@tarmoto/shared`), so no `@tarmoto/shared` dep is added to `@tarmoto/poi-db`.
- `load-region-boundaries.ts` imports only `bootstrap-script-context.js` + `@tarmoto/ingest` (neither moves in T2), so it needs **no change** this task; it moves to `apps/ingest` in T5.

- [ ] **Step 1: Rewrite the migration guard as the failing test**

`git mv apps/backend/src/migrations-poi/migration-registry.spec.ts packages/poi-db/src/migrations/migration-registry.spec.ts`, then replace its body (single-array home, vitest, `import.meta` instead of `__dirname`):

```ts
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { POI_MIGRATIONS } from "./index.js";

/**
 * The POI lineage now has ONE registry — `POI_MIGRATIONS` — consumed by both the
 * runtime TypeORM factory (`buildPoiTypeOrmOptions`) and the CLI `PoiDataSource`.
 * A migration file added to this directory but left out of `POI_MIGRATIONS` would
 * silently never replay on a fresh POI DB (the #555-shaped bug the app-DB guard
 * catches). This asserts every file on disk is registered exactly once.
 */
describe("POI migration registry — every file on disk is registered once", () => {
  const migrationsDir = dirname(fileURLToPath(import.meta.url));

  const filesOnDisk = (): string[] =>
    readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".spec.ts"))
      .filter((name) => name !== "index.ts")
      .map((name) => {
        const match = name.match(/^(\d+)-(.+)\.ts$/);
        if (!match) throw new Error(`unexpected migration filename: ${name}`);
        return `${match[2]}${match[1]}`;
      })
      .sort();

  it("matches POI_MIGRATIONS against src/migrations/*.ts", () => {
    const registered = POI_MIGRATIONS.map((m) => m.name).sort();
    expect(registered).toEqual(filesOnDisk());
  });

  it("never registers a migration twice", () => {
    const names = POI_MIGRATIONS.map((m) => m.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the guard to verify it fails**

Run: `pnpm --filter @tarmoto/poi-db test`
Expected: FAIL — `Cannot find module './index.js'` / `POI_MIGRATIONS` is not exported (migrations not moved yet).

- [ ] **Step 3: Move the schema files (verbatim) + consolidate the migration array**

`git mv` each of these (verbatim moves — do NOT edit bodies except the import repoints called out below):

- `apps/backend/src/entities/poi.entity.ts` → `packages/poi-db/src/entities/poi.entity.ts`
- `apps/backend/src/entities/poi-import-run.entity.ts` → `packages/poi-db/src/entities/poi-import-run.entity.ts`
- `apps/backend/src/entities/poi-import-run.entity.spec.ts` → `packages/poi-db/src/entities/poi-import-run.entity.spec.ts`
- `apps/backend/src/config/poi-database.config.ts` → `packages/poi-db/src/config.ts`
- `apps/backend/src/data-source.poi.ts` → `packages/poi-db/src/data-source.ts`
- all 8 `apps/backend/src/migrations-poi/1787…`–`1803…` → `packages/poi-db/src/migrations/`

Create `packages/poi-db/src/migrations/index.ts` — the single ordered array (order = chronological, identical to today's `data-source.poi.ts` / `poi-database.module.ts` arrays):

```ts
import { AddPois1787000000000 } from "./1787000000000-AddPois.js";
import { AddPoiDecisionSupportFields1793000000000 } from "./1793000000000-AddPoiDecisionSupportFields.js";
import { AddPoiDeactivatedAt1798000000000 } from "./1798000000000-AddPoiDeactivatedAt.js";
import { AddPoiGeographyIndex1799000000000 } from "./1799000000000-AddPoiGeographyIndex.js";
import { AddPoiImportRegions1800000000000 } from "./1800000000000-AddPoiImportRegions.js";
import { AddPoiImportRuns1801000000000 } from "./1801000000000-AddPoiImportRuns.js";
import { AddPoisSourceRegionIndex1802000000000 } from "./1802000000000-AddPoisSourceRegionIndex.js";
import { AddPoiImportRunWarning1803000000000 } from "./1803000000000-AddPoiImportRunWarning.js";

/**
 * The single POI migration registry (ADR-0007). Consumed by both the runtime
 * TypeORM factory (`buildPoiTypeOrmOptions`) and the CLI `PoiDataSource`, so the
 * two can no longer drift. Guarded by `migration-registry.spec.ts`.
 */
export const POI_MIGRATIONS = [
  AddPois1787000000000,
  AddPoiDecisionSupportFields1793000000000,
  AddPoiDeactivatedAt1798000000000,
  AddPoiGeographyIndex1799000000000,
  AddPoiImportRegions1800000000000,
  AddPoiImportRuns1801000000000,
  AddPoisSourceRegionIndex1802000000000,
  AddPoiImportRunWarning1803000000000,
] as const;
```

Rewrite the moved `packages/poi-db/src/data-source.ts` so its `migrations:` reads `POI_MIGRATIONS` (drop the 8 inline imports; keep everything else — the `TARMOTO_POI_DATABASE_*` env defaults, `migrationsTransactionMode: 'none'`, `synchronize: false`):

```ts
import "dotenv/config";
import { DataSource } from "typeorm";
import { Poi } from "./entities/poi.entity.js";
import { PoiImportRun } from "./entities/poi-import-run.entity.js";
import { POI_MIGRATIONS } from "./migrations/index.js";

// CLI DataSource for the separate POI database (ADR 0007). Used by
// `pnpm db:migrate:poi`. The migration list is the shared `POI_MIGRATIONS`.
export const PoiDataSource = new DataSource({
  type: "postgres",
  host: process.env.TARMOTO_POI_DATABASE_HOST || "localhost",
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || "5434", 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || "tarmoto_poi",
  username: process.env.TARMOTO_POI_DATABASE_USER || "tarmoto",
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || "tarmoto",
  entities: [Poi, PoiImportRun],
  migrations: [...POI_MIGRATIONS],
  migrationsTransactionMode: "none",
  synchronize: false,
});
```

The moved entity files need no edit (self-contained). The moved `poi-import-run.entity.spec.ts` needs its jest globals swapped only if it referenced `jest.*` — it does not (verified), so it runs unchanged under Vitest `globals: true`.

- [ ] **Step 4: Create `buildPoiTypeOrmOptions` + its spec, and update the barrel**

`packages/poi-db/src/typeorm-options.ts` (lifted verbatim from `poi-database.module.ts`'s `buildPoiTypeOrmOptions`, with the two changes: `migrationsRun` is now a parameter ANDed with the `OPENAPI_EXPORT` gate; `migrations` reads `POI_MIGRATIONS`):

```ts
import type { ConfigService } from "@nestjs/config";
import type { TypeOrmModuleOptions } from "@nestjs/typeorm";
import { Poi } from "./entities/poi.entity.js";
import { PoiImportRun } from "./entities/poi-import-run.entity.js";
import { POI_MIGRATIONS } from "./migrations/index.js";

// Bound the runtime connect attempt so a reachable-but-unresponsive POI host
// can't block boot for the OS TCP timeout. (Was CONNECT_TIMEOUT_MS in the
// backend's poi-database.module.ts; moved here with the options builder.)
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Build the POI-DB TypeORM options for a Nest app. `migrationsRun` is decided by
 * the OWNING app: apps/ingest migrates (true); the backend reads only (false).
 * `OPENAPI_EXPORT` still forces it off so `openapi:gen` never writes the POI DB
 * and its spec stays byte-identical (mirrors DatabaseModule's gate).
 */
export function buildPoiTypeOrmOptions(
  config: ConfigService,
  options: { migrationsRun: boolean },
): TypeOrmModuleOptions {
  const isOpenApiExport = process.env["OPENAPI_EXPORT"] === "true";
  const host = config.get<string>("poiDatabase.host");
  const port = config.get<number>("poiDatabase.port");
  const database = config.get<string>("poiDatabase.database");
  const username = config.get<string>("poiDatabase.username");
  const password = config.get<string>("poiDatabase.password");
  return {
    type: "postgres",
    name: "poi",
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    entities: [Poi, PoiImportRun],
    migrations: [...POI_MIGRATIONS],
    migrationsRun: options.migrationsRun && !isOpenApiExport,
    migrationsTransactionMode: "none",
    synchronize: false,
    retryAttempts: 0,
    manualInitialization: true,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    extra: { connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
  };
}
```

`packages/poi-db/src/typeorm-options.spec.ts` — the migrationsRun-gating assertions that lived in the backend's `poi-database.module.spec.ts`, now testing the package function (Vitest; a minimal `ConfigService`-shaped stub):

```ts
import { describe, it, expect } from "vitest";
import { buildPoiTypeOrmOptions } from "./typeorm-options.js";

const cfg = {
  get: (key: string) =>
    ({
      "poiDatabase.host": "h",
      "poiDatabase.port": 5434,
      "poiDatabase.database": "d",
      "poiDatabase.username": "u",
      "poiDatabase.password": "p",
    })[key],
} as unknown as import("@nestjs/config").ConfigService;

describe("buildPoiTypeOrmOptions", () => {
  it("runs migrations when the owner opts in and not exporting OpenAPI", () => {
    delete process.env.OPENAPI_EXPORT;
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: true }).migrationsRun,
    ).toBe(true);
  });

  it("never runs migrations when the owner opts out", () => {
    delete process.env.OPENAPI_EXPORT;
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: false }).migrationsRun,
    ).toBe(false);
  });

  it("forces migrations off during OpenAPI export even when the owner opts in", () => {
    process.env.OPENAPI_EXPORT = "true";
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: true }).migrationsRun,
    ).toBe(false);
    delete process.env.OPENAPI_EXPORT;
  });
});
```

`packages/poi-db/src/config.ts` (the moved `poiDatabaseConfig`) needs no edit. Update the barrel `packages/poi-db/src/index.ts`:

```ts
export { Poi } from "./entities/poi.entity.js";
export {
  PoiImportRun,
  type PoiImportRunStatus,
  type PoiImportTrigger,
} from "./entities/poi-import-run.entity.js";
export { POI_MIGRATIONS } from "./migrations/index.js";
export { PoiDataSource } from "./data-source.js";
export { poiDatabaseConfig } from "./config.js";
export {
  buildPoiTypeOrmOptions,
  CONNECT_TIMEOUT_MS,
} from "./typeorm-options.js";
```

Add the two Nest deps to `packages/poi-db/package.json` `dependencies` (needed by `config.ts` + `typeorm-options.ts`):

```json
    "@nestjs/config": "^4.0.4",
    "@nestjs/typeorm": "^11.0.1",
```

- [ ] **Step 5: Run the package build + tests to verify they pass**

Run: `pnpm install && pnpm --filter @tarmoto/poi-db build && pnpm --filter @tarmoto/poi-db test`
Expected: build exits 0; guard + entity + options specs PASS.

- [ ] **Step 6: Rewire the backend importers + slim `poi-database.module.ts`**

Add the workspace dep to `apps/backend/package.json` `dependencies` (alphabetically near `@tarmoto/ingest`):

```json
    "@tarmoto/poi-db": "workspace:*",
```

Repoint every backend importer of a moved symbol (per the recon-B import-site inventory). Change the import specifiers to `@tarmoto/poi-db` (named imports unchanged):

- `Poi` — 5 prod + 2 spec sites: `poi-import.service.ts:14`, `poi-repo.ts:3`, `poi-store.service.ts:4`, `poi-store.service.spec.ts:6`, `poi-repo.spec.ts:3` (`import { Poi } from '@tarmoto/poi-db';`).
- `PoiImportRun` (+ `PoiImportTrigger`) — 4 prod + 3 spec sites: `poi-import-run.recorder.ts:7` (`import { PoiImportRun, type PoiImportTrigger } from '@tarmoto/poi-db';`), `poi-import-admin.service.ts:26`, `poi.module.ts:20`, `poi-import-run.recorder.spec.ts:3`, `poi-import-admin.service.spec.ts:53` (type import). _(The moved entity spec + `poi-import-run.entity.spec.ts` no longer exist in the backend.)_
- `PoiDataSource` — `apps/backend/test/poi-coverage.e2e-spec.ts:6` → `import { PoiDataSource } from '@tarmoto/poi-db';`.

Slim `apps/backend/src/modules/poi/poi-database.module.ts` — keep `createPoiDataSource` + `RETRY_MS` + the `@Module`; drop the inline `buildPoiTypeOrmOptions`, `CONNECT_TIMEOUT_MS`, the 8 migration imports, the `Poi`/`PoiImportRun`/`poiDatabaseConfig` local imports. Before → after of the head + factory:

Before (imports + inline builder, abbreviated):

```ts
import { Poi } from '../../entities/poi.entity.js';
import { PoiImportRun } from '../../entities/poi-import-run.entity.js';
import { poiDatabaseConfig } from '../../config/poi-database.config.js';
import { AddPois1787000000000 } from '../../migrations-poi/1787000000000-AddPois.js';
// … 7 more migration imports …
import { isPoiConnectionError } from './poi-repo.js';
const CONNECT_TIMEOUT_MS = 5_000;
// … createPoiDataSource … export function buildPoiTypeOrmOptions(config) { … }
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'poi',
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      useFactory: buildPoiTypeOrmOptions,
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
```

After:

```ts
import { Module, Logger } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, type DataSourceOptions } from "typeorm";
import { buildPoiTypeOrmOptions, poiDatabaseConfig } from "@tarmoto/poi-db";
import { isPoiConnectionError } from "./poi-repo.js";

const logger = new Logger("PoiDatabase");
const RETRY_MS = 10_000;

// createPoiDataSource(...) — UNCHANGED verbatim from today (tolerate-down, ADR 0007).

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: "poi",
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      // Backend still migrates the POI DB in this phase; T5 flips this to false.
      useFactory: (config: ConfigService) =>
        buildPoiTypeOrmOptions(config, { migrationsRun: true }),
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
export class PoiDatabaseModule {}
```

Update `apps/backend/src/modules/poi/poi-database.module.spec.ts`: repoint its imports to `@tarmoto/poi-db`; **delete** the `buildPoiTypeOrmOptions` migrationsRun assertions (they moved to the package spec in Step 4); keep the `createPoiDataSource` tolerate-down assertions and the `getDataSourceToken('poi')` reference (both backend concerns).

- [ ] **Step 7: Wire `poi-db:build` into every backend-building chain**

Add to `package.json` (root) `scripts`, right after `ingest:build`:

```json
    "poi-db:build": "pnpm --filter @tarmoto/poi-db build",
```

Then insert `pnpm poi-db:build` immediately after `pnpm ingest:build` in every chain that builds the backend (mirroring the Phase-1 `ingest:build` placement). After editing, these five become:

```json
    "backend:db:migrate": "pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend db:migrate",
    "openapi:gen": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm --filter @tarmoto/openapi generate",
    "db:migrate:poi": "pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend db:migrate:poi",
    "db:seed": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend seed:demo",
    "poi:import": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend poi:import",
    "fsq:import": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend fsq:import",
    "poi:load-boundaries": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm backend:build && pnpm --filter @tarmoto/backend poi:load-boundaries",
```

Also add `pnpm poi-db:build` to the `dev` chain's prelude (it currently does `pnpm shared:build && pnpm ingest:build && …`):

```json
    "dev": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm --parallel --filter @tarmoto/shared --filter @tarmoto/ingest --filter @tarmoto/backend --filter @tarmoto/web --filter @tarmoto/companion --filter @tarmoto/admin run dev",
```

And `scripts/bootstrap.sh` — add a `poi-db` build between the ingest and backend builds (step 6 block):

```bash
pnpm ingest:build
ok "ingest built"
pnpm poi-db:build
ok "poi-db built"
pnpm backend:build
ok "backend built"
```

And `.github/workflows/_build-openapi.yml` — add a step after "Build ingest package":

```yaml
- name: Build poi-db package
  run: pnpm poi-db:build
```

- [ ] **Step 8: Run the backend suite + build + migration path to verify green**

Run: `pnpm --filter @tarmoto/poi-db build && pnpm backend:build && pnpm --filter @tarmoto/backend test`
Expected: backend compiles against `@tarmoto/poi-db`; the full backend jest suite passes (POI read tests now resolve `Poi` from the package).

- [ ] **Step 9: Verify the POI migration path still runs from the new home**

Run: `pnpm db:up && pnpm db:migrate:poi`
Expected: builds `@tarmoto/poi-db` in the chain, then TypeORM applies the 8 migrations against the POI DB (already-applied ones skipped) with exit 0.

- [ ] **Step 10: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(cross): move POI schema into @tarmoto/poi-db

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Grow `@tarmoto/ingest` with the pure mappers + the `poi.import` queue/job constants

Atomic move of the five pure, DB-free mapper/parser files and the `poi.import` queue/job/cron string constants into the existing `@tarmoto/ingest` library, then repoint the backend consumers. The one non-mechanical piece: the backend's `poi-import.service.spec.ts` mocks the moving `parsePoiExtract`, and a package-boundary mock cannot intercept the (now package-internal) call — so its parser control switches to injecting a stub `PoiImportSource`.

**Files:**

- Move: `apps/backend/src/modules/poi/providers/osm-poi-tags.ts` → `packages/ingest/src/poi/osm-poi-tags.ts` (+ its `providers/osm-poi-tags.spec.ts` → `packages/ingest/src/poi/osm-poi-tags.spec.ts`)
- Move: `apps/backend/src/modules/poi/fsq-poi-categories.ts` → `packages/ingest/src/poi/fsq-poi-categories.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/modules/poi/poi-extract-source.ts` → `packages/ingest/src/poi/poi-extract-source.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/modules/poi/poi-import-source.ts` → `packages/ingest/src/poi/poi-import-source.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/modules/poi/poi-import.lock.ts` → `packages/ingest/src/poi/poi-import.lock.ts` (+ `.spec.ts`)
- Create: `packages/ingest/src/poi/queue.ts` (the `poi.import` string constants)
- Modify: `packages/ingest/src/poi/index.ts` (barrel adds the 5 modules + queue)
- Modify: `packages/ingest/package.json` (add `@tarmoto/shared` dep; `osm-poi-tags` imports it)
- Modify: `apps/backend/src/modules/poi/providers/overpass.provider.ts:18` — `osm-poi-tags` import → `@tarmoto/ingest`
- Modify: `apps/backend/src/modules/poi/poi-import.service.ts` — `poi-import-source` (L17-22) + `poi-import.lock` (L23) imports → `@tarmoto/ingest`
- Modify: `apps/backend/src/modules/poi/poi.module.ts:17` — `FsqPoiImportSource` import → `@tarmoto/ingest`
- Modify: `apps/backend/src/modules/poi/poi-import.service.spec.ts` — replace the `parsePoiExtract` module-mock with an injected stub source; repoint `FsqPoiImportSource` import
- Modify: `apps/backend/src/modules/jobs/jobs.constants.ts` — source `POI_IMPORT` / `POI_IMPORT_DISPATCH` / `POI_IMPORT_REGION` / `WEEKLY_SUN_0300` values from `@tarmoto/ingest`
- Delete: the moved files' original locations (handled by `git mv`)

**Interfaces:**

- Consumes: `@tarmoto/shared` (already a workspace package), `@tarmoto/poi-db` unaffected.
- Produces (added to the `@tarmoto/ingest` barrel, consumed by T5):
  - `parsePoiExtract`, the OSM/accommodation item types (from `poi-extract-source`)
  - `OsmPoiImportSource`, `FsqPoiImportSource`, `POI_IMPORT_SOURCE` (Symbol), `PoiImportSource` (interface), `StorableImportRow` (type) — from `poi-import-source`
  - `fsqRowToImportRow`, `FsqPlaceRow` — from `fsq-poi-categories`
  - `parseStarsTag`, `toAccommodationPoi`, `toImportedPoi`, `OsmPoiElement`, … — from `osm-poi-tags`
  - `poiAdvisoryLockKey` — from `poi-import.lock`
  - `POI_IMPORT_QUEUE: 'poi.import'`, `POI_IMPORT_JOB: { DISPATCH: 'dispatch'; REGION: 'import-region' }`, `POI_IMPORT_WEEKLY_CRON: '0 3 * * 0'` — from `queue`

**Notes on decisions:**

- `poi-import-source.ts` and `fsq-poi-categories.ts` form a cross-import cycle (each imports a type from the other) and `poi-extract-source.ts` imports `osm-poi-tags.ts` — so all five move together, keeping their intra-cluster imports relative (sibling `./x.js`) within the package.
- `overpass.provider.ts` STAYS in the backend (live Overpass read path) — its `osm-poi-tags` import repoints to the package.
- Queue-constant strategy: keep `QUEUE_NAMES` / `JOB_NAMES` / `RECURRING_PATTERNS` objects in `jobs.constants.ts` intact (every backend referencer of `QUEUE_NAMES.POI_IMPORT` etc. stays unchanged) but source the four POI values from the package, so the strings have one home shared by both apps.

- [ ] **Step 1: Rewire the service spec as the failing test (stub source)**

Edit `apps/backend/src/modules/poi/poi-import.service.spec.ts`. Remove the parser module-mock + import (top of file):

Delete:

```ts
jest.mock("./poi-extract-source.js", () => ({
  parsePoiExtract: jest.fn(),
}));
```

and the line `import { parsePoiExtract } from './poi-extract-source.js';` and the helper `const parsePoiExtractMock = jest.mocked(parsePoiExtract);` and the `extractOf` generator (now inlined into the stub). Repoint `import { FsqPoiImportSource } from './poi-import-source.js';` → `from '@tarmoto/ingest';` and add `PoiImportSource`, `StorableImportRow` to that import plus `type PoiImportRegion` (already imported from `@tarmoto/ingest`).

Add a module-level controllable stub (it unwraps `ExtractItem` exactly as the real `OsmPoiImportSource.parse` does, so the existing `poi(...)`/`accommodation(...)` fixtures and `mockExtract(...)` call sites keep working):

```ts
// Controllable OSM-shaped source. importRegion() streams through source.parse(),
// so setting `stubExtract` replaces the old parsePoiExtract module-mock (which a
// package-boundary jest.mock can no longer intercept now that the parser is
// package-internal). Unwraps ExtractItem exactly like the real OsmPoiImportSource.
let stubExtract: ExtractItem[] = [];
let stubParseCalls = 0;
class StubOsmSource implements PoiImportSource {
  readonly source = "osm";
  extractFilename(region: PoiImportRegion): string {
    return `${region.code.toLowerCase()}.osm`;
  }
  async *parse(): AsyncGenerator<StorableImportRow> {
    stubParseCalls += 1;
    await Promise.resolve();
    for (const item of stubExtract) {
      yield "poi" in item ? item.poi : item.accommodation;
    }
  }
}
```

Change the `mockExtract` helper to drive the stub:

```ts
function mockExtract(...items: ExtractItem[]): void {
  stubExtract = items;
}
```

In `beforeEach`, replace `parsePoiExtractMock.mockReset(); mockExtract();` with `stubExtract = []; stubParseCalls = 0;`, and construct the default service with the stub: `service = new PoiImportService(dataSource, config, new StubOsmSource());`. At the other default-OSM construction sites (the `extractDir = null` case), pass `new StubOsmSource()`; the FSQ construction site keeps `new FsqPoiImportSource()` (FSQ reads a real stream, not the parser). Replace the parser-call assertions: `expect(parsePoiExtractMock).not.toHaveBeenCalled()` → `expect(stubParseCalls).toBe(0)`; `expect(parsePoiExtractMock).toHaveBeenCalledTimes(2)` → `expect(stubParseCalls).toBe(2)`.

- [ ] **Step 2: Run the service spec to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- poi-import.service`
Expected: FAIL — `Cannot find module '@tarmoto/ingest'` exports `PoiImportSource`/`StorableImportRow`/`FsqPoiImportSource` (mappers not moved yet).

- [ ] **Step 3: Move the five mappers (verbatim) + create the queue constants**

`git mv` each of the five files and its `.spec.ts` sibling into `packages/ingest/src/poi/` (verbatim; the only edits are the intra-cluster imports staying relative — e.g. the moved `poi-extract-source.ts` keeps `import … from './osm-poi-tags.js'`, now resolving to the sibling in the package). The five moved specs are all `jest.*`-free (verified), so they run under Vitest `globals: true` unchanged.

Create `packages/ingest/src/poi/queue.ts`:

```ts
/**
 * The `poi.import` queue contract shared by BOTH apps: the backend enqueues into
 * it (producer) and apps/ingest processes it (worker/scheduler). Kept here in the
 * pure lib so neither app owns the strings. `as const` preserves literal types so
 * the backend's `QUEUE_NAMES` / `JOB_NAMES` objects stay literally typed.
 */
export const POI_IMPORT_QUEUE = "poi.import" as const;
export const POI_IMPORT_JOB = {
  /** Weekly dispatcher: fans out one import-region job per configured region. */
  DISPATCH: "dispatch",
  /** Per-region child job (staggered): imports one country's extract. */
  REGION: "import-region",
} as const;
/** Weekly Sunday 03:00 — offline POI import dispatcher. */
export const POI_IMPORT_WEEKLY_CRON = "0 3 * * 0" as const;
```

Update `packages/ingest/src/poi/index.ts`:

```ts
export * from "./regions.js";
export * from "./refresh-config.js";
export * from "./osm-poi-tags.js";
export * from "./fsq-poi-categories.js";
export * from "./poi-extract-source.js";
export * from "./poi-import-source.js";
export * from "./poi-import.lock.js";
export * from "./queue.js";
```

Add the `@tarmoto/shared` runtime dep to `packages/ingest/package.json` (create the `dependencies` block; `osm-poi-tags` imports `@tarmoto/shared`):

```json
  "dependencies": {
    "@tarmoto/shared": "workspace:*"
  },
```

- [ ] **Step 4: Rewire the backend mapper importers + queue constants**

Repoint the backend production importers of the moved mappers (recon-B inventory) to `@tarmoto/ingest`:

- `providers/overpass.provider.ts:18` — the `osm-poi-tags` import.
- `poi-import.service.ts` — the `poi-import-source` import (`OsmPoiImportSource`, `POI_IMPORT_SOURCE`, `PoiImportSource`, `StorableImportRow`) and the `poi-import.lock` import (`poiAdvisoryLockKey`). _(`Poi` already comes from `@tarmoto/poi-db` after T2; `poiImportConfig` stays local.)_
- `poi.module.ts:17` — `FsqPoiImportSource`.

In `apps/backend/src/modules/jobs/jobs.constants.ts`, import the package strings and substitute them into the existing object literals (no referencer changes elsewhere):

```ts
import {
  POI_IMPORT_QUEUE,
  POI_IMPORT_JOB,
  POI_IMPORT_WEEKLY_CRON,
} from "@tarmoto/ingest";
```

- In `QUEUE_NAMES`: `POI_IMPORT: POI_IMPORT_QUEUE,` (was `'poi.import'`).
- In `JOB_NAMES`: `POI_IMPORT_DISPATCH: POI_IMPORT_JOB.DISPATCH,` and `POI_IMPORT_REGION: POI_IMPORT_JOB.REGION,`.
- In `RECURRING_PATTERNS`: `WEEKLY_SUN_0300: POI_IMPORT_WEEKLY_CRON,`.

- [ ] **Step 5: Run ingest tests + the backend suite to verify green**

Run: `pnpm install && pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/ingest test && pnpm backend:build && pnpm --filter @tarmoto/backend test`
Expected: the moved mapper specs pass under Vitest in `@tarmoto/ingest`; the backend compiles + its jest suite (incl. the rewired `poi-import.service.spec.ts`) passes.

- [ ] **Step 6: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cross): move POI mappers and poi.import queue constants into @tarmoto/ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Scaffold `apps/ingest` NestJS app (boots, health)

Create the new NestJS application shell — a minimal `AppModule` (ConfigModule + a health controller) with an HTTP listener for the container healthcheck. Heavy DB/queue/CLI wiring lands in T5; this task only proves the app boots and builds, mirroring `apps/backend`'s toolchain (Jest, `nest build`, NodeNext ESM). It carries the `assets/*.geojson` nest-cli glob so T5 can drop in the boundary asset without a config change.

**Files:**

- Create: `apps/ingest/package.json`
- Create: `apps/ingest/tsconfig.json`
- Create: `apps/ingest/tsconfig.build.json`
- Create: `apps/ingest/nest-cli.json`
- Create: `apps/ingest/src/main.ts`
- Create: `apps/ingest/src/app.module.ts`
- Create: `apps/ingest/src/health.controller.ts`
- Test: `apps/ingest/src/app.module.spec.ts`

**Interfaces:**

- Consumes: `@tarmoto/shared`, `@tarmoto/ingest`, `@tarmoto/poi-db` (declared deps, wired in T5).
- Produces: `@tarmoto/ingest-service` app with an `AppModule` T5/T6 extend, a `GET /healthz` → `{ status: 'ok' }` endpoint, and `pnpm --filter @tarmoto/ingest-service build` / `test` scripts.

**Notes on decisions:**

- The app serves `/healthz` with NO global prefix (an internal worker, not the public API) — the T7 Dockerfile healthcheck targets `/healthz` to match.
- Deps mirror the backend subset the ingest engine will need: `@nestjs/common|core|config|typeorm|bullmq`, `typeorm`, `pg`, `bullmq`, `reflect-metadata`, `rxjs`, `@nestjs/platform-express`, plus the workspace packages. Extract-only runtime deps (`sax`, `fast-xml-parser`) arrive with the scripts in T6.

- [ ] **Step 1: Write the failing test**

`apps/ingest/src/app.module.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module.js";
import { HealthController } from "./health.controller.js";

describe("apps/ingest AppModule", () => {
  it("compiles and exposes the health probe", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const health = moduleRef.get(HealthController);
    expect(health.getHealth()).toEqual({ status: "ok" });
    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/ingest-service test`
Expected: FAIL — `No projects matched the filters` (app does not exist yet).

- [ ] **Step 3: Create the app scaffold**

`apps/ingest/package.json`:

```json
{
  "name": "@tarmoto/ingest-service",
  "version": "0.0.1",
  "description": "Tarmoto POI ingestion service (extract + scheduled import + POI migrations)",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "build": "nest build",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "start": "nest start",
    "dev": "nest start --watch",
    "start:prod": "node dist/main",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "jest"
  },
  "dependencies": {
    "@nestjs/bullmq": "^11.0.4",
    "@nestjs/common": "^11.0.1",
    "@nestjs/config": "^4.0.4",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "@nestjs/schedule": "^6.1.3",
    "@nestjs/typeorm": "^11.0.1",
    "@tarmoto/ingest": "workspace:*",
    "@tarmoto/poi-db": "workspace:*",
    "@tarmoto/shared": "workspace:*",
    "bullmq": "^5.76.4",
    "pg": "^8.20.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typeorm": "^0.3.28"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.1",
    "@types/jest": "^30.0.0",
    "@types/node": "^24.0.0",
    "jest": "^30.0.0",
    "prettier": "^3.4.2",
    "ts-jest": "^29.2.5",
    "ts-loader": "^9.5.2",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.7.3"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": {
      "^.+\\.(t|j)s$": "ts-jest"
    },
    "moduleNameMapper": {
      "^(\\.{1,2}/.*)\\.(js|ts)$": "$1"
    },
    "collectCoverageFrom": ["**/*.(t|j)s"],
    "coverageDirectory": "../coverage",
    "testEnvironment": "node"
  }
}
```

`apps/ingest/tsconfig.json` (mirrors the backend):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "resolvePackageJsonExports": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "removeComments": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

`apps/ingest/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

`apps/ingest/nest-cli.json` (carries the geojson asset glob for T5's boundary loader):

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": ["assets/*.geojson"]
  }
}
```

`apps/ingest/src/health.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  // Cheap liveness probe for the container healthcheck (no DB/Redis hop).
  @Get("healthz")
  getHealth(): { status: "ok" } {
    return { status: "ok" };
  }
}
```

`apps/ingest/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/ingest/src/main.ts`:

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

// The ingest service runs the always-on BullMQ worker + scheduler (wired in T5).
// It also exposes a minimal HTTP listener so the container healthcheck has an
// endpoint to hit; there is no public API surface here.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  const shutdown = (): void => void app.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void bootstrap();
```

- [ ] **Step 4: Install + run test/build to verify they pass**

Run: `pnpm install && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test`
Expected: install picks up `apps/ingest`; `nest build` exits 0; the AppModule-compile + health test PASSES.

- [ ] **Step 5: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ingest): scaffold apps/ingest nestjs service shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Move the import ENGINE into `apps/ingest` + SLIM the backend

The large atomic task and the migration-cutover point. The DB-coupled import engine (service, recorder, processor, scheduler registration, CLIs, config, DI providers) moves wholly into `apps/ingest`, which becomes the POI-DB migrator (`migrationsRun: true`). The backend deletes the engine, flips to `migrationsRun: false`, keeps a producer-only `poi.import` queue, and reworks `PoiImportAdminService` to read region/extract metadata from `@tarmoto/ingest` + env instead of the (now-moved) `POI_IMPORT_SOURCES` registry. A real-PG e2e in `apps/ingest` proves the moved pipeline still upserts + tombstones + stamps coverage.

> **Right-sizing note:** this is the heaviest task. During execution it may be split at the natural seam — **5a** stand up the `apps/ingest` engine + e2e (moving files in, no backend deletions yet, backend temporarily keeps its copy behind `TARMOTO_QUEUE_WORKER_ENABLED`), then **5b** slim the backend (delete the engine, rework the admin service, flip `migrationsRun`). Kept as one task here to match the plan's task numbering; the gate is identical either way.

**Files:**

- Move: `apps/backend/src/modules/poi/poi-import.service.ts` → `apps/ingest/src/poi/poi-import.service.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/modules/poi/poi-import-run.recorder.ts` → `apps/ingest/src/poi/poi-import-run.recorder.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/modules/poi/poi-import.config.ts` → `apps/ingest/src/poi/poi-import.config.ts` (`poiImportConfig` + `fsqImportConfig`)
- Move: `apps/backend/src/modules/jobs/processors/poi-import.processor.ts` → `apps/ingest/src/poi/poi-import.processor.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/scripts/import-pois.ts` → `apps/ingest/src/scripts/import-pois.ts`
- Move: `apps/backend/src/scripts/load-region-boundaries.ts` → `apps/ingest/src/scripts/load-region-boundaries.ts` (+ `.spec.ts` if present)
- Move: `apps/backend/src/scripts/bootstrap-script-context.ts` → `apps/ingest/src/scripts/bootstrap-script-context.ts`
- Move: `apps/backend/src/assets/import-region-boundaries.geojson` → `apps/ingest/src/assets/import-region-boundaries.geojson`
- Create: `apps/ingest/src/poi/poi-database.module.ts` (fail-fast migrator variant)
- Create: `apps/ingest/src/poi/poi.module.ts` (the two `PoiImportService` instances + `POI_IMPORT_SOURCES` + recorder)
- Create: `apps/ingest/src/poi/jobs.module.ts` (BullMQ root + `poi.import` queue + worker + scheduler, `TARMOTO_QUEUE_WORKER_ENABLED`-gated)
- Create: `apps/ingest/src/poi/poi-import.scheduler.ts` (the `poi.import` recurring-job registration extracted from the backend `jobs.scheduler.ts`)
- Create: `apps/ingest/test/poi-import.e2e-spec.ts` (real-PG import e2e) + `apps/ingest/test/jest-e2e.json`
- Modify: `apps/ingest/src/app.module.ts` (import the new PoiDatabaseModule + PoiModule + JobsModule)
- Modify: `apps/ingest/package.json` (add `sax`, `fast-xml-parser`, `dotenv`, `@types/sax`; add `poi:import`/`fsq:import`/`poi:load-boundaries`/`db:migrate:poi`/`db:revert:poi`/`test:e2e` scripts)
- Modify: `apps/backend/src/modules/poi/poi-database.module.ts` — `migrationsRun: true` → `false`
- Modify: `apps/backend/src/modules/poi/poi.module.ts` — drop the moved providers; keep producer queue + admin service + reads
- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts` — decouple from `POI_IMPORT_SOURCES`/`PoiImportService`; read metadata from `@tarmoto/ingest` + env (+ its `.spec.ts`)
- Modify: `apps/backend/src/modules/jobs/jobs.module.ts` — remove `PoiImportProcessor` from `PROCESSOR_PROVIDERS` + its import; remove `PoiModule` if now unused there
- Modify: `apps/backend/src/modules/jobs/jobs.scheduler.ts` — remove the `poi.import` `@InjectQueue` + its spec entry + `removeRetiredSchedulers` poi line (keep OSM)
- Modify: `apps/backend/src/modules/jobs/jobs.producer.ts` — the `enqueuePoiImportRegion` fan-out belongs to `apps/ingest` after the move, and the admin front-door enqueues via its OWN `@InjectQueue(POI_IMPORT_QUEUE)`. **Grep for remaining backend callers of `enqueuePoiImportRegion`; if none, DELETE it from the backend producer (do not leave dead code).** If the admin references `PoiImportRegionJobData` as its enqueue payload type, relocate that type to `@tarmoto/ingest` (shared job contract) rather than keeping the producer method alive for it.
- Modify: `apps/backend/src/modules/admin/admin.module.ts` — `PoiModule` import stays (for `PoiImportAdminService`), now without the engine
- Modify: `package.json` (root) — repoint `poi:import`/`fsq:import`/`poi:load-boundaries`/`db:migrate:poi` to build+run `@tarmoto/ingest-service`
- Delete (from backend): the moved `.ts`/`.spec.ts` originals + `apps/backend/src/scripts/import-pois.ts` etc. (via `git mv`); the `poi.import` scheduler spec entry

**Interfaces:**

- Consumes: `@tarmoto/poi-db` (`Poi`, `PoiImportRun`, `buildPoiTypeOrmOptions`, `poiDatabaseConfig`), `@tarmoto/ingest` (mappers, `POI_IMPORT_QUEUE`, `POI_IMPORT_JOB`, `POI_IMPORT_WEEKLY_CRON`, `DEFAULT_REGIONS`, `PoiImportSource`, `OsmPoiImportSource`, `FsqPoiImportSource`, `POI_IMPORT_SOURCE`), the `apps/ingest` AppModule (T4).
- Produces: `apps/ingest` as the running POI worker + scheduler + migrator; the backend as a producer + reader + front-door. `buildPoiTypeOrmOptions(config, { migrationsRun: true })` is called by `apps/ingest`'s PoiDatabaseModule and `{ migrationsRun: false }` by the backend's — the same signature T2 produced.

**Notes on decisions:**

- `apps/ingest`'s PoiDatabaseModule is a migrator, so it does NOT use the backend's tolerate-down `createPoiDataSource` (a migrator must fail fast if the DB is down): it uses a plain `dataSourceFactory: (o) => new DataSource(o!).initialize()`. `buildPoiTypeOrmOptions` sets `manualInitialization: true`, so Nest returns the factory result as-is and the factory owns `initialize()` (which runs the migrations).
- `apps/ingest`'s BullMQ worker + scheduler are gated on `TARMOTO_QUEUE_WORKER_ENABLED` (default on), mirroring the backend, so the moved `import-pois` CLI (via `bootstrapScriptContext`, which sets the gate false) can resolve `PoiImportService` and import directly without the always-on worker double-processing.
- `PoiImportAdminService` rework — recon-B's key finding: every public method is already a front-door (enqueue/status/upload); NONE run import logic. The only coupling is metadata reads off the injected `POI_IMPORT_SOURCES` registry (`importer.source` / `.regions` / `.extractDirConfigured` / `.getExtractPath`). The rework replaces that injected dependency with a local descriptor built from `@tarmoto/ingest`'s `DEFAULT_REGIONS` + `OsmPoiImportSource`/`FsqPoiImportSource` (plain classes) + the admin's own `TARMOTO_*_IMPORT_DIR` env — the backend no longer depends on the ingestion service's private config, exactly as the spec's "admin reads DB + queue + canonical region list" states.
- Advisory-lock serialization (`pg_try_advisory_lock` in `PoiImportService.importRegion`) now runs entirely inside `apps/ingest` for BOTH the manual (admin-enqueued) and cron paths, because both execute in `apps/ingest`'s single processor — the existing serialization is preserved with no change.

- [ ] **Step 1: Write the failing real-PG import e2e**

`apps/ingest/test/poi-import.e2e-spec.ts` — seed a tiny `<code>.osm` extract into a temp dir, boot a Nest context with the POI DB up, run `PoiImportService.importRegion`, assert `pois` upsert + tombstone + `poi_import_regions.imported_at` stamp. (Model the fixtures on the backend's `test/poi-coverage.e2e-spec.ts` — reuse its `PoiDataSource` bootstrap from `@tarmoto/poi-db` and the same `CZ` region bbox.) Skeleton:

```ts
import { Test } from "@nestjs/testing";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppModule } from "../src/app.module.js";
import { PoiImportService } from "../src/poi/poi-import.service.js";
import { DEFAULT_REGIONS } from "@tarmoto/ingest";

describe("apps/ingest POI import (real PG)", () => {
  let app: Awaited<ReturnType<typeof buildContext>>;
  const dir = mkdtempSync(join(tmpdir(), "poi-e2e-"));

  const buildContext = async () => {
    process.env.TARMOTO_POI_IMPORT_DIR = dir;
    process.env.TARMOTO_POI_IMPORT_REGIONS = "CZ";
    process.env.TARMOTO_QUEUE_WORKER_ENABLED = "false";
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    return moduleRef.createNestApplicationContext ? moduleRef : moduleRef;
  };

  beforeAll(async () => {
    // Minimal single-node .osm inside the CZ bbox (lng 18.4, lat 49.5).
    writeFileSync(
      join(dir, "cz.osm"),
      `<?xml version="1.0"?><osm version="0.6">` +
        `<node id="1" lat="49.5" lon="18.4"><tag k="amenity" v="restaurant"/>` +
        `<tag k="name" v="E2E Diner"/></node></osm>`,
    );
    app = await buildContext();
  });

  afterAll(async () => {
    const ds = (app as any).get(getDataSourceToken("poi")) as DataSource;
    await ds.query(`DELETE FROM pois WHERE external_id = 'node/1'`);
    await (app as any).close?.();
  });

  it("upserts the region's POIs and stamps coverage", async () => {
    const svc = (app as any).get(PoiImportService) as PoiImportService;
    const region = svc.regions.find((r) => r.code === "CZ")!;
    const result = await svc.importRegion(region);
    expect(result.upserted).toBeGreaterThanOrEqual(1);
    const ds = (app as any).get(getDataSourceToken("poi")) as DataSource;
    const [row] = await ds.query(
      `SELECT imported_at FROM poi_import_regions WHERE code = 'CZ'`,
    );
    expect(row?.imported_at).toBeTruthy();
  });
});
```

Add `apps/ingest/test/jest-e2e.json` mirroring the backend's e2e config and a `"test:e2e": "jest --config ./test/jest-e2e.json"` script.

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `pnpm db:up && pnpm --filter @tarmoto/ingest-service test:e2e`
Expected: FAIL — `PoiImportService` / `poi.module` not present in `apps/ingest` yet.

- [ ] **Step 3: Move the engine files into `apps/ingest` (verbatim) + repoint intra-app imports**

`git mv` the engine `.ts`/`.spec.ts` files, the two CLIs + `bootstrap-script-context.ts`, `poi-import.config.ts`, and the geojson asset into `apps/ingest/` per the Files list. These are verbatim moves; only the import specifiers change:

- `Poi` / `PoiImportRun` imports → `@tarmoto/poi-db` (already the case in the moved bodies after T2's rewire; verify).
- Mapper imports (`poi-import-source`, `poi-import.lock`, `poi-extract-source`) → `@tarmoto/ingest` (already the case after T3).
- `poi-import.processor.ts`: its `JOB_NAMES`/`QUEUE_NAMES` references (from the backend `jobs.constants.ts`) repoint to `@tarmoto/ingest`'s `POI_IMPORT_QUEUE`/`POI_IMPORT_JOB`; its `JobsProducer` dependency (for `enqueuePoiImportRegion` fan-out) is satisfied by a small `apps/ingest`-local producer OR by moving the `enqueuePoiImportRegion` method into the ingest jobs module — reuse the backend's `POI_IMPORT_STAGGER_MS` + `enqueuePoiImportRegion` verbatim into `apps/ingest/src/poi/jobs.module.ts`'s producer. `PoiImportService`/`PoiImportRunRecorder`/`POI_IMPORT_SOURCES` imports become app-local (`./poi-import.service.js`, `./poi-import-run.recorder.js`).
- `import-pois.ts` + `load-region-boundaries.ts`: their `bootstrapScriptContext` import stays relative (moved sibling); `load-region-boundaries.ts`'s `DEFAULT_REGIONS` import stays `@tarmoto/ingest`; the asset path (`../assets/import-region-boundaries.geojson`) resolves under `apps/ingest/dist/assets` via the nest-cli glob added in T4.

- [ ] **Step 4: Wire the `apps/ingest` DI (PoiDatabaseModule, PoiModule, JobsModule, scheduler)**

`apps/ingest/src/poi/poi-database.module.ts` (migrator variant — fail-fast, reuses the package options):

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { buildPoiTypeOrmOptions, poiDatabaseConfig } from "@tarmoto/poi-db";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: "poi",
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      // apps/ingest OWNS the POI schema: it migrates on boot. Unlike the backend
      // reader it must fail fast if the DB is down (a migrator can't tolerate-down).
      useFactory: (config: ConfigService) =>
        buildPoiTypeOrmOptions(config, { migrationsRun: true }),
      dataSourceFactory: (options) => new DataSource(options!).initialize(),
    }),
  ],
})
export class PoiDatabaseModule {}
```

`apps/ingest/src/poi/poi.module.ts` — reuse the backend `PoiModule`'s import-provider wiring near-verbatim, dropping the reader-only pieces (`PoiController`, `PoiService`, `PoiStoreService`, `OverpassPoiProvider`, `PoiImportAdminService`) and keeping the two `PoiImportService` instances + `POI_IMPORT_SOURCES` + `PoiImportRunRecorder`, plus `TypeOrmModule.forFeature([PoiImportRun], 'poi')` and `ConfigModule.forFeature(poiImportConfig|fsqImportConfig)`:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, type ConfigType } from "@nestjs/config";
import { getDataSourceToken, TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PoiImportRun } from "@tarmoto/poi-db";
import { FsqPoiImportSource } from "@tarmoto/ingest";
import {
  FSQ_POI_IMPORT,
  POI_IMPORT_SOURCES,
  PoiImportService,
} from "./poi-import.service.js";
import { PoiImportRunRecorder } from "./poi-import-run.recorder.js";
import { fsqImportConfig, poiImportConfig } from "./poi-import.config.js";
import { PoiDatabaseModule } from "./poi-database.module.js";

@Module({
  imports: [
    ConfigModule.forFeature(poiImportConfig),
    ConfigModule.forFeature(fsqImportConfig),
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], "poi"),
  ],
  providers: [
    PoiImportService,
    PoiImportRunRecorder,
    {
      provide: FSQ_POI_IMPORT,
      useFactory: (
        dataSource: DataSource,
        config: ConfigType<typeof fsqImportConfig>,
      ) => new PoiImportService(dataSource, config, new FsqPoiImportSource()),
      inject: [getDataSourceToken("poi"), fsqImportConfig.KEY],
    },
    {
      provide: POI_IMPORT_SOURCES,
      useFactory: (osm: PoiImportService, fsq: PoiImportService) => [osm, fsq],
      inject: [PoiImportService, FSQ_POI_IMPORT],
    },
  ],
  exports: [
    PoiImportService,
    FSQ_POI_IMPORT,
    POI_IMPORT_SOURCES,
    PoiImportRunRecorder,
  ],
})
export class PoiModule {}
```

`apps/ingest/src/poi/jobs.module.ts` — BullMQ root (reuse the backend's `buildJobsConfig`/connection pattern, or a minimal Redis connection from `TARMOTO_REDIS_*`), register the `POI_IMPORT_QUEUE` queue, and — gated on `TARMOTO_QUEUE_WORKER_ENABLED !== 'false'` — the `PoiImportProcessor` (worker) + the `PoiImportScheduler`. Import `PoiModule` so the processor gets `POI_IMPORT_SOURCES` + `PoiImportRunRecorder`. Provide the local producer (moved `enqueuePoiImportRegion` + `POI_IMPORT_STAGGER_MS`).

`apps/ingest/src/poi/poi-import.scheduler.ts` — extract the `poi.import` recurring registration from the backend `jobs.scheduler.ts` (`upsertJobScheduler` on `POI_IMPORT_QUEUE` with `POI_IMPORT_JOB.DISPATCH` @ `POI_IMPORT_WEEKLY_CRON`, plus the `removeRetiredSchedulers` `${queue}.run` cleanup), as a standalone `OnApplicationBootstrap` provider gated on the worker toggle.

Wire them into `apps/ingest/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health.controller.js";
import { PoiModule } from "./poi/poi.module.js";
import { PoiJobsModule } from "./poi/jobs.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PoiModule,
    PoiJobsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

Add the extract/parse runtime deps to `apps/ingest/package.json` `dependencies`: `"sax": "^1.6.0"`, `"fast-xml-parser": "^5.5.12"`, `"dotenv": "^17.4.2"`; devDeps `"@types/sax": "^1.2.7"`. Add scripts:

```json
    "poi:import": "node dist/scripts/import-pois.js",
    "fsq:import": "node dist/scripts/import-pois.js fsq",
    "poi:load-boundaries": "node dist/scripts/load-region-boundaries.js",
    "db:migrate:poi": "typeorm migration:run -d node_modules/@tarmoto/poi-db/dist/data-source.js",
    "db:revert:poi": "typeorm migration:revert -d node_modules/@tarmoto/poi-db/dist/data-source.js",
    "test:e2e": "jest --config ./test/jest-e2e.json"
```

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `pnpm db:up && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test && pnpm --filter @tarmoto/ingest-service test:e2e`
Expected: build exits 0; the moved unit specs (service/recorder/processor) pass under jest in `apps/ingest`; the real-PG e2e upserts + stamps coverage and PASSES.

- [ ] **Step 6: Slim the backend — delete the engine + flip the cutover**

- `apps/backend/src/modules/poi/poi-database.module.ts`: change the `useFactory` to `buildPoiTypeOrmOptions(config, { migrationsRun: false })` — the backend no longer migrates the POI DB (reads only, tolerant of an ahead schema).
- `apps/backend/src/modules/jobs/jobs.module.ts`: remove `import { PoiImportProcessor } …` and its entry from `PROCESSOR_PROVIDERS`; the backend keeps `PoiModule` in imports only if still needed (it is not, once the processor is gone — remove the `PoiModule` import from `jobs.module.ts`). The `poi.import` queue name stays in `ALL_QUEUE_NAMES` so the producer registers it.
- `apps/backend/src/modules/jobs/jobs.scheduler.ts`: remove the `@InjectQueue(QUEUE_NAMES.POI_IMPORT) poiImport` constructor param, its spec entry in `specs()`, and the `poiImport` line in `removeRetiredSchedulers()`. Leave the OSM entries intact. Update `jobs.scheduler.spec.ts` to drop the poi.import expectations (they now live in `apps/ingest`).
- `apps/backend/src/modules/poi/poi.module.ts`: delete the moved providers (`PoiImportService`, `PoiImportRunRecorder`, `FSQ_POI_IMPORT` factory, `POI_IMPORT_SOURCES`, `poiImportConfig`/`fsqImportConfig` imports); keep `PoiController`, `PoiService`, `PoiStoreService`, `OverpassPoiProvider`, `PoiImportAdminService`, `TypeOrmModule.forFeature([PoiImportRun], 'poi')`, `PoiDatabaseModule`, and `BullModule.registerQueue({ name: QUEUE_NAMES.POI_IMPORT })` (producer-only, so the admin service can `@InjectQueue` it for status reads + enqueue).
- `git mv` deletes the moved originals; confirm no dangling backend imports remain (`grep` for the moved paths).

- [ ] **Step 7: Rework `PoiImportAdminService` to decouple from `POI_IMPORT_SOURCES`**

Replace the injected `@Inject(POI_IMPORT_SOURCES) importers: readonly PoiImportService[]` with a local, ingest-free metadata source:

```ts
import {
  DEFAULT_REGIONS,
  OsmPoiImportSource,
  FsqPoiImportSource,
  type PoiImportRegion,
  type PoiImportSource,
} from "@tarmoto/ingest";
import { join } from "node:path";

// The canonical coverage list + the per-source extract filename/dir logic, read
// from the shared lib + this front-door's OWN env (it writes uploads to these
// dirs), so the backend admin view no longer depends on the ingestion service's
// private config (Phase-2 seam).
const SOURCE_STRATEGIES: Record<string, PoiImportSource> = {
  osm: new OsmPoiImportSource(),
  fsq: new FsqPoiImportSource(),
};
```

Then, in the (private) helpers the public methods use, replace every `importer.*` read:

- `importer.source` → the string key (`'osm'` / `'fsq'`).
- `importer.regions` → `DEFAULT_REGIONS` (the canonical list).
- `importer.extractDirConfigured` → `Boolean(this.extractDir(source))` where `extractDir(source)` reads `TARMOTO_POI_IMPORT_DIR` / `TARMOTO_FSQ_IMPORT_DIR`.
- `importer.getExtractPath(code)` → `join(this.extractDir(source)!, SOURCE_STRATEGIES[source].extractFilename(regionFor(code)))`.
- `importerFor(source)` → resolve the strategy + dir instead of an injected service.

Drop the `@Inject(POI_IMPORT_SOURCES)` + `type PoiImportService` imports. Update `poi-import-admin.service.spec.ts`: its fake `POI_IMPORT_SOURCES` array becomes env + `DEFAULT_REGIONS` fixtures; the enqueue/status/upload assertions are unchanged in intent. _(The compiler + this spec + the admin controller e2e are the completeness gate for this rework.)_

Repoint the root scripts in `package.json` to build+run `@tarmoto/ingest-service`:

```json
    "db:migrate:poi": "pnpm poi-db:build && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service db:migrate:poi",
    "poi:import": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service poi:import",
    "fsq:import": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service fsq:import",
    "poi:load-boundaries": "pnpm shared:build && pnpm ingest:build && pnpm poi-db:build && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service poi:load-boundaries",
```

_(`db:migrate:poi` no longer needs `backend:build`; it uses `@tarmoto/poi-db`'s CLI DataSource via `@tarmoto/ingest-service`.)_

- [ ] **Step 8: Run both suites + boot `apps/ingest` as a worker**

Run: `pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test && pnpm --filter @tarmoto/ingest-service test:e2e && pnpm backend:build && pnpm --filter @tarmoto/backend test`
Expected: `apps/ingest` builds + all its specs + the e2e pass; the backend builds minus the deleted engine and its full jest suite passes (POI read + slimmed admin tests green).

- [ ] **Step 9: Verify the worker boots + applies migrations**

Run: `pnpm db:up && pnpm --filter @tarmoto/ingest-service start` (Ctrl-C after boot)
Expected: boot log shows the POI DB connected + migrations applied (`migrationsRun: true`), the `poi.import` scheduler registered, and `GET /healthz` returns 200.

- [ ] **Step 10: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output (no controller/DTO moved — the admin controller is unchanged; only the admin service's internals changed).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(cross): move POI import engine to apps/ingest and slim the backend

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Move the extract SCRIPTS into `apps/ingest`

Relocate the three already-framework-free extract-refresh scripts (and their shared helper + specs) from `apps/backend/src/scripts/` into `apps/ingest/src/scripts/`. They import only `@tarmoto/ingest` + Node stdlib, so the move is nearly pure — only relative `refresh-common` paths and the npm-script owners change.

**Files:**

- Move: `apps/backend/src/scripts/refresh-common.ts` → `apps/ingest/src/scripts/refresh-common.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/scripts/refresh-poi-extracts.ts` → `apps/ingest/src/scripts/refresh-poi-extracts.ts` (+ `.spec.ts`)
- Move: `apps/backend/src/scripts/refresh-fsq-extracts.ts` → `apps/ingest/src/scripts/refresh-fsq-extracts.ts` (+ `.spec.ts`)
- Modify: `apps/ingest/package.json` — add `poi:refresh` / `fsq:refresh` scripts
- Modify: `package.json` (root) — repoint `poi:refresh` / `fsq:refresh` to `@tarmoto/ingest-service` (if root-level owners exist) — note the backend `package.json` also carries `poi:refresh`/`fsq:refresh` scripts; move those to `apps/ingest/package.json` and remove from `apps/backend/package.json`
- Delete (from backend): the moved scripts + specs + the backend `poi:refresh`/`fsq:refresh` scripts (via `git mv` + manifest edit)

**Interfaces:**

- Consumes: `@tarmoto/ingest` (`DEFAULT_REGIONS`, `PoiImportRegion`, refresh-config), `refresh-common` (moved sibling).
- Produces: `apps/ingest`-owned extract scripts at `dist/scripts/refresh-poi-extracts.js` + `refresh-fsq-extracts.js` (the T7 Dockerfile CMD/`docker exec` targets).

**Notes on decisions:**

- These scripts touch no DB and no Nest DI (they shell out to osmium/duckdb), so no wiring beyond the file move + the relative `./refresh-common.js` import (unchanged, moves as a sibling).
- `refresh-fsq-extracts.ts` imports `type PoiImportRegion` from `@tarmoto/ingest` (unchanged); `refresh-poi-extracts.ts` + `refresh-common.ts` likewise import only `@tarmoto/ingest` + Node stdlib.

- [ ] **Step 1: Move the scripts (verbatim) as the change under test**

`git mv` the three scripts + their `.spec.ts` siblings into `apps/ingest/src/scripts/`. No import edits are needed beyond confirming `./refresh-common.js` resolves as a sibling. Remove `poi:refresh` + `fsq:refresh` from `apps/backend/package.json` `scripts`; add to `apps/ingest/package.json` `scripts`:

```json
    "poi:refresh": "node dist/scripts/refresh-poi-extracts.js",
    "fsq:refresh": "node dist/scripts/refresh-fsq-extracts.js"
```

- [ ] **Step 2: Run the refresh specs in `apps/ingest` to verify they pass**

Run: `pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test -- refresh`
Expected: the three refresh specs run under jest in `apps/ingest` and PASS (they were `@tarmoto/ingest`-only, so they resolve cleanly).

- [ ] **Step 3: Run the backend suite to confirm nothing dangles**

Run: `pnpm backend:build && pnpm --filter @tarmoto/backend test`
Expected: backend builds + full suite green (no references to the moved scripts remain).

- [ ] **Step 4: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cross): move POI extract refresh scripts to apps/ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Docker + CI + deploy + build-chain wiring

Give `apps/ingest` its own container image (composed from the backend image + the retired `Dockerfile.poi-refresh`), its CI + deploy workflow pair (mirroring the backend), and finish the build-chain / path-filter wiring so `packages/poi-db/**` triggers and builds everywhere the backend does. Retire `Dockerfile.poi-refresh`.

**Files:**

- Create: `apps/ingest/Dockerfile`
- Create: `.github/workflows/ingest-ci.yml`
- Create: `.github/workflows/ingest-deploy.yml`
- Delete: `apps/backend/Dockerfile.poi-refresh`
- Modify: `.github/workflows/backend-ci.yml` — add `packages/poi-db/**` to both `paths` blocks
- Modify: `.github/workflows/backend-deploy.yml` — add `packages/poi-db/**` to `paths`
- Modify: `package.json` (root) — no new script needed (`poi-db:build` added in T2); confirm the ingest-service build script chain

**Interfaces:**

- Consumes: everything from T1–T6 (the package builds + the app build + the moved scripts).
- Produces: a deployable `@tarmoto/ingest-service` image (osmium + duckdb + the Nest worker) and its CI/deploy pipeline; retirement of the standalone refresh container.

**Notes on decisions:**

- The ingest image folds the `Dockerfile.poi-refresh` provisioning (Debian `node:24-slim`, `osmium-tool` + pinned `duckdb v1.4.0` + `tini`, uid/gid `100/101` matching the shared-volume owner, `TARMOTO_*_IMPORT_DIR` seeding, `HOME=/home/tarmoto` for DuckDB's extension cache) into a single always-on Nest worker image. `CMD` runs the Nest app (worker + scheduler); the heavy extract stays a Coolify scheduled `docker exec` of `dist/scripts/refresh-*.js` (a one-shot CMD would restart-loop and re-download multi-GB PBFs).
- The healthcheck targets `/healthz` (the T4 endpoint, no global prefix).
- The build stage compiles `shared` + `ingest` + `poi-db` + `ingest-service` (the app depends on all three packages).

- [ ] **Step 1: Write `apps/ingest/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.23
#
# Tarmoto POI ingestion service (apps/ingest) — the always-on NestJS worker that
# owns the POI write path: the `poi.import` BullMQ worker + weekly scheduler +
# POI-DB migrations. Replaces BOTH the backend worker's poi-import role AND the
# retired apps/backend/Dockerfile.poi-refresh (its osmium/duckdb provisioning +
# uid/gid 100/101 fold in here). The heavy EXTRACT stays a Coolify scheduled
# `docker exec` of dist/scripts/refresh-*.js into this running container.
#
# DEBIAN (node:24-slim), not Alpine: Alpine ships only libosmium, not the
# `osmium` CLI. Base + pnpm are hardcoded (the PaaS auto-injects env as build
# ARGs; a stray NODE_VERSION/packageManager would otherwise break the build).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /workspace

# ---------- deps ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/ingest/package.json apps/ingest/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/poi-db/package.json packages/poi-db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ingest packages/ingest
COPY packages/poi-db packages/poi-db
COPY apps/ingest apps/ingest
RUN pnpm --filter @tarmoto/shared build \
 && pnpm --filter @tarmoto/ingest build \
 && pnpm --filter @tarmoto/poi-db build \
 && pnpm --filter @tarmoto/ingest-service build

# ---------- runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
# osmium-tool (OSM CLI) + a pinned duckdb 1.4.0 (FSQ Iceberg pull, >=1.4.0 for the
# REST catalog) + tini. curl/unzip removed after use; ca-certificates kept for TLS.
# Runtime user pinned uid 100 / gid 101 to MATCH the shared extract volume owner.
# HOME points at the user's dir so DuckDB's ~/.duckdb extension cache is writable.
RUN arch="$(dpkg --print-architecture)" \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      osmium-tool tini ca-certificates curl unzip \
 && curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v1.4.0/duckdb_cli-linux-${arch}.zip" \
 && unzip -o /tmp/duckdb.zip -d /usr/local/bin \
 && rm /tmp/duckdb.zip \
 && chmod +x /usr/local/bin/duckdb \
 && apt-get purge -y curl unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && duckdb --version \
 && groupadd -g 101 tarmoto \
 && useradd -u 100 -g 101 -m -d /home/tarmoto -s /usr/sbin/nologin tarmoto
WORKDIR /app

COPY --from=build /workspace/pnpm-workspace.yaml /workspace/package.json /workspace/pnpm-lock.yaml ./
COPY --from=build /workspace/apps/ingest/package.json apps/ingest/package.json
COPY --from=build /workspace/packages/shared/package.json packages/shared/package.json
COPY --from=build /workspace/packages/ingest/package.json packages/ingest/package.json
COPY --from=build /workspace/packages/poi-db/package.json packages/poi-db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @tarmoto/ingest-service...

COPY --from=build /workspace/apps/ingest/dist apps/ingest/dist
COPY --from=build /workspace/packages/shared/dist packages/shared/dist
COPY --from=build /workspace/packages/ingest/dist packages/ingest/dist
COPY --from=build /workspace/packages/poi-db/dist packages/poi-db/dist

# Seed the extract-volume mount points owned by uid 100 so a FRESH named volume
# comes up writable (Docker copies the empty volume's owner from the image mount
# point on first mount). Both the OSM dir and the FSQ dir (may be one shared path).
ARG TARMOTO_POI_IMPORT_DIR=/data/poi-extracts
ARG TARMOTO_FSQ_IMPORT_DIR=/data/poi-extracts
RUN osm="${TARMOTO_POI_IMPORT_DIR:-/data/poi-extracts}" \
 && fsq="${TARMOTO_FSQ_IMPORT_DIR:-/data/poi-extracts}" \
 && mkdir -p "$osm" "$fsq" \
 && chown tarmoto:tarmoto "$osm" "$fsq"

ENV HOME=/home/tarmoto
USER tarmoto
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD curl --fail --silent "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Always-on worker + scheduler + POI migrations (migrationsRun applies on boot).
# The heavy EXTRACT is a scheduled `docker exec` of dist/scripts/refresh-*.js:
#   OSM (weekly):  node apps/ingest/dist/scripts/refresh-poi-extracts.js
#   FSQ (monthly): node apps/ingest/dist/scripts/refresh-fsq-extracts.js
CMD ["node", "apps/ingest/dist/main.js"]
```

Delete `apps/backend/Dockerfile.poi-refresh`.

- [ ] **Step 2: Verify both images build locally**

Run: `docker build -f apps/ingest/Dockerfile -t tarmoto-ingest . && docker build -f apps/backend/Dockerfile -t tarmoto-backend .`
Expected: both images build to completion (the ingest image installs osmium-tool + duckdb 1.4.0 and compiles all three packages + the app; `duckdb --version` prints during build).

- [ ] **Step 3: Add the CI + deploy workflows**

`.github/workflows/ingest-ci.yml` (mirrors `backend-ci.yml`, path filters per the spec):

```yaml
name: Ingest CI

on:
  push:
    branches: [main]
    paths:
      - "apps/ingest/**"
      - "packages/shared/**"
      - "packages/ingest/**"
      - "packages/poi-db/**"
      - "tsconfig.base.json"
      - ".github/workflows/ingest-ci.yml"
  pull_request:
    branches: [main]
    paths:
      - "apps/ingest/**"
      - "packages/shared/**"
      - "packages/ingest/**"
      - "packages/poi-db/**"
      - "tsconfig.base.json"
      - ".github/workflows/ingest-ci.yml"

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 24
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Build shared package
        run: pnpm shared:build
      - name: Build ingest package
        run: pnpm ingest:build
      - name: Build poi-db package
        run: pnpm poi-db:build
      - name: Build ingest service
        run: pnpm --filter @tarmoto/ingest-service build
      - name: Lint ingest service
        run: pnpm --filter @tarmoto/ingest-service lint
      - name: Test ingest service
        run: pnpm --filter @tarmoto/ingest-service test
```

`.github/workflows/ingest-deploy.yml`: copy `backend-deploy.yml` verbatim and substitute — workflow `name: Ingest Deploy`; `paths` = `apps/ingest/**`, `packages/shared/**`, `packages/ingest/**`, `packages/poi-db/**`, `tsconfig.base.json`, `.github/workflows/ingest-deploy.yml`, `scripts/smoke/**`, `scripts/ci/**`; the per-env vars `BACKEND_URL`/`COOLIFY_BACKEND_UUID` → `INGEST_URL`/`COOLIFY_INGEST_UUID`; the healthcheck path `/api/v1/healthz` → `/healthz`; concurrency group `ingest-deploy-…`. (Keep the Coolify API steps + version-stamp + wait-for-deploy + rollback-instructions logic identical.)

- [ ] **Step 4: Add `packages/poi-db/**` to the backend workflow path filters\*\*

In `.github/workflows/backend-ci.yml` add `- "packages/poi-db/**"` after the `packages/ingest/**` line in BOTH the `push.paths` and `pull_request.paths` blocks. In `.github/workflows/backend-deploy.yml` add `- "packages/poi-db/**"` after `packages/ingest/**` in `push.paths`. _(`packages-ci.yml` already covers new packages via `packages/**`; `_build-openapi.yml` gained its poi-db build step in T2.)_

- [ ] **Step 5: Verify OpenAPI byte-identical**

Run: `pnpm openapi:gen && git status --porcelain packages/openapi`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(infra): add apps/ingest image, CI/deploy, and poi-db build wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs / runbook cutover

Document the new topology and the cutover procedure: `apps/ingest` owns extract + import + POI migrations + `poi:load-boundaries`; deploy order is `apps/ingest` first (applies migrations) then the slimmed backend; the `poi-refresh` container is retired (folded into `apps/ingest`). Repoint any pointers Phase 1 left aimed at the backend for the now-moved items. Docs-only — no code, no gate on `openapi:gen`.

**Files:**

- Modify: `docs/process/runbook.md`
- Modify: `docs/reference/data-sources-and-storage.md`

**Interfaces:**

- Consumes: the final topology from T1–T7.
- Produces: operator-facing docs matching the shipped architecture.

- [ ] **Step 1: Update the runbook**

In `docs/process/runbook.md`, edit the POI-pipeline sections so they read against `apps/ingest`:

- The scheduled EXTRACT (OSM weekly / FSQ monthly) runs as a Coolify scheduled `docker exec` into the **`apps/ingest`** container: `node apps/ingest/dist/scripts/refresh-poi-extracts.js` / `refresh-fsq-extracts.js` (the standalone `Dockerfile.poi-refresh` container is retired).
- The scheduled IMPORT (`poi.import` weekly cron) + the admin-triggered import both run in **`apps/ingest`**'s BullMQ worker; the backend only enqueues.
- `poi:load-boundaries` (the required pre-first-import step) now runs from `apps/ingest`: `pnpm poi:load-boundaries` (repointed to build+run `@tarmoto/ingest-service`) or `docker exec … node apps/ingest/dist/scripts/load-region-boundaries.js`. The ORDERING FOOTGUN is unchanged: load boundaries BEFORE the first import (the coverage stamp is an existing-row-only UPDATE).
- POI migrations are owned by `apps/ingest` (`migrationsRun: true`); the backend runs `migrationsRun: false`. **Deploy order at cutover: `apps/ingest` FIRST (applies any pending POI migrations), THEN the slimmed backend** (a tolerant reader of an ahead schema).
- New deployable: `@tarmoto/ingest-service` via the same Coolify-API mechanism (auto-deploy off, CI-triggered). Note the new per-env vars `INGEST_URL` / `COOLIFY_INGEST_UUID`.

- [ ] **Step 2: Update the data-sources reference**

In `docs/reference/data-sources-and-storage.md`, update the POI write-path description: extract + import + POI schema live in `apps/ingest` + `@tarmoto/poi-db` + `@tarmoto/ingest`; the backend is a POI reader + admin front-door (producer-only `poi.import` queue). The shared `/data/poi-extracts` volume + Redis contract is unchanged (upload on backend, read on ingest; `.part` admin vs `.refresh.part` scheduled temp suffixes stay distinct).

- [ ] **Step 3: Sanity-check the docs render + links**

Run: `pnpm --filter @tarmoto/backend lint || true` (docs are markdown; confirm no broken code fences) and re-read both files for stale `apps/backend/dist/scripts/refresh-*` / `Dockerfile.poi-refresh` references.
Expected: no remaining pointers at the backend for the moved extract/import/migration items.

- [ ] **Step 4: Commit**

```bash
git add docs/process/runbook.md docs/reference/data-sources-and-storage.md
git commit -m "docs(cross): cut the POI pipeline runbook over to apps/ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** — every design section maps to a task:

- Package/app topology (`@tarmoto/poi-db`, grown `@tarmoto/ingest`, `apps/ingest`) → T1/T4 scaffold, T2/T3 fill, T5 engine.
- Moves-into-`@tarmoto/ingest` (5 pure mappers + queue constants) → T3.
- Moves-into-`@tarmoto/poi-db` (entities, migrations, config, CLI DataSource) → T2.
- Moves-into-`apps/ingest` (engine + scheduler + CLIs + config + extract scripts) → T5 + T6.
- Stays-in-backend (reader + slimmed admin front-door + producer queue) → T5 (slim + admin rework).
- Seam = `poi.import` queue → T3 (constants) + T5 (producer stays, worker moves).
- Schema ownership + migration cutover (ingest `true` / backend `false`, ingest-first deploy) → the Global-Constraints ordering block + T2 (`true`) → T5 (flip).
- Runtime/deploy topology (one container folds refresh + worker; retire `Dockerfile.poi-refresh`) → T7.
- Build/CI/deploy wiring (build order, path filters, `_build-openapi.yml`) → T2 (build chains + `_build-openapi.yml`) + T7 (Docker + CI/deploy + backend path filters).
- Testing strategy (moved specs to new homes, real-PG e2e, migration-parity guard, byte-identical `openapi:gen`) → each task's gate + the T2 guard + the T5 e2e.
- Docs/runbook cutover → T8.

**Type consistency** — `buildPoiTypeOrmOptions(config: ConfigService, { migrationsRun: boolean })` is identical in T2 Produces, the T2 backend call (`{ migrationsRun: true }`), and both T5 calls (`apps/ingest` `true` / backend `false`). `POI_IMPORT_QUEUE` / `POI_IMPORT_JOB` / `POI_IMPORT_WEEKLY_CRON` (T3 Produces) are the exact symbols T5's processor/scheduler consume. `POI_MIGRATIONS` (T2) is consumed by both the CLI DataSource and the options builder and guarded by the T2 spec. `PoiImportSource` / `StorableImportRow` (T3 Produces) are the exact types the T3 stub source and the T5 engine use.

**Placeholder scan** — no TBD/"similar to above". The two non-mechanical reworks (T3 service-spec stub, T5 admin decoupling) carry concrete code + the exact touched sites, with the green suite as the completeness gate (the writing-plans convention for verbatim-move tasks). Every gate names an exact command + expected result.

**Migration-cutover correctness** — backend stays `migrationsRun: true` through T2/T3/T4 (schema never orphaned while `apps/ingest` doesn't yet migrate); T5 is the single flip point (backend → `false`, `apps/ingest` → `true`) with ingest-first deploy documented in T8. Correct and explicit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-ingest-service-extraction.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for T5, which is large enough to warrant a mid-task checkpoint (consider running it as 5a engine-up / 5b backend-slim).

**REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development — fresh subagent per task + two-stage review.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**REQUIRED SUB-SKILL:** Use superpowers:executing-plans — batch execution with checkpoints.

**Which approach?**
