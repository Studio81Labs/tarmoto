# POI Import Admin Management (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator import POIs (OSM + FSQ OS) entirely through the admin UI — upload a pre-produced extract, trigger the import, and see per-`(source, region)` coverage/counts/extract-state/run-history — no SSH.

**Architecture:** A guarded `/admin/poi/*` controller delegates to a `PoiImportAdminService` (POI module) that reads status from the POI DB + extract dir + the `poi.import` BullMQ queue, stores uploaded extracts atomically, and triggers the existing `POI_IMPORT_REGION` job. A new `poi_import_runs` table (POI DB) records every run (cron + manual), written by `PoiImportProcessor`. A new admin-SPA page renders it.

**Tech Stack:** NestJS 11, BullMQ (`@nestjs/bullmq`), TypeORM (POI PostGIS datasource `@InjectDataSource('poi')`), Jest, the admin Vite SPA on `$api`/openapi-react-query.

**Reference spec:** `docs/superpowers/specs/2026-07-13-poi-import-admin-management-design.md`.

## Global Constraints

- TypeScript strict mode everywhere; ESM imports carry the `.js` extension (`import { X } from './x.js'`).
- Conventional commits, scope required (`backend`, `admin`, `cross`, `openapi`).
- Backend stores/serves metric-only — N/A here (no units), but no non-metric assumptions.
- POI DB is a **separate** datasource — inject with `@InjectDataSource('poi')`; its migrations live in `apps/backend/src/migrations-poi/` and register in `poi-database.module.ts` (its own `entities`/`migrations` arrays), NOT the main DB.
- POI DB access stays in the **POI module**; the admin module is a thin HTTP layer over it.
- Admin endpoints are served prefix-less at `/admin/*`; controllers use `InternalGuard` + `AdminAuditInterceptor` (mirror `apps/backend/src/modules/admin/admin-metrics.controller.ts`).
- New admin endpoints require an OpenAPI regen so the admin `$api` client is typed (`pnpm --filter @tarmoto/backend openapi:export` or the repo's `postman:gen`).
- Sources: `'osm'` (extract `<code>.osm`, dir `TARMOTO_POI_IMPORT_DIR`) and `'fsq'` (extract `<code>.fsq.jsonl`, dir `TARMOTO_FSQ_IMPORT_DIR`). Resolve dir+filename from the importer, never hardcode.
- Run the strict OpenAPI-gen build before finishing (`pnpm exec nest build --config nest-cli.openapi.json`) — it catches `noUncheckedIndexedAccess` errors local `nest build` misses.

---

## File Structure

**Backend (`apps/backend/src/`):**

- `entities/poi-import-run.entity.ts` — **create**: `PoiImportRun` entity (POI DB).
- `migrations-poi/1801000000000-AddPoiImportRuns.ts` — **create**: table migration.
- `modules/poi/poi-database.module.ts` — **modify**: register entity + migration.
- `modules/jobs/jobs.producer.ts` — **modify**: add `trigger?` to `PoiImportRegionJobData`.
- `modules/poi/poi-import-run.recorder.ts` — **create**: `PoiImportRunRecorder` (lifecycle writes).
- `modules/poi/poi-import.service.ts` — **modify**: advisory lock in `importRegion`.
- `modules/jobs/processors/poi-import.processor.ts` — **modify**: record runs, read `trigger`.
- `modules/poi/poi-import-admin.service.ts` — **create**: status/runs read + upload + trigger.
- `modules/poi/poi.module.ts` — **modify**: provide/export the new services; inject the queue.
- `modules/admin/dto/poi-import-admin.dto.ts` — **create**: response DTOs.
- `modules/admin/admin-poi.controller.ts` — **create**: `/admin/poi/*` endpoints.
- `modules/admin/admin.module.ts` — **modify**: register the controller.

**Admin SPA (`apps/admin/`):** a new **POI Imports** page + `$api` hooks (exact paths mirror an existing admin page — Task 7).

---

### Task 1: `poi_import_runs` table + entity

**Files:**

- Create: `apps/backend/src/entities/poi-import-run.entity.ts`
- Create: `apps/backend/src/migrations-poi/1801000000000-AddPoiImportRuns.ts`
- Modify: `apps/backend/src/modules/poi/poi-database.module.ts`
- Test: `apps/backend/src/entities/poi-import-run.entity.spec.ts`

**Interfaces:**

- Produces: `PoiImportRun` entity with columns `id, source, region_code, status, trigger, fetched, upserted, tombstoned, skip_reason, error, job_id, started_at, finished_at`. `PoiImportRunStatus = 'running'|'success'|'skipped'|'failed'`, `PoiImportTrigger = 'manual'|'cron'`.

- [ ] **Step 1: Write the failing test** (`poi-import-run.entity.spec.ts`)

```ts
import { PoiImportRun } from "./poi-import-run.entity.js";
import { getMetadataArgsStorage } from "typeorm";

describe("PoiImportRun entity", () => {
  it("maps to the poi_import_runs table with the expected columns", () => {
    const tables = getMetadataArgsStorage().tables;
    const table = tables.find((t) => t.target === PoiImportRun);
    expect(table?.name).toBe("poi_import_runs");

    const cols = getMetadataArgsStorage()
      .columns.filter((c) => c.target === PoiImportRun)
      .map((c) => c.propertyName);
    for (const name of [
      "id",
      "source",
      "region_code",
      "status",
      "trigger",
      "fetched",
      "upserted",
      "tombstoned",
      "skip_reason",
      "error",
      "job_id",
      "started_at",
      "finished_at",
    ]) {
      expect(cols).toContain(name);
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/backend && pnpm exec jest src/entities/poi-import-run.entity.spec.ts`
Expected: FAIL — `Cannot find module './poi-import-run.entity.js'`.

- [ ] **Step 3: Create the entity** (`poi-import-run.entity.ts`)

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type PoiImportRunStatus = "running" | "success" | "skipped" | "failed";
export type PoiImportTrigger = "manual" | "cron";

/**
 * One row per POI import execution attempt (#847 admin management) — cron AND
 * manual, written by PoiImportProcessor. Lives on the POI DB alongside `pois`.
 */
@Entity("poi_import_runs")
@Index("idx_poi_import_runs_region_source_started", [
  "region_code",
  "source",
  "started_at",
])
export class PoiImportRun {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 32 })
  source!: string;

  @Column({ name: "region_code", type: "varchar", length: 2 })
  region_code!: string;

  @Column({ type: "varchar", length: 16 })
  status!: PoiImportRunStatus;

  @Column({ type: "varchar", length: 16 })
  trigger!: PoiImportTrigger;

  @Column({ type: "int", nullable: true })
  fetched!: number | null;

  @Column({ type: "int", nullable: true })
  upserted!: number | null;

  @Column({ type: "int", nullable: true })
  tombstoned!: number | null;

  @Column({ name: "skip_reason", type: "text", nullable: true })
  skip_reason!: string | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({ name: "job_id", type: "varchar", length: 200, nullable: true })
  job_id!: string | null;

  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" })
  started_at!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finished_at!: Date | null;
}
```

- [ ] **Step 4: Create the migration** (`1801000000000-AddPoiImportRuns.ts`)

Mirror an existing `migrations-poi/` file's structure. Single `query()` per statement (untransacted POI DB).

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPoiImportRuns1801000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "poi_import_runs" (
        "id" BIGSERIAL PRIMARY KEY,
        "source" varchar(32) NOT NULL,
        "region_code" varchar(2) NOT NULL,
        "status" varchar(16) NOT NULL,
        "trigger" varchar(16) NOT NULL,
        "fetched" integer,
        "upserted" integer,
        "tombstoned" integer,
        "skip_reason" text,
        "error" text,
        "job_id" varchar(200),
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_poi_import_runs_region_source_started"
        ON "poi_import_runs" ("region_code", "source", "started_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "poi_import_runs"`);
  }
}
```

- [ ] **Step 5: Register in `poi-database.module.ts`**

Add the import and extend the `entities` and `migrations` arrays (find the existing `AddPoiImportRegions1800000000000` reference and the `entities: [Poi]`-style list):

```ts
import { PoiImportRun } from "../../entities/poi-import-run.entity.js";
import { AddPoiImportRuns1801000000000 } from "../../migrations-poi/1801000000000-AddPoiImportRuns.js";
// entities: [Poi, PoiImportRun]
// migrations: [ ...existing, AddPoiImportRuns1801000000000 ]
```

- [ ] **Step 6: Run the entity test, verify pass**

Run: `cd apps/backend && pnpm exec jest src/entities/poi-import-run.entity.spec.ts`
Expected: PASS.

- [ ] **Step 7: Strict build + commit**

```bash
cd apps/backend && pnpm exec nest build --config nest-cli.openapi.json
git add apps/backend/src/entities/poi-import-run.entity.ts apps/backend/src/migrations-poi/1801000000000-AddPoiImportRuns.ts apps/backend/src/modules/poi/poi-database.module.ts apps/backend/src/entities/poi-import-run.entity.spec.ts
git commit -m "feat(backend): add poi_import_runs table + entity (#847)"
```

---

### Task 2: `trigger?` wire field + `PoiImportRunRecorder`

**Files:**

- Modify: `apps/backend/src/modules/jobs/jobs.producer.ts` (`PoiImportRegionJobData`)
- Create: `apps/backend/src/modules/poi/poi-import-run.recorder.ts`
- Modify: `apps/backend/src/modules/poi/poi.module.ts` (provide + export recorder)
- Test: `apps/backend/src/modules/poi/poi-import-run.recorder.spec.ts`

**Interfaces:**

- Consumes: `PoiImportRun` entity (Task 1); `PoiImportResult { region, fetched, upserted, tombstoned, skipped }` from `poi-import.service.ts`.
- Produces: `PoiImportRunRecorder` with:
  - `start(input: { source: string; regionCode: string; trigger: PoiImportTrigger; jobId: string | null }): Promise<string>` → returns the new run `id`.
  - `finish(id: string, result: PoiImportResult): Promise<void>` → sets `success` (or `skipped` with `skip_reason` when `result.skipped`), counts, `finished_at`.
  - `fail(id: string, error: unknown): Promise<void>` → sets `failed`, truncated `error`, `finished_at`.
- `PoiImportRegionJobData` gains `trigger?: 'manual' | 'cron'`.

- [ ] **Step 1: Add `trigger?` to the job data** (`jobs.producer.ts`, the `PoiImportRegionJobData` interface)

```ts
export interface PoiImportRegionJobData {
  code: string;
  source?: string;
  /**
   * Who enqueued this region job (#847). `manual` = an admin trigger via the
   * POI admin UI; `cron`/absent = the weekly dispatcher. Recorded in
   * poi_import_runs so history distinguishes the two.
   */
  trigger?: "manual" | "cron";
}
```

- [ ] **Step 2: Write the failing recorder test** (`poi-import-run.recorder.spec.ts`)

```ts
import { PoiImportRunRecorder } from "./poi-import-run.recorder.js";
import { PoiImportRun } from "../../entities/poi-import-run.entity.js";

function mockRepo() {
  const saved: Partial<PoiImportRun>[] = [];
  return {
    saved,
    create: (v: Partial<PoiImportRun>) => v,
    save: jest.fn(async (v: Partial<PoiImportRun>) => {
      const row = { id: v.id ?? "1", ...v };
      saved.push(row);
      return row;
    }),
    update: jest.fn(async (id: string, patch: Partial<PoiImportRun>) => {
      saved.push({ id, ...patch });
      return { affected: 1 };
    }),
  };
}

describe("PoiImportRunRecorder", () => {
  it("start() inserts a running row and returns its id", async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    const id = await rec.start({
      source: "osm",
      regionCode: "CZ",
      trigger: "manual",
      jobId: "job-1",
    });
    expect(id).toBe("1");
    expect(repo.saved[0]).toMatchObject({
      source: "osm",
      region_code: "CZ",
      status: "running",
      trigger: "manual",
      job_id: "job-1",
    });
  });

  it("finish() records success with counts", async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish("7", {
      region: "CZ",
      fetched: 10,
      upserted: 9,
      tombstoned: 1,
      skipped: false,
    });
    expect(repo.update).toHaveBeenCalledWith(
      "7",
      expect.objectContaining({
        status: "success",
        fetched: 10,
        upserted: 9,
        tombstoned: 1,
      }),
    );
  });

  it("finish() records skipped with a reason", async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.finish("8", {
      region: "CZ",
      fetched: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: true,
    });
    expect(repo.update).toHaveBeenCalledWith(
      "8",
      expect.objectContaining({
        status: "skipped",
      }),
    );
  });

  it("fail() records failed with a truncated error", async () => {
    const repo = mockRepo();
    const rec = new PoiImportRunRecorder(repo as never);
    await rec.fail("9", new Error("boom"));
    expect(repo.update).toHaveBeenCalledWith(
      "9",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("boom"),
      }),
    );
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-run.recorder.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the recorder** (`poi-import-run.recorder.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  PoiImportRun,
  type PoiImportTrigger,
} from "../../entities/poi-import-run.entity.js";
import type { PoiImportResult } from "./poi-import.service.js";

const ERROR_MAX = 2000;

/** Lifecycle writer for `poi_import_runs` (#847). */
@Injectable()
export class PoiImportRunRecorder {
  constructor(
    @InjectRepository(PoiImportRun, "poi")
    private readonly repo: Repository<PoiImportRun>,
  ) {}

  async start(input: {
    source: string;
    regionCode: string;
    trigger: PoiImportTrigger;
    jobId: string | null;
  }): Promise<string> {
    const row = await this.repo.save(
      this.repo.create({
        source: input.source,
        region_code: input.regionCode,
        status: "running",
        trigger: input.trigger,
        job_id: input.jobId,
        started_at: new Date(),
      }),
    );
    return row.id;
  }

  async finish(id: string, result: PoiImportResult): Promise<void> {
    await this.repo.update(id, {
      status: result.skipped ? "skipped" : "success",
      fetched: result.fetched,
      upserted: result.upserted,
      tombstoned: result.tombstoned,
      skip_reason: result.skipped ? this.skipReason(result) : null,
      finished_at: new Date(),
    });
  }

  async fail(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.repo.update(id, {
      status: "failed",
      error: message.slice(0, ERROR_MAX),
      finished_at: new Date(),
    });
  }

  private skipReason(result: PoiImportResult): string {
    // PoiImportResult carries `skipped: true`; if it later carries a reason
    // field, surface it. For now a stable message the UI can show.
    return `import skipped (fetched=${result.fetched}) — extract missing or wipe-guard tripped`;
  }
}
```

- [ ] **Step 5: Provide + export in `poi.module.ts`**

Register `PoiImportRun` in the POI `TypeOrmModule.forFeature([...], 'poi')` list, and add `PoiImportRunRecorder` to `providers` and `exports`:

```ts
import { PoiImportRun } from "../../entities/poi-import-run.entity.js";
import { PoiImportRunRecorder } from "./poi-import-run.recorder.js";
// TypeOrmModule.forFeature([Poi, PoiImportRun], 'poi')
// providers: [ ...existing, PoiImportRunRecorder ]
// exports:  [ ...existing, PoiImportRunRecorder ]
```

- [ ] **Step 6: Run tests, verify pass**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-run.recorder.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/jobs/jobs.producer.ts apps/backend/src/modules/poi/poi-import-run.recorder.ts apps/backend/src/modules/poi/poi-import-run.recorder.spec.ts apps/backend/src/modules/poi/poi.module.ts
git commit -m "feat(backend): poi import run recorder + trigger job field (#847)"
```

---

### Task 3: Record runs in the processor + serialize same-region imports

**Files:**

- Modify: `apps/backend/src/modules/jobs/processors/poi-import.processor.ts`
- Modify: `apps/backend/src/modules/poi/poi-import.service.ts` (advisory lock in `importRegion`)
- Modify: `apps/backend/src/modules/jobs/jobs.module.ts` (ensure `PoiImportRunRecorder` is available to the processor — the POI module already exports it; confirm JobsModule imports PoiModule)
- Test: `apps/backend/src/modules/jobs/processors/poi-import.processor.spec.ts` (extend existing)

**Interfaces:**

- Consumes: `PoiImportRunRecorder` (Task 2); `importRegion(region)`; `PoiImportRegionJobData.trigger` (Task 2).
- Produces: a processor that, per `import-region` job, records `running → success/skipped/failed`; and an `importRegion` that holds a per-`(source, code)` advisory lock while importing.

- [ ] **Step 1: Write the failing processor test** (extend the existing spec)

```ts
it("records a run row for a successful region import", async () => {
  const recorder = {
    start: jest.fn(async () => "run-1"),
    finish: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
  };
  const importer = {
    source: "osm",
    regions: [{ code: "CZ", bbox: {} }],
    importRegion: jest.fn(async () => ({
      region: "CZ",
      fetched: 5,
      upserted: 5,
      tombstoned: 0,
      skipped: false,
    })),
  };
  const processor = new PoiImportProcessor(
    [importer] as never,
    {} as never,
    recorder as never,
  );
  await processor.process({
    name: "import-region",
    id: "j1",
    data: { code: "CZ", source: "osm", trigger: "manual" },
  } as never);

  expect(recorder.start).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "osm",
      regionCode: "CZ",
      trigger: "manual",
      jobId: "j1",
    }),
  );
  expect(recorder.finish).toHaveBeenCalledWith(
    "run-1",
    expect.objectContaining({
      upserted: 5,
    }),
  );
});

it("records failed + rethrows when the import throws", async () => {
  const recorder = {
    start: jest.fn(async () => "r"),
    finish: jest.fn(),
    fail: jest.fn(async () => undefined),
  };
  const importer = {
    source: "osm",
    regions: [{ code: "CZ", bbox: {} }],
    importRegion: jest.fn(async () => {
      throw new Error("parse fail");
    }),
  };
  const processor = new PoiImportProcessor(
    [importer] as never,
    {} as never,
    recorder as never,
  );
  await expect(
    processor.process({
      name: "import-region",
      id: "j2",
      data: { code: "CZ", source: "osm" },
    } as never),
  ).rejects.toThrow("parse fail");
  expect(recorder.fail).toHaveBeenCalledWith("r", expect.any(Error));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/backend && pnpm exec jest src/modules/jobs/processors/poi-import.processor.spec.ts`
Expected: FAIL — `PoiImportProcessor` constructor takes 2 args / `recorder` undefined.

- [ ] **Step 3: Inject the recorder + record around `importRegion`** (`poi-import.processor.ts`)

Add the constructor param and wrap `importRegion` in the private `importRegion(job)` method:

```ts
import { PoiImportRunRecorder } from '../../poi/poi-import-run.recorder.js';
// constructor(... importers, private readonly producer: JobsProducer,
//   private readonly recorder: PoiImportRunRecorder) { super(); }

private async importRegion(job: Job): Promise<PoiImportResult> {
  const data = job.data as { code?: string; source?: string; trigger?: 'manual' | 'cron' };
  if (!data.code) throw new Error('poi-import region job missing code');
  const source = data.source ?? LEGACY_REGION_SOURCE;
  const importer = this.importers.find((i) => i.source === source);
  if (!importer) throw new Error(`poi-import region job unknown source: ${source}`);
  const region = importer.regions.find((r) => r.code === data.code);
  if (!region) throw new Error(`poi-import region job unknown code: ${data.code} (source ${source})`);

  const runId = await this.recorder.start({
    source,
    regionCode: region.code,
    trigger: data.trigger ?? 'cron',
    jobId: job.id ?? null,
  });
  try {
    const result = await importer.importRegion(region);
    await this.recorder.finish(runId, result);
    this.logger.log(
      `[${job.id ?? 'no-id'}] POI import (${source}/${result.region}): ` +
        `fetched=${result.fetched} upserted=${result.upserted} ` +
        `tombstoned=${result.tombstoned}${result.skipped ? ' (skipped)' : ''}`,
    );
    return result;
  } catch (err) {
    await this.recorder.fail(runId, err);
    throw err;
  }
}
```

- [ ] **Step 4: Add the advisory lock in `importRegion`** (`poi-import.service.ts`)

Wrap the region import body so same-`(source, code)` imports serialize. Use a session advisory lock via the POI datasource; release in `finally`. `pg_try_advisory_lock(key1, key2)` is non-blocking — the loser throws so BullMQ retries.

```ts
// Deterministic 32-bit key from source+code so (osm,CZ) and (fsq,CZ) don't collide.
private advisoryKey(source: string, code: string): number {
  const s = `${source}:${code}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// inside importRegion(region), at the top of the DB work:
const LOCK_NAMESPACE = 0x504f_4901; // 'POI\x01' — a fixed namespace for POI import locks
const key = this.advisoryKey(this.source, region.code);
const got = await this.poiDataSource.query(
  'SELECT pg_try_advisory_lock($1, $2) AS locked',
  [LOCK_NAMESPACE, key],
);
if (!got?.[0]?.locked) {
  throw new Error(
    `POI import for ${this.source}/${region.code} is already running — retry later`,
  );
}
try {
  // ... existing fetch + upsert + tombstone body ...
} finally {
  await this.poiDataSource.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, key]);
}
```

(If `importRegion` currently returns early on the wipe-guard path, keep those returns inside the `try` so the `finally` still unlocks.)

- [ ] **Step 5: Run processor tests, verify pass**

Run: `cd apps/backend && pnpm exec jest src/modules/jobs/processors/poi-import.processor.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole POI + jobs suites for regressions**

Run: `cd apps/backend && pnpm exec jest src/modules/poi src/modules/jobs`
Expected: PASS (existing dispatch/import tests still green).

- [ ] **Step 7: Strict build + commit**

```bash
cd apps/backend && pnpm exec nest build --config nest-cli.openapi.json
git add apps/backend/src/modules/jobs/processors/poi-import.processor.ts apps/backend/src/modules/poi/poi-import.service.ts apps/backend/src/modules/jobs/jobs.module.ts apps/backend/src/modules/jobs/processors/poi-import.processor.spec.ts
git commit -m "feat(backend): record poi import runs + serialize same-region imports (#847)"
```

---

### Task 4: `PoiImportAdminService` — status + runs (read side)

**Files:**

- Create: `apps/backend/src/modules/poi/poi-import-admin.service.ts`
- Modify: `apps/backend/src/modules/poi/poi.module.ts` (provide + export; inject `@InjectQueue(QUEUE_NAMES.POI_IMPORT)`)
- Test: `apps/backend/src/modules/poi/poi-import-admin.service.spec.ts`

**Interfaces:**

- Consumes: `POI_IMPORT_SOURCES` (importers), POI datasource, the `poi.import` `Queue`, `PoiImportRun` repo.
- Produces:
  - `RegionImportStatus = { source; code; configured; imported_at: string | null; poi_count: number; extract: { present: boolean; size_bytes: number; modified_at: string } | null; last_run: RunSummary | null; live_state: 'idle' | 'queued' | 'running' }`.
  - `RunSummary = { id; source; region_code; status; trigger; fetched; upserted; tombstoned; skip_reason; error; started_at; finished_at }`.
  - `listRegionStatus(): Promise<RegionImportStatus[]>`.
  - `listRuns(filter: { source?: string; code?: string; limit: number }): Promise<RunSummary[]>`.
  - `manualJobId(source, code): string` (deterministic; shared with Task 5 trigger).

- [ ] **Step 1: Write the failing test**

```ts
import { PoiImportAdminService } from "./poi-import-admin.service.js";

describe("PoiImportAdminService.listRegionStatus", () => {
  const importers = [
    {
      source: "osm",
      regions: [{ code: "CZ", bbox: {} }],
      getExtractPath: (code: string) => `/extracts/${code}.osm`,
    },
  ];

  it("assembles status per (source, region) with counts, coverage, extract, live state", async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("poi_import_regions"))
          return [{ imported_at: "2026-07-10T00:00:00Z" }];
        if (sql.includes("count(")) return [{ n: "42" }];
        return [];
      }),
    };
    const runsRepo = { findOne: jest.fn(async () => null) };
    const queue = { getJob: jest.fn(async () => null) };
    const svc = new PoiImportAdminService(
      importers as never,
      dataSource as never,
      runsRepo as never,
      queue as never,
      { stat: async () => ({ size: 10, mtimeMs: 1720_000_000_000 }) } as never,
    );

    const rows = await svc.listRegionStatus();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "osm",
      code: "CZ",
      poi_count: 42,
      imported_at: "2026-07-10T00:00:00Z",
      live_state: "idle",
    });
    expect(rows[0].extract).toMatchObject({ present: true, size_bytes: 10 });
  });

  it("reports live_state running when the queue has an active job", async () => {
    const dataSource = { query: jest.fn(async () => [{ n: "0" }]) };
    const runsRepo = { findOne: jest.fn(async () => null) };
    const job = { getState: jest.fn(async () => "active") };
    const queue = { getJob: jest.fn(async () => job) };
    const svc = new PoiImportAdminService(
      importers as never,
      dataSource as never,
      runsRepo as never,
      queue as never,
      {
        stat: async () => {
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        },
      } as never,
    );
    const rows = await svc.listRegionStatus();
    expect(rows[0].live_state).toBe("running");
    expect(rows[0].extract).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-admin.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the read side** (`poi-import-admin.service.ts`)

```ts
import { Inject, Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource, Repository } from "typeorm";
import { stat as fsStat } from "node:fs/promises";
import { QUEUE_NAMES } from "../jobs/jobs.constants.js";
import {
  POI_IMPORT_SOURCES,
  type PoiImportService,
} from "./poi-import.service.js";
import { PoiImportRun } from "../../entities/poi-import-run.entity.js";

export interface RunSummary {
  id: string;
  source: string;
  region_code: string;
  status: string;
  trigger: string;
  fetched: number | null;
  upserted: number | null;
  tombstoned: number | null;
  skip_reason: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface RegionImportStatus {
  source: string;
  code: string;
  configured: boolean;
  imported_at: string | null;
  poi_count: number;
  extract: { present: boolean; size_bytes: number; modified_at: string } | null;
  last_run: RunSummary | null;
  live_state: "idle" | "queued" | "running";
}

@Injectable()
export class PoiImportAdminService {
  constructor(
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: readonly PoiImportService[],
    @InjectDataSource("poi") private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, "poi")
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT) private readonly queue: Queue,
    // Injected for tests; defaults to node:fs/promises stat.
    private readonly fs: { stat: typeof fsStat } = { stat: fsStat },
  ) {}

  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, "_");
  }

  async listRegionStatus(): Promise<RegionImportStatus[]> {
    const out: RegionImportStatus[] = [];
    for (const importer of this.importers) {
      for (const region of importer.regions) {
        out.push(await this.statusFor(importer, region.code));
      }
    }
    return out;
  }

  private async statusFor(
    importer: PoiImportService,
    code: string,
  ): Promise<RegionImportStatus> {
    const source = importer.source;
    const [covRows, countRows] = await Promise.all([
      this.poi.query(
        `SELECT imported_at FROM poi_import_regions WHERE code = $1`,
        [code],
      ),
      this.poi.query(
        `SELECT count(*)::int AS n FROM pois
           WHERE source = $1 AND import_region = $2 AND deactivated_at IS NULL`,
        [source, code],
      ),
    ]);
    const imported_at = covRows?.[0]?.imported_at
      ? new Date(covRows[0].imported_at).toISOString()
      : null;
    const poi_count = Number(countRows?.[0]?.n ?? 0);

    let extract: RegionImportStatus["extract"] = null;
    try {
      const s = await this.fs.stat(importer.getExtractPath(code));
      extract = {
        present: true,
        size_bytes: s.size,
        modified_at: new Date(s.mtimeMs).toISOString(),
      };
    } catch {
      extract = null; // ENOENT → no extract uploaded
    }

    const runRow = await this.runs.findOne({
      where: { source, region_code: code },
      order: { started_at: "DESC", id: "DESC" },
    });

    const job = await this.queue.getJob(this.manualJobId(source, code));
    let live_state: RegionImportStatus["live_state"] = "idle";
    if (job) {
      const state = await job.getState();
      live_state =
        state === "active"
          ? "running"
          : state === "waiting" ||
              state === "delayed" ||
              state === "prioritized"
            ? "queued"
            : "idle";
    }

    return {
      source,
      code,
      configured: true,
      imported_at,
      poi_count,
      extract,
      last_run: runRow ? this.toSummary(runRow) : null,
      live_state,
    };
  }

  async listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const qb = this.runs
      .createQueryBuilder("r")
      .orderBy("r.started_at", "DESC")
      .addOrderBy("r.id", "DESC")
      .limit(filter.limit);
    if (filter.source)
      qb.andWhere("r.source = :source", { source: filter.source });
    if (filter.code)
      qb.andWhere("r.region_code = :code", { code: filter.code });
    return (await qb.getMany()).map((r) => this.toSummary(r));
  }

  private toSummary(r: PoiImportRun): RunSummary {
    return {
      id: r.id,
      source: r.source,
      region_code: r.region_code,
      status: r.status,
      trigger: r.trigger,
      fetched: r.fetched,
      upserted: r.upserted,
      tombstoned: r.tombstoned,
      skip_reason: r.skip_reason,
      error: r.error,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    };
  }
}
```

Note: this task requires `PoiImportService` to expose a public `getExtractPath(code: string): string` (it currently resolves the path privately). Add a thin public method delegating to the existing private resolver.

- [ ] **Step 4: Provide + export in `poi.module.ts`**; ensure the POI module `imports` includes the BullMQ queue registration for `QUEUE_NAMES.POI_IMPORT` (`BullModule.registerQueue({ name: QUEUE_NAMES.POI_IMPORT })`) so `@InjectQueue` resolves.

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/poi/poi-import-admin.service.ts apps/backend/src/modules/poi/poi-import-admin.service.spec.ts apps/backend/src/modules/poi/poi.module.ts apps/backend/src/modules/poi/poi-import.service.ts
git commit -m "feat(backend): poi import admin status + runs read service (#847)"
```

---

### Task 5: `PoiImportAdminService` — upload + trigger (write side)

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts`
- Test: `apps/backend/src/modules/poi/poi-import-admin.service.spec.ts` (extend)

**Interfaces:**

- Consumes: importer `getExtractPath`, the `poi.import` `Queue`, `manualJobId` (Task 4).
- Produces:
  - `storeExtract(source, code, file: { stream: Readable; size: number; originalName: string }): Promise<{ present: true; size_bytes: number; modified_at: string }>` — validates + atomic-writes; throws `BadRequestException` on unknown source/code, wrong extension, or oversize.
  - `triggerImport(source, code): Promise<{ job_id: string }>` — enqueues; throws `ConflictException` (409) if a job is already active/queued.
  - `MAX_UPLOAD_BYTES` from `TARMOTO_POI_UPLOAD_MAX_BYTES` (default 200 MB).

- [ ] **Step 1: Write failing tests** (extend the spec)

```ts
describe("PoiImportAdminService.triggerImport", () => {
  const importers = [
    {
      source: "osm",
      regions: [{ code: "CZ", bbox: {} }],
      getExtractPath: (c: string) => `/e/${c}.osm`,
    },
  ];
  it("enqueues a manual region job and returns its id", async () => {
    const add = jest.fn(async () => ({ id: "x" }));
    const queue = { getJob: jest.fn(async () => null), add };
    const svc = new PoiImportAdminService(
      importers as never,
      {} as never,
      {} as never,
      queue as never,
    );
    const res = await svc.triggerImport("osm", "CZ");
    expect(res.job_id).toBe("import-region_manual_osm_CZ");
    expect(add).toHaveBeenCalledWith(
      "import-region",
      { code: "CZ", source: "osm", trigger: "manual" },
      expect.objectContaining({ jobId: "import-region_manual_osm_CZ" }),
    );
  });
  it("rejects with 409 when a job is already in flight", async () => {
    const job = { getState: jest.fn(async () => "active") };
    const queue = { getJob: jest.fn(async () => job), add: jest.fn() };
    const svc = new PoiImportAdminService(
      importers as never,
      {} as never,
      {} as never,
      queue as never,
    );
    await expect(svc.triggerImport("osm", "CZ")).rejects.toMatchObject({
      status: 409,
    });
  });
  it("rejects an unknown (source, code)", async () => {
    const queue = { getJob: jest.fn(), add: jest.fn() };
    const svc = new PoiImportAdminService(
      importers as never,
      {} as never,
      {} as never,
      queue as never,
    );
    await expect(svc.triggerImport("osm", "ZZ")).rejects.toMatchObject({
      status: 400,
    });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-admin.service.spec.ts -t triggerImport`
Expected: FAIL — `triggerImport` undefined.

- [ ] **Step 3: Implement upload + trigger** (append to the service)

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { JOB_NAMES } from '../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../jobs/jobs.config.js';

private readonly MAX_UPLOAD_BYTES =
  Number(process.env.TARMOTO_POI_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;

private importerFor(source: string, code: string): PoiImportService {
  const importer = this.importers.find((i) => i.source === source);
  if (!importer) throw new BadRequestException(`unknown source: ${source}`);
  if (!importer.regions.some((r) => r.code === code)) {
    throw new BadRequestException(`unknown region ${code} for source ${source}`);
  }
  return importer;
}

async storeExtract(source: string, code: string, file: { stream: Readable; size: number; originalName: string }) {
  if (file.size > this.MAX_UPLOAD_BYTES) {
    throw new BadRequestException(`extract exceeds ${this.MAX_UPLOAD_BYTES} bytes`);
  }
  const importer = this.importerFor(source, code);
  const target = importer.getExtractPath(code);
  const expectedExt = source === 'fsq' ? '.fsq.jsonl' : '.osm';
  if (!file.originalName.toLowerCase().endsWith(expectedExt) &&
      !target.endsWith(expectedExt)) {
    throw new BadRequestException(`expected a ${expectedExt} file for ${source}`);
  }
  const tmp = `${target}.part`;
  try {
    await pipeline(file.stream, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  const s = await this.fs.stat(target);
  return { present: true as const, size_bytes: s.size, modified_at: new Date(s.mtimeMs).toISOString() };
}

async triggerImport(source: string, code: string): Promise<{ job_id: string }> {
  this.importerFor(source, code);
  const jobId = this.manualJobId(source, code);
  const existing = await this.queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      throw new ConflictException(`import for ${source}/${code} already in flight`);
    }
  }
  await this.queue.add(
    JOB_NAMES.POI_IMPORT_REGION,
    { code, source, trigger: 'manual' },
    { ...DEFAULT_JOB_OPTIONS, jobId, attempts: 3 },
  );
  return { job_id: jobId };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/backend && pnpm exec jest src/modules/poi/poi-import-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/poi/poi-import-admin.service.ts apps/backend/src/modules/poi/poi-import-admin.service.spec.ts
git commit -m "feat(backend): poi import admin upload + trigger (#847)"
```

---

### Task 6: `AdminPoiController` + DTOs + OpenAPI

**Files:**

- Create: `apps/backend/src/modules/admin/dto/poi-import-admin.dto.ts`
- Create: `apps/backend/src/modules/admin/admin-poi.controller.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`
- Test: `apps/backend/src/modules/admin/admin-poi.controller.spec.ts`

**Interfaces:**

- Consumes: `PoiImportAdminService` (Tasks 4–5). Import `PoiModule` into `AdminModule` if not already, so the service resolves.
- Produces: endpoints `GET /admin/poi/regions`, `POST /admin/poi/regions/:source/:code/extract` (multipart), `POST /admin/poi/regions/:source/:code/import`, `GET /admin/poi/runs`.

- [ ] **Step 1: Write the failing controller test**

```ts
import { AdminPoiController } from "./admin-poi.controller.js";

describe("AdminPoiController", () => {
  const svc = {
    listRegionStatus: jest.fn(async () => [{ source: "osm", code: "CZ" }]),
    listRuns: jest.fn(async () => []),
    triggerImport: jest.fn(async () => ({ job_id: "j" })),
    storeExtract: jest.fn(async () => ({
      present: true,
      size_bytes: 1,
      modified_at: "x",
    })),
  };
  const ctrl = new AdminPoiController(svc as never);

  it("GET regions delegates to the service", async () => {
    expect(await ctrl.regions()).toEqual([{ source: "osm", code: "CZ" }]);
  });
  it("POST import delegates with (source, code)", async () => {
    expect(await ctrl.triggerImport("osm", "CZ")).toEqual({ job_id: "j" });
    expect(svc.triggerImport).toHaveBeenCalledWith("osm", "CZ");
  });
  it("GET runs passes the limit + filters", async () => {
    await ctrl.runs("osm", "CZ", 20);
    expect(svc.listRuns).toHaveBeenCalledWith({
      source: "osm",
      code: "CZ",
      limit: 20,
    });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/backend && pnpm exec jest src/modules/admin/admin-poi.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create DTOs** (`poi-import-admin.dto.ts`) — mirror `admin-metrics.dto.ts` (`@ApiProperty` classes) for `RegionImportStatusDto`, `ExtractStatDto`, `RunDto`, matching the `RegionImportStatus`/`RunSummary` shapes from Task 4.

- [ ] **Step 4: Create the controller** (`admin-poi.controller.ts`)

```ts
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { InternalGuard } from "./internal.guard.js";
import { AdminAuditInterceptor } from "./admin-audit.interceptor.js";
import { PoiImportAdminService } from "../poi/poi-import-admin.service.js";
import {
  RegionImportStatusDto,
  RunDto,
  ExtractStatDto,
} from "./dto/poi-import-admin.dto.js";

@UseGuards(InternalGuard)
@UseInterceptors(AdminAuditInterceptor)
@Controller("admin/poi")
export class AdminPoiController {
  constructor(private readonly svc: PoiImportAdminService) {}

  @Get("regions")
  regions(): Promise<RegionImportStatusDto[]> {
    return this.svc.listRegionStatus();
  }

  @Get("runs")
  runs(
    @Query("source") source?: string,
    @Query("code") code?: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ): Promise<RunDto[]> {
    return this.svc.listRuns({
      source,
      code,
      limit: Math.min(Math.max(limit, 1), 200),
    });
  }

  @Post("regions/:source/:code/import")
  triggerImport(@Param("source") source: string, @Param("code") code: string) {
    return this.svc.triggerImport(source, code);
  }

  @Post("regions/:source/:code/extract")
  @UseInterceptors(FileInterceptor("file"))
  uploadExtract(
    @Param("source") source: string,
    @Param("code") code: string,
    @UploadedFile()
    file: {
      buffer?: Buffer;
      stream?: NodeJS.ReadableStream;
      size: number;
      originalname: string;
    },
  ): Promise<ExtractStatDto> {
    // Use a streaming multer config (see Step 5); pass a Readable + size + name.
    const stream =
      file.stream ?? require("node:stream").Readable.from(file.buffer!);
    return this.svc.storeExtract(source, code, {
      stream,
      size: file.size,
      originalName: file.originalname,
    });
  }
}
```

- [ ] **Step 5: Register in `admin.module.ts`** — add `AdminPoiController` to `controllers`, ensure `PoiModule` is imported, and register a size-capped multer for the upload route (`MulterModule` or a per-route `FileInterceptor` limit reading `TARMOTO_POI_UPLOAD_MAX_BYTES`). Prefer disk/stream storage over memory for large files.

- [ ] **Step 6: Run controller tests, verify pass**

Run: `cd apps/backend && pnpm exec jest src/modules/admin/admin-poi.controller.spec.ts`
Expected: PASS.

- [ ] **Step 7: Regenerate OpenAPI + strict build + commit**

```bash
cd apps/backend && pnpm exec nest build --config nest-cli.openapi.json && pnpm run openapi:export
git add apps/backend/src/modules/admin apps/backend/src/modules/poi/poi.module.ts packages/openapi
git commit -m "feat(backend): /admin/poi import management endpoints (#847)"
```

---

### Task 7: Admin SPA — POI Imports page

**Files:**

- Create: the page + hooks under `apps/admin/src/` (mirror an existing admin page — inspect `apps/admin/src/pages/` and the `$api` setup first).
- Modify: the admin route table/nav to add the page.
- Test: a component test mirroring the repo's admin test setup (or a Playwright check if that's the admin convention).

**Interfaces:**

- Consumes: the `$api` client generated from Task 6's OpenAPI — `GET /admin/poi/regions`, `GET /admin/poi/runs`, the two `POST`s.

- [ ] **Step 1: Inspect the existing admin page pattern**

Run: `ls apps/admin/src/pages && sed -n '1,80p' apps/admin/src/main.tsx` (or the router file) and open one existing page + its `$api` usage. Match that structure exactly.

- [ ] **Step 2: Build the page** — a table of configured regions grouped by `code` with OSM/FSQ cells (coverage badge, `poi_count`, extract chip w/ `modified_at`, live-state chip, last-run summary), an Upload control (multipart POST) and an Import button (disabled while `queued`/`running` or no extract) per cell; a Runs panel below. Use `$api` react-query with a `refetchInterval` (e.g. 4000 ms) on `regions` + `runs`. Upload posts multipart to `/admin/poi/regions/:source/:code/extract`; invalidate the `regions` query on success.

- [ ] **Step 3: Wire the route/nav** to the new page following the existing admin router pattern.

- [ ] **Step 4: Typecheck + test**

Run: `pnpm --filter <admin-package> exec tsc --noEmit` (companion/admin CI typechecks; confirm the admin package name) and the admin test command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): POI Imports management page (#847)"
```

---

## Self-Review

**Spec coverage:** §2 scope → Tasks 4–7 (status/upload/trigger/UI, both sources); §3 components → Tasks 1–7; §4 `poi_import_runs` → Task 1; §5 endpoints → Task 6; §6 upload→import + `trigger?` → Tasks 2,3,5; §7 advisory lock + 409 + size cap + worker-down → Tasks 3,5,4; §8 UI → Task 7; §9 testing → each task's tests. Covered.

**Placeholder scan:** the SPA task (7) points to "mirror an existing admin page" rather than inline code — deliberate, because the admin SPA's exact page/router/`$api` conventions must be read at implementation time (Step 1 does that); all backend logic-bearing steps carry real code.

**Type consistency:** `RegionImportStatus`/`RunSummary` (Task 4) ↔ DTOs (Task 6) ↔ SPA (Task 7); `PoiImportResult` fields (`fetched/upserted/tombstoned/skipped`) used consistently in Tasks 2–3; `manualJobId` defined in Task 4 and reused in Task 5; `trigger?` added in Task 2 and read in Task 3, set in Task 5.

**Known implementation dependencies to verify during execution (surface, don't silently fix):**

- `PoiImportService` must expose a public `getExtractPath(code)` (Task 4 adds it).
- `PoiModule` must register the `poi.import` BullMQ queue for `@InjectQueue` (Task 4 Step 4).
- Confirm `AdminModule` can import `PoiModule` without a circular dependency; if one appears, expose `PoiImportAdminService` via a small forwarded provider.
