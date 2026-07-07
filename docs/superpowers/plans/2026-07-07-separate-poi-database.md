# Separate POI Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `pois` table to its own PostgreSQL/PostGIS instance behind a second, resilient TypeORM connection so the app tolerates the POI DB being down.

**Architecture:** The backend keeps its default connection for every app entity and gains a second **named connection `'poi'`** holding only the `Poi` entity. The `'poi'` connection is wired with a custom `dataSourceFactory` that never throws at boot (background retry), so the app starts even if the POI DB is absent. `PoiStoreService`/`PoiImportService` inject the `'poi'` `DataSource` and access the repository behind an `isInitialized` guard that returns **503** when it is not connected. `pois` migrations move to their own lineage; the (empty) app-DB table is dropped.

**Tech Stack:** NestJS 11, `@nestjs/typeorm` 11 (`TypeOrmModule.forRootAsync` with `dataSourceFactory`, `@InjectDataSource`), TypeORM 0.3, PostgreSQL 16 / PostGIS 3.4, Docker Compose, Jest.

Design source of truth: `docs/decisions/0007-separate-poi-database.md`.

## Global Constraints

- App-owned env vars use the `TARMOTO_` prefix (carve-outs: `NODE_ENV`, `PORT`).
- Conventional commits, lowercase subject first char, scope required from the enum (`backend`, `infra`, `cross`, …). One commit per task.
- TypeScript strict, incl. `noUncheckedIndexedAccess` — CI's OpenAPI-gen step catches errors `nest build` may miss.
- App-DB migrations must be registered in BOTH `apps/backend/src/data-source.ts` and `apps/backend/src/modules/database/database.module.ts`. POI-DB migrations must be registered in BOTH `apps/backend/src/data-source.poi.ts` and `apps/backend/src/modules/poi/poi-database.module.ts`.
- No silent fallbacks that hide failures — an unavailable POI DB surfaces as an explicit 503, never an empty 200.
- Run scripts (`poi:import`, cron) already disable BullMQ workers via `bootstrapScriptContext()`; do not regress that.
- Every task ends by running the stated commands and committing.

---

## File Structure

**Create:**

- `apps/backend/src/config/poi-database.config.ts` — `poiDatabaseConfig` `registerAs('poiDatabase', …)`.
- `apps/backend/src/modules/poi/poi-database.module.ts` — resilient `'poi'` connection (tolerant `dataSourceFactory` + background retry).
- `apps/backend/src/data-source.poi.ts` — CLI DataSource for POI migrations.
- `apps/backend/src/migrations-poi/1787000000000-AddPois.ts` — **moved** from `src/migrations/` (unchanged).
- `apps/backend/src/migrations-poi/1793000000000-AddPoiDecisionSupportFields.ts` — **moved** (unchanged).
- `apps/backend/src/migrations/1797000000000-DropPois.ts` — drop the orphan `pois` from the app DB.

**Modify:**

- `apps/backend/src/modules/database/database.module.ts` — remove `Poi` from `entities`; remove `AddPois…`/`AddPoiDecisionSupportFields…` imports + array entries; add `DropPois…`.
- `apps/backend/src/data-source.ts` — same three edits.
- `apps/backend/src/modules/poi/poi.module.ts` — import `PoiDatabaseModule`, drop `TypeOrmModule.forFeature([Poi])`.
- `apps/backend/src/modules/poi/poi-store.service.ts` (+ `.spec.ts`) — inject `@InjectDataSource('poi')`, guarded repo → 503.
- `apps/backend/src/modules/poi/poi-import.service.ts` (+ `.spec.ts`) — same injection change.
- `apps/backend/src/modules/poi/poi.controller.ts` (+ `.spec.ts`) — add `GET /poi/health`.
- `infra/docker/docker-compose.yml` — add `poi-postgres` (`tarmoto-poi-db`) service + `poipgdata` volume.
- `apps/backend/package.json`, root `package.json` — `db:migrate:poi` / `db:revert:poi` scripts + passthroughs.
- `.env.example` (if present) + `docs/process/runbook.md` — document `TARMOTO_POI_DATABASE_*`.

---

## Task 1: POI database config

**Files:**

- Create: `apps/backend/src/config/poi-database.config.ts`
- Test: `apps/backend/src/config/poi-database.config.spec.ts`

**Interfaces:**

- Produces: `poiDatabaseConfig` (a `registerAs('poiDatabase', …)` factory) returning `{ host, port, database, username, password }`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backend/src/config/poi-database.config.spec.ts
import { poiDatabaseConfig } from "./poi-database.config.js";

describe("poiDatabaseConfig", () => {
  const OLD = process.env;
  afterEach(() => {
    process.env = OLD;
  });

  it("defaults to the local poi-db (localhost:5434, tarmoto_poi)", () => {
    process.env = { ...OLD };
    delete process.env.TARMOTO_POI_DATABASE_HOST;
    delete process.env.TARMOTO_POI_DATABASE_PORT;
    delete process.env.TARMOTO_POI_DATABASE_NAME;
    expect(poiDatabaseConfig()).toEqual({
      host: "localhost",
      port: 5434,
      database: "tarmoto_poi",
      username: "tarmoto",
      password: "tarmoto",
    });
  });

  it("reads TARMOTO_POI_DATABASE_* overrides", () => {
    process.env = {
      ...OLD,
      TARMOTO_POI_DATABASE_HOST: "poi.internal",
      TARMOTO_POI_DATABASE_PORT: "6000",
      TARMOTO_POI_DATABASE_NAME: "pois_prod",
      TARMOTO_POI_DATABASE_USER: "poi",
      TARMOTO_POI_DATABASE_PASSWORD: "secret",
    };
    expect(poiDatabaseConfig()).toEqual({
      host: "poi.internal",
      port: 6000,
      database: "pois_prod",
      username: "poi",
      password: "secret",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi-database.config`
Expected: FAIL — cannot find module `./poi-database.config.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/backend/src/config/poi-database.config.ts
import { registerAs } from "@nestjs/config";

// Separate PostGIS instance for POIs (ADR 0007). Mirrors databaseConfig but
// with the TARMOTO_POI_DATABASE_* prefix and a distinct local default port
// (5434) so it doesn't collide with the app DB on 5433.
export const poiDatabaseConfig = registerAs("poiDatabase", () => ({
  host: process.env.TARMOTO_POI_DATABASE_HOST || "localhost",
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || "5434", 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || "tarmoto_poi",
  username: process.env.TARMOTO_POI_DATABASE_USER || "tarmoto",
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || "tarmoto",
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/backend test poi-database.config`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/config/poi-database.config.ts apps/backend/src/config/poi-database.config.spec.ts
git commit -m "feat(backend): add poiDatabaseConfig for the separate POI DB"
```

---

## Task 2: Local POI Postgres service (Docker Compose)

**Files:**

- Modify: `infra/docker/docker-compose.yml` (add a service after `postgres`, and a volume under `volumes:`)

**Interfaces:**

- Produces: a `tarmoto-poi-db` container reachable at host `${TARMOTO_POI_DATABASE_PORT:-5434}` with database `tarmoto_poi`.

- [ ] **Step 1: Add the service** — insert directly after the `postgres` service block (after its `healthcheck`, before `redis:`):

```yaml
poi-postgres:
  container_name: tarmoto-poi-db
  image: postgis/postgis:17-3.4-alpine
  restart: unless-stopped
  # Separate PostGIS instance for POIs (ADR 0007). Host port 5434 so it
  # doesn't clash with the app DB on 5433. Override with
  # TARMOTO_POI_DATABASE_PORT.
  ports:
    - "${TARMOTO_POI_DATABASE_PORT:-5434}:5432"
  environment:
    POSTGRES_USER: ${TARMOTO_POI_DATABASE_USER:-tarmoto}
    POSTGRES_PASSWORD: ${TARMOTO_POI_DATABASE_PASSWORD:-tarmoto}
    POSTGRES_DB: ${TARMOTO_POI_DATABASE_NAME:-tarmoto_poi}
  volumes:
    - poipgdata:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${TARMOTO_POI_DATABASE_USER:-tarmoto}"]
    interval: 5s
    timeout: 5s
    retries: 5
```

- [ ] **Step 2: Add the volume** — under the top-level `volumes:` block, add `poipgdata:` alongside `pgdata:` / `redisdata:` / `miniodata:`.

```yaml
volumes:
  pgdata:
  redisdata:
  miniodata:
  poipgdata:
```

- [ ] **Step 3: Bring it up and verify PostGIS is present**

Run:

```bash
pnpm db:up
docker exec -i tarmoto-poi-db psql -U tarmoto -d tarmoto_poi -c "CREATE EXTENSION IF NOT EXISTS postgis; SELECT postgis_version();"
```

Expected: prints a PostGIS version (e.g. `3.4 …`), no error.

- [ ] **Step 4: Commit**

```bash
git add infra/docker/docker-compose.yml
git commit -m "infra(infra): add tarmoto-poi-db PostGIS service for the POI store"
```

---

## Task 3: POI migration lineage (move migrations + CLI DataSource + scripts)

**Files:**

- Move: `apps/backend/src/migrations/1787000000000-AddPois.ts` → `apps/backend/src/migrations-poi/1787000000000-AddPois.ts`
- Move: `apps/backend/src/migrations/1793000000000-AddPoiDecisionSupportFields.ts` → `apps/backend/src/migrations-poi/1793000000000-AddPoiDecisionSupportFields.ts`
- Create: `apps/backend/src/data-source.poi.ts`
- Modify: `apps/backend/package.json`, root `package.json`

**Interfaces:**

- Consumes: `poiDatabaseConfig` semantics (same env vars), the moved migration classes `AddPois1787000000000`, `AddPoiDecisionSupportFields1793000000000`.
- Produces: `PoiDataSource` (default export-less named export) + `pnpm db:migrate:poi`.

- [ ] **Step 1: Move the two POI migration files (unchanged contents)**

```bash
mkdir -p apps/backend/src/migrations-poi
git mv apps/backend/src/migrations/1787000000000-AddPois.ts apps/backend/src/migrations-poi/1787000000000-AddPois.ts
git mv apps/backend/src/migrations/1793000000000-AddPoiDecisionSupportFields.ts apps/backend/src/migrations-poi/1793000000000-AddPoiDecisionSupportFields.ts
```

- [ ] **Step 2: Create the POI CLI DataSource**

```typescript
// apps/backend/src/data-source.poi.ts
import "dotenv/config";
import { DataSource } from "typeorm";
import { Poi } from "./entities/poi.entity.js";
import { AddPois1787000000000 } from "./migrations-poi/1787000000000-AddPois.js";
import { AddPoiDecisionSupportFields1793000000000 } from "./migrations-poi/1793000000000-AddPoiDecisionSupportFields.js";

// CLI DataSource for the separate POI database (ADR 0007). Used by
// `pnpm db:migrate:poi`. Keep the migrations array in sync with
// `poi-database.module.ts` (runtime `migrationsRun`).
export const PoiDataSource = new DataSource({
  type: "postgres",
  host: process.env.TARMOTO_POI_DATABASE_HOST || "localhost",
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || "5434", 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || "tarmoto_poi",
  username: process.env.TARMOTO_POI_DATABASE_USER || "tarmoto",
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || "tarmoto",
  entities: [Poi],
  migrations: [AddPois1787000000000, AddPoiDecisionSupportFields1793000000000],
  synchronize: false,
});
```

- [ ] **Step 3: Add package scripts**

In `apps/backend/package.json` `scripts`, after `db:revert`:

```json
    "db:migrate:poi": "typeorm migration:run -d dist/data-source.poi.js",
    "db:revert:poi": "typeorm migration:revert -d dist/data-source.poi.js",
```

In root `package.json` `scripts`, after `db:migrate`:

```json
    "db:migrate:poi": "pnpm backend:build && pnpm --filter @tarmoto/backend db:migrate:poi",
```

- [ ] **Step 4: Build, run POI migrations, verify the table + indexes exist in the POI DB**

Run:

```bash
pnpm db:migrate:poi
docker exec -i tarmoto-poi-db psql -U tarmoto -d tarmoto_poi -c "\d+ pois" -c "SELECT indexname FROM pg_indexes WHERE tablename='pois';"
```

Expected: `pois` table with the `geom GEOMETRY(Point,4326)` column and the `idx_pois_geom` (GiST), `idx_pois_tags` (GIN), `uq_pois_source_external`, `idx_pois_kind` indexes.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/migrations-poi apps/backend/src/data-source.poi.ts apps/backend/package.json package.json
git commit -m "feat(backend): POI migration lineage + db:migrate:poi against the POI DB"
```

---

## Task 4: App-DB cutover — drop the orphan `pois`

**Files:**

- Create: `apps/backend/src/migrations/1797000000000-DropPois.ts`
- Modify: `apps/backend/src/modules/database/database.module.ts`, `apps/backend/src/data-source.ts`

**Interfaces:**

- Produces: `DropPois1797000000000` in the app-DB migration chain; `Poi` removed from the app-DB `entities`.

- [ ] **Step 1: Write the DropPois migration**

```typescript
// apps/backend/src/migrations/1797000000000-DropPois.ts
import { MigrationInterface, QueryRunner } from "typeorm";

// ADR 0007: `pois` now lives in its own PostGIS instance. Drop the orphaned
// app-DB copy. Idempotent (IF EXISTS) so it is a no-op on a fresh app DB that
// never ran AddPois. One-way cutover — `down` is intentionally a no-op; the
// table is recreated in the POI DB by its own migration lineage, not here.
export class DropPois1797000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS pois");
  }

  public async down(): Promise<void> {
    // no-op: pois is owned by the separate POI database (ADR 0007).
  }
}
```

- [ ] **Step 2: Edit `database.module.ts`**
  - Remove from `entities` (line ~178): the `Poi,` entry.
  - Remove the two imports: `import { AddPois1787000000000 } …` and `import { AddPoiDecisionSupportFields1793000000000 } …`.
  - Remove `Poi,` from the destructured `entities/index.js` import block.
  - Remove `AddPois1787000000000,` and `AddPoiDecisionSupportFields1793000000000,` from the `migrations` array.
  - Add `import { DropPois1797000000000 } from '../../migrations/1797000000000-DropPois.js';` and append `DropPois1797000000000,` as the **last** entry of the `migrations` array (after `SwapTierNamesAddLaunchMode1796000000000,`).

- [ ] **Step 3: Edit `data-source.ts`** — make the identical five edits (remove `Poi` import + `entities` entry, remove the two POI migration imports + array entries, add the `DropPois1797000000000` import + append it last in `migrations`).

- [ ] **Step 4: Build + run app migrations; verify `pois` is gone from the app DB but present in the POI DB**

Run:

```bash
pnpm db:migrate
docker exec -i tarmoto-db psql -U tarmoto -d tarmoto -c "SELECT to_regclass('public.pois') AS app_pois;"
docker exec -i tarmoto-poi-db psql -U tarmoto -d tarmoto_poi -c "SELECT to_regclass('public.pois') AS poi_pois;"
```

Expected: `app_pois` is NULL (dropped); `poi_pois` is `pois` (present).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/migrations/1797000000000-DropPois.ts apps/backend/src/modules/database/database.module.ts apps/backend/src/data-source.ts
git commit -m "feat(backend): drop the orphan app-DB pois table (ADR 0007 cutover)"
```

---

## Task 5: Resilient `'poi'` connection module

**Files:**

- Create: `apps/backend/src/modules/poi/poi-database.module.ts`
- Test: `apps/backend/src/modules/poi/poi-database.module.spec.ts`

**Interfaces:**

- Consumes: `poiDatabaseConfig`, the two moved migration classes.
- Produces: `PoiDatabaseModule` (registers the `'poi'` TypeORM connection; injectable via `@InjectDataSource('poi')`) and an exported helper `createPoiDataSource(options)` used by the factory and the test.

- [ ] **Step 1: Write the failing test** (the boot-tolerance guarantee)

```typescript
// apps/backend/src/modules/poi/poi-database.module.spec.ts
import { DataSource } from "typeorm";
import { createPoiDataSource } from "./poi-database.module.js";

describe("createPoiDataSource", () => {
  it("returns an uninitialized DataSource without throwing when the DB is unreachable", async () => {
    const options = {
      type: "postgres" as const,
      host: "127.0.0.1",
      port: 1, // nothing listening
      database: "nope",
      username: "x",
      password: "x",
      entities: [],
      migrations: [],
      connectTimeoutMS: 200,
      retryAttempts: 0,
    };
    const ds = await createPoiDataSource(options);
    expect(ds).toBeInstanceOf(DataSource);
    expect(ds.isInitialized).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi-database.module`
Expected: FAIL — cannot find module `./poi-database.module.js`.

- [ ] **Step 3: Write the module + factory**

```typescript
// apps/backend/src/modules/poi/poi-database.module.ts
import { Module, Logger } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, type DataSourceOptions } from "typeorm";
import { Poi } from "../../entities/poi.entity.js";
import { poiDatabaseConfig } from "../../config/poi-database.config.js";
import { AddPois1787000000000 } from "../../migrations-poi/1787000000000-AddPois.js";
import { AddPoiDecisionSupportFields1793000000000 } from "../../migrations-poi/1793000000000-AddPoiDecisionSupportFields.js";

const logger = new Logger("PoiDatabase");
const RETRY_MS = 10_000;

// Build + attempt to connect the POI DataSource WITHOUT ever throwing (ADR
// 0007). On failure the app still boots; the store services 503 until a
// background retry connects. `migrationsRun` in the options means a successful
// initialize() also applies the POI migrations.
export async function createPoiDataSource(
  options: DataSourceOptions,
): Promise<DataSource> {
  const ds = new DataSource(options);
  const connect = async (): Promise<void> => {
    try {
      await ds.initialize();
      logger.log("POI database connected");
    } catch (err) {
      logger.error(
        `POI database unavailable — POI store reads will 503 until it connects: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      setTimeout(() => void connect(), RETRY_MS);
    }
  };
  await connect();
  return ds;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: "poi",
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      useFactory: (config: ConfigService): DataSourceOptions => ({
        type: "postgres",
        name: "poi",
        host: config.get<string>("poiDatabase.host"),
        port: config.get<number>("poiDatabase.port"),
        database: config.get<string>("poiDatabase.database"),
        username: config.get<string>("poiDatabase.username"),
        password: config.get<string>("poiDatabase.password"),
        entities: [Poi],
        migrations: [
          AddPois1787000000000,
          AddPoiDecisionSupportFields1793000000000,
        ],
        migrationsRun: true,
        synchronize: false,
        // We own retries in createPoiDataSource; don't let TypeORM's own
        // retry loop throw at boot.
        retryAttempts: 0,
      }),
      dataSourceFactory: (options) => createPoiDataSource(options!),
    }),
  ],
})
export class PoiDatabaseModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/backend test poi-database.module`
Expected: PASS. (The unreachable host resolves to an uninitialized DataSource, no throw.)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/poi/poi-database.module.ts apps/backend/src/modules/poi/poi-database.module.spec.ts
git commit -m "feat(backend): resilient 'poi' TypeORM connection (tolerates POI DB down)"
```

---

## Task 6: `PoiStoreService` reads via the guarded `'poi'` DataSource

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-store.service.ts`
- Modify: `apps/backend/src/modules/poi/poi-store.service.spec.ts`

**Interfaces:**

- Consumes: `@InjectDataSource('poi')` (from `PoiDatabaseModule`).
- Produces: unchanged public methods (`findInBbox`, `findAlongRoute`, `findById`) that now throw `ServiceUnavailableException` when the POI DB is not connected.

- [ ] **Step 1: Add a failing test for the 503 path**

Add to `poi-store.service.spec.ts` (adapt the existing suite that constructs `PoiStoreService`):

```typescript
import { ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { PoiStoreService } from "./poi-store.service.js";

function serviceWithDataSource(ds: Partial<DataSource>): PoiStoreService {
  return new PoiStoreService(ds as DataSource);
}

describe("PoiStoreService when the POI DB is down", () => {
  it("throws 503 from findInBbox when the DataSource is not initialized", async () => {
    const svc = serviceWithDataSource({ isInitialized: false });
    await expect(
      svc.findInBbox(
        { minLng: 18, minLat: 49, maxLng: 19, maxLat: 50 },
        undefined,
        50,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("throws 503 from findById when the DataSource is not initialized", async () => {
    const svc = serviceWithDataSource({ isInitialized: false });
    await expect(svc.findById("id")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi-store.service`
Expected: FAIL — constructor still expects a `Repository`; `isInitialized`/503 not implemented.

- [ ] **Step 3: Change the injection + add the guard**

In `poi-store.service.ts`:

- Replace the imports:
  ```typescript
  import {
    Injectable,
    ServiceUnavailableException,
    BadRequestException,
  } from "@nestjs/common";
  import { InjectDataSource } from "@nestjs/typeorm";
  import { DataSource, Repository } from "typeorm";
  ```
- Replace the constructor:

  ```typescript
  constructor(
    @InjectDataSource('poi')
    private readonly poiDataSource: DataSource,
  ) {}

  // The POI store lives in a separate, resilient connection (ADR 0007). When
  // it isn't connected, surface an explicit 503 rather than a silent empty
  // result so callers can distinguish "no POIs here" from "store is down".
  private repo(): Repository<Poi> {
    if (!this.poiDataSource.isInitialized) {
      throw new ServiceUnavailableException('POI store is temporarily unavailable');
    }
    return this.poiDataSource.getRepository(Poi);
  }
  ```

- Replace each `this.repo` usage with `this.repo()`: the query builders at lines ~68 and ~126, and the `findOne` at line ~89. Example:

  ```typescript
  const qb = this.repo().createQueryBuilder("poi").where(/* … unchanged … */);
  // …
  const poi = await this.repo().findOne({ where: { id } });
  ```

- [ ] **Step 4: Fix the existing happy-path tests to supply a DataSource**

Where the existing suite built `PoiStoreService` with a mock repository, wrap it:

```typescript
const repo = /* existing mock Repository<Poi> */;
const svc = new PoiStoreService({
  isInitialized: true,
  getRepository: () => repo,
} as unknown as DataSource);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test poi-store.service`
Expected: PASS (503 tests + existing behavior tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/poi/poi-store.service.ts apps/backend/src/modules/poi/poi-store.service.spec.ts
git commit -m "feat(backend): PoiStoreService reads via the guarded 'poi' DataSource (503 when down)"
```

---

## Task 7: `PoiImportService` writes via the guarded `'poi'` DataSource

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-import.service.ts`
- Modify: `apps/backend/src/modules/poi/poi-import.service.spec.ts`

**Interfaces:**

- Consumes: `@InjectDataSource('poi')`.
- Produces: unchanged `import()` / `enabled` / `bbox`; throws `ServiceUnavailableException` when the POI DB is not connected.

- [ ] **Step 1: Add a failing 503 test**

Add to `poi-import.service.spec.ts`:

```typescript
import { ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";

it("throws 503 from import() when the POI DataSource is not initialized", async () => {
  const service = new PoiImportService(
    provider, // existing mock PoiProvider from the suite
    { isInitialized: false } as DataSource,
    config, // existing mock ConfigType<typeof poiImportConfig>
  );
  await expect(service.import()).rejects.toBeInstanceOf(
    ServiceUnavailableException,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi-import.service`
Expected: FAIL — constructor still injects a `Repository`.

- [ ] **Step 3: Change the injection + guard**

In `poi-import.service.ts`:

- Imports:
  ```typescript
  import {
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException,
  } from "@nestjs/common";
  import { InjectDataSource } from "@nestjs/typeorm";
  import { DataSource, Repository } from "typeorm";
  ```
- Constructor: replace `@InjectRepository(Poi) private readonly repo: Repository<Poi>` with:
  ```typescript
  @InjectDataSource('poi')
  private readonly poiDataSource: DataSource,
  ```
  (keep `@Inject(POI_PROVIDER)` and `@Inject(poiImportConfig.KEY)`).
- Add the guard used by `import()`:
  ```typescript
  private repo(): Repository<Poi> {
    if (!this.poiDataSource.isInitialized) {
      throw new ServiceUnavailableException('POI store is temporarily unavailable');
    }
    return this.poiDataSource.getRepository(Poi);
  }
  ```
- In `import()`, replace `this.repo.upsert(part, …)` with `this.repo().upsert(part, …)`. Resolve the repo once before the loop so readiness is checked before the fetch: after computing `rows`, `const repo = this.repo();` then `await repo.upsert(part, …)`.

- [ ] **Step 4: Update existing import tests to pass a DataSource**

Replace the mock-repo constructor arg with `{ isInitialized: true, getRepository: () => repo } as unknown as DataSource`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test poi-import`
Expected: PASS (503 test + existing import/upsert tests + config spec).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/poi/poi-import.service.ts apps/backend/src/modules/poi/poi-import.service.spec.ts
git commit -m "feat(backend): PoiImportService writes via the guarded 'poi' DataSource"
```

---

## Task 8: Wire `PoiModule` to the POI connection + remove `forFeature([Poi])`

**Files:**

- Modify: `apps/backend/src/modules/poi/poi.module.ts`

**Interfaces:**

- Consumes: `PoiDatabaseModule`.
- Produces: a bootable app where `@InjectDataSource('poi')` resolves for the POI services.

- [ ] **Step 1: Edit `poi.module.ts`**
  - Remove `import { TypeOrmModule } from '@nestjs/typeorm';` and `import { Poi } from '../../entities/poi.entity.js';` (no longer referenced here).
  - Add `import { PoiDatabaseModule } from './poi-database.module.js';`.
  - Replace `TypeOrmModule.forFeature([Poi])` in `imports` with `PoiDatabaseModule`.

  Result `imports`:

  ```typescript
  imports: [ConfigModule.forFeature(poiImportConfig), PoiDatabaseModule],
  ```

- [ ] **Step 2: Build the backend (typecheck the whole wiring)**

Run: `pnpm --filter @tarmoto/backend build`
Expected: builds clean (no dangling `Poi`/`TypeOrmModule`/`InjectRepository` references anywhere).

- [ ] **Step 3: Boot the app against both DBs and exercise the store end-to-end**

Run (both DBs up from Task 2; POI migrations applied from Task 3):

```bash
pnpm db:up
pnpm poi:import   # imports the CZ/Beskydy box into the POI DB via the 'poi' connection
docker exec -i tarmoto-poi-db psql -U tarmoto -d tarmoto_poi -c "SELECT count(*) FROM pois;"
```

Expected: `poi:import` prints `fetched=… upserted=…`; the POI DB row count is non-zero.

- [ ] **Step 4: Verify the 503 path live** — stop the POI DB, hit a store endpoint, confirm 503 while the app stays up:

```bash
docker stop tarmoto-poi-db
pnpm backend:dev &   # or an already-running backend
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/v1/poi/in-bbox?min_lng=18&min_lat=49&max_lng=19&max_lat=50"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/healthz"
docker start tarmoto-poi-db
```

Expected: `/poi/in-bbox` → `503`; `/healthz` → `200` (app still alive). After `docker start`, the background retry reconnects within ~10s and `/poi/in-bbox` returns `200` again.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/poi/poi.module.ts
git commit -m "feat(backend): point PoiModule at the separate 'poi' connection"
```

---

## Task 9: POI DB readiness endpoint

**Files:**

- Modify: `apps/backend/src/modules/poi/poi.controller.ts`
- Modify: `apps/backend/src/modules/poi/poi.controller.spec.ts`

**Interfaces:**

- Consumes: a new `PoiStoreService.isReady(): boolean`.
- Produces: `GET /poi/health` → `{ poiDb: 'up' | 'down' }`, always 200 (non-fatal, per ADR 0007).

- [ ] **Step 1: Add `isReady()` to `PoiStoreService`**

```typescript
// poi-store.service.ts
isReady(): boolean {
  return this.poiDataSource.isInitialized;
}
```

- [ ] **Step 2: Write the failing controller test**

Add to `poi.controller.spec.ts` (a lightweight unit test constructing the controller with a stub store):

```typescript
it("GET /poi/health reports poiDb up/down without failing", () => {
  const store = { isReady: () => false } as unknown as PoiStoreService;
  const controller = new PoiController({} as PoiService, store);
  expect(controller.health()).toEqual({ poiDb: "down" });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi.controller`
Expected: FAIL — `controller.health` is not a function.

- [ ] **Step 4: Add the endpoint** (declare it BEFORE the `@Get(':id')` catch-all route so it isn't shadowed):

```typescript
@Get('health')
@ApiOperation({
  summary: 'POI store readiness (ADR 0007)',
  description:
    'Reports whether the separate POI database is connected. Always 200 — ' +
    'a "down" POI DB is a degraded, non-fatal state; the store read endpoints ' +
    'return 503 while it is down.',
})
@ApiResponse({ status: 200 })
health(): { poiDb: 'up' | 'down' } {
  return { poiDb: this.poiStore.isReady() ? 'up' : 'down' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test poi.controller`
Expected: PASS.

- [ ] **Step 6: Regenerate the OpenAPI client + verify no unexpected drift**

Run: `pnpm openapi:gen`
Expected: `packages/openapi/openapi.yaml` + `openapi-client/schema.d.ts` gain only the new `/poi/health` path. (Revert any Postman `packages/openapi/postman/*` churn — the generator uses random UUIDs.)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/poi/poi.controller.ts apps/backend/src/modules/poi/poi.controller.spec.ts apps/backend/src/modules/poi/poi-store.service.ts packages/openapi
git commit -m "feat(backend): add GET /poi/health readiness for the separate POI DB"
```

---

## Task 10: Documentation + env template

**Files:**

- Modify: `.env.example` (if it exists), `docs/process/runbook.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the env vars** — if `.env.example` exists, add:

```bash
# Separate POI database (ADR 0007). Local dev uses the tarmoto-poi-db
# Compose service on host port 5434; production points these at a dedicated
# Coolify Postgres instance.
TARMOTO_POI_DATABASE_HOST=localhost
TARMOTO_POI_DATABASE_PORT=5434
TARMOTO_POI_DATABASE_NAME=tarmoto_poi
TARMOTO_POI_DATABASE_USER=tarmoto
TARMOTO_POI_DATABASE_PASSWORD=tarmoto
```

- [ ] **Step 2: Add a runbook note** — in `docs/process/runbook.md`, under the database/migration section, document: the POI DB is a separate instance (ADR 0007); run its migrations with `pnpm db:migrate:poi`; provision a dedicated Coolify Postgres in prod and set `TARMOTO_POI_DATABASE_*`; the backend tolerates the POI DB being down (POI store reads 503, `/poi/health` reports `down`).

- [ ] **Step 3: Verify no code affected**

Run: `pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend test poi`
Expected: build clean; all POI suites pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/process/runbook.md
git commit -m "docs(backend): document the separate POI database + TARMOTO_POI_DATABASE_*"
```

---

## Self-review notes

- **Spec coverage:** ADR sections map to tasks — Topology → 5/8; Resilience → 5/6/7 (+ live check in 8.4); Config → 1; Migrations → 3/4; Provisioning → 2 (+ runbook 10); Observability → 9; "what doesn't change" verified by 8.2 build + 9.6 OpenAPI drift check.
- **Ambiguity resolved:** POI DB local host port is **5434** (app DB already uses 5433, not 5432 as the ADR prose says — fix the ADR's port line when convenient). `DropPois.down` is a documented no-op (one-way cutover). Services access the repo lazily via `@InjectDataSource('poi')` + `isInitialized` guard rather than `forFeature`, because a `forFeature` repository provider would throw at boot when the POI DB is down — defeating "tolerate down".
- **Type consistency:** the guard helper is `repo(): Repository<Poi>` and `isReady(): boolean` in both services/controller; `@InjectDataSource('poi')` used consistently.
