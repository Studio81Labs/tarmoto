# apps/ingest Internal API + Backend Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the backend↔ingest BullMQ `poi.import` seam with a token-guarded HTTP internal API on `apps/ingest`, turning the backend POI-import admin into a thin proxy so `apps/ingest` becomes the sole owner of the import config, queue, and admin-status data.

**Architecture:** `apps/ingest` gains a `/internal/poi/*` controller (behind an `x-internal-token` guard, not internet-exposed) that owns the coverage/runs reads, the enablement view, and the manual-import enqueue. The backend `PoiImportAdminService` stops touching the POI DB and the queue and instead `fetch`es that API server-to-server; it keeps only the upload path (`storeExtract` + the per-`(source,code)` upload lock) which still writes to the shared `/data/poi-extracts` volume. The backend drops its `poi.import` queue registration entirely.

**Tech Stack:** NestJS 11 (both apps), TypeORM + PostGIS (`poi` connection), BullMQ (`poi.import` queue, ioredis), native `fetch` (server-to-server), `@tarmoto/ingest` (Nest-free shared contract package). NodeNext ESM. apps → jest; packages → vitest.

## Global Constraints

- Three apps/pkgs touched: **`@tarmoto/ingest`** (gains the shared wire interfaces), **`apps/ingest`** (gains the internal API), **`apps/backend`** (admin → proxy).
- **No public/admin OpenAPI contract change** — the backend's `/admin/poi/*` response DTO CLASSES stay in the backend and keep their shapes; only their `implements` interfaces move to `@tarmoto/ingest`. `pnpm openapi:gen` byte-identical (check `packages/openapi-client/src/generated/schema.d.ts`; `packages/openapi/openapi.yaml` is gitignored).
- **Internal API is server-to-server, token-guarded, not internet-exposed.** Reuse the EXISTING env var `TARMOTO_INTERNAL_API_TOKEN` (same secret the trusted proxy already injects); the guard mirrors the backend's `assertInternalToken` (header `x-internal-token`, length-guarded `timingSafeEqual`, fail-closed in production).
- **Uploads stay admin→backend→shared volume** (Option A) — the upload controller + `PoiUploadLockInterceptor` + `storeExtract` STAY on the backend, unchanged in behavior (except losing the one queue-dependent guard, which no longer has a queue — see Task 2).
- NodeNext ESM (`.js` on relative imports); apps use jest, packages use vitest; expect prettier reformat on files entering `packages/*`.
- Conventional commits; scopes `cross`/`ingest`/`backend`; lowercase subject; `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Every non-docs task's final gate is:** backend suite green (`pnpm backend:test`) AND apps/ingest suite green (`pnpm --filter @tarmoto/ingest-service test`) AND `@tarmoto/ingest` green (`pnpm --filter @tarmoto/ingest test`) AND `pnpm openapi:gen` leaves `git status --porcelain packages/openapi-client` empty.

---

### Task 1: `apps/ingest` internal API (additive — backend stays green)

Move the admin wire interfaces into `@tarmoto/ingest`, then build the guarded `/internal/poi/*` controller in `apps/ingest`. The backend keeps its existing `listRegionStatus`/`listRuns`/`triggerImport` **bodies** through this whole task (they are reworked into proxies in Task 2), so the backend suite stays green. The only backend edits here are repointing two `import` statements.

**Files:**

- Create: `packages/ingest/src/poi/admin-status.ts`
- Modify: `packages/ingest/src/poi/index.ts` (barrel export)
- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts` (remove local interface defs; import from `@tarmoto/ingest`)
- Modify: `apps/backend/src/modules/admin/dto/poi-import-admin.dto.ts` (repoint `implements` import to `@tarmoto/ingest`)
- Create: `apps/ingest/src/internal/internal.guard.ts`
- Create: `apps/ingest/src/internal/dto/trigger-import.dto.ts`
- Create: `apps/ingest/src/internal/poi-internal.service.ts`
- Create: `apps/ingest/src/internal/poi-internal.controller.ts`
- Create: `apps/ingest/src/internal/poi-internal.module.ts`
- Modify: `apps/ingest/src/app.module.ts` (wire `PoiInternalModule`)
- Modify: `apps/ingest/src/main.ts` (add global `ValidationPipe`)
- Modify: `apps/ingest/package.json` (add `class-validator` + `class-transformer`)
- Modify: `apps/ingest/.env.example` (document `TARMOTO_INTERNAL_API_TOKEN`)
- Test: `apps/ingest/src/internal/internal.guard.spec.ts`
- Test: `apps/ingest/src/internal/poi-internal.service.spec.ts`
- Test: `apps/ingest/test/poi-internal.e2e-spec.ts`

**Interfaces:**

- Produces (from `@tarmoto/ingest`): `interface RegionImportStatus { source: string; code: string; configured: boolean; imported_at: string | null; poi_count: number; extract: { present: boolean; size_bytes: number; modified_at: string } | null; last_run: RunSummary | null; live_state: 'idle' | 'queued' | 'running' }`; `interface RunSummary { id, source, region_code, status, trigger: string; fetched, upserted, tombstoned: number | null; skip_reason, warning, error: string | null; started_at: string; finished_at: string | null }`; `interface TriggerImportResponse { job_id: string }`.
- Produces (HTTP routes, `apps/ingest`, guarded): `GET /internal/poi/regions` → `RegionImportStatus[]`; `GET /internal/poi/runs?source&code&limit` → `RunSummary[]`; `POST /internal/poi/import` body `{ source: string; code: string; trigger?: 'manual' | 'cron' }` → `TriggerImportResponse` (400 unknown/disabled pair, 409 in-flight, 503 store down).
- Produces (`apps/ingest`): `class IngestInternalGuard implements CanActivate` (reads `TARMOTO_INTERNAL_API_TOKEN`); `class PoiInternalService` with `listRegionStatus()`, `listRuns(filter)`, `triggerImport(source, code, trigger?)`; `class PoiInternalModule`.
- Consumes: `@tarmoto/ingest` `DEFAULT_REGIONS`, `POI_IMPORT_QUEUE`, `POI_IMPORT_JOB`, `PoiImportRegionJobData`; `apps/ingest` `POI_IMPORT_SOURCES` (registry of `PoiImportService`, each exposing `.source`, `.enabled`, `.regions`, `.extractDirConfigured`, `.getExtractPath(code)`), `isPoiConnectionError` (`../poi/poi-repo.js`), `PoiImportRun` (`@tarmoto/poi-db`).

---

- [ ] **Step 1: Move the wire interfaces into `@tarmoto/ingest`**

Create `packages/ingest/src/poi/admin-status.ts` (double quotes — packages/\* are prettier-formatted). These are transcribed verbatim from the backend `poi-import-admin.service.ts` (`RunSummary` lines 88–105, `RegionImportStatus` lines 112–134) — **except** the `configured` docstring, which is updated because Phase 3 makes it a real per-region flag rather than "always true today":

```typescript
/**
 * Wire shapes for the POI-import admin surface (#847), shared between
 * apps/ingest's internal API (which computes them) and the backend admin
 * proxy + its Swagger DTOs (which re-serve them). Pure interfaces, no deps —
 * safe for this Nest-free package. Moved here from the backend
 * `poi-import-admin.service.ts` in Phase 3 so both apps name one type.
 */

/** One `poi_import_runs` row, serialized for the admin API (#847). */
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
  /** Set when a `success` run withheld part of its normal work (e.g. the
   *  tombstone wipe-guard's partial-accept path) — null on every clean
   *  success, both skip reasons, and any `running`/`failed` row. */
  warning: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Per-`(source, region)` admin status row (#847) — everything the POI
 * Imports admin page needs to render one row of the coverage table without a
 * second round-trip.
 */
export interface RegionImportStatus {
  source: string;
  code: string;
  /** True when this source is enabled AND `code` is in that source's
   *  configured `regions` list (Phase 3 enablement view). A disabled or
   *  unconfigured pair is `false` — the admin hides it and the manual trigger
   *  400s it. */
  configured: boolean;
  /** Coverage stamp — OSM-only. `poi_import_regions` has no `source` column
   *  and is only stamped by the OSM import path, so a non-OSM row always
   *  reports `null` here rather than reusing OSM's stamp for the same code. */
  imported_at: string | null;
  poi_count: number;
  extract: {
    present: boolean;
    size_bytes: number;
    modified_at: string;
  } | null;
  last_run: RunSummary | null;
  live_state: "idle" | "queued" | "running";
}

/**
 * Response body of the manual import trigger (`POST /internal/poi/import` and
 * the backend `POST /admin/poi/regions/:source/:code/import`) — the enqueued
 * BullMQ job id.
 */
export interface TriggerImportResponse {
  job_id: string;
}
```

- [ ] **Step 2: Export from the barrel**

Add to `packages/ingest/src/poi/index.ts`:

```typescript
export * from "./admin-status.js";
```

- [ ] **Step 3: Repoint the backend service + DTO imports**

In `apps/backend/src/modules/poi/poi-import-admin.service.ts`, **delete** the two local interface blocks (`export interface RunSummary { … }` and `export interface RegionImportStatus { … }`, lines 87–134) and add `RegionImportStatus, RunSummary` to the existing `@tarmoto/ingest` import.

Before:

```typescript
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type PoiImportRegion,
  type PoiImportRegionJobData,
  type PoiImportSource,
} from "@tarmoto/ingest";
```

After:

```typescript
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type PoiImportRegion,
  type PoiImportRegionJobData,
  type PoiImportSource,
  type RegionImportStatus,
  type RunSummary,
} from "@tarmoto/ingest";
```

In `apps/backend/src/modules/admin/dto/poi-import-admin.dto.ts`, repoint the interface import and add the trigger-response interface (compile-time only — no `@ApiProperty` change, so OpenAPI is unaffected).

Before:

```typescript
import type {
  RegionImportStatus,
  RunSummary,
} from "../../poi/poi-import-admin.service.js";
```

After:

```typescript
import type {
  RegionImportStatus,
  RunSummary,
  TriggerImportResponse,
} from "@tarmoto/ingest";
```

And change the trigger DTO to implement the shared shape (class body unchanged):

```typescript
export class TriggerImportResponseDto implements TriggerImportResponse {
  @ApiProperty() job_id!: string;
}
```

- [ ] **Step 4: Verify the interface move is green + OpenAPI byte-identical**

Run: `pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/ingest test`
Expected: PASS (pure interfaces).
Run: `pnpm backend:build && pnpm backend:test`
Expected: PASS (backend still uses its own method bodies; only the interface source moved).
Run: `pnpm openapi:gen && git status --porcelain packages/openapi-client`
Expected: empty output (DTO classes + `@ApiProperty` unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/poi/admin-status.ts packages/ingest/src/poi/index.ts apps/backend/src/modules/poi/poi-import-admin.service.ts apps/backend/src/modules/admin/dto/poi-import-admin.dto.ts
git commit -m "$(cat <<'EOF'
refactor(cross): hoist POI admin-status wire interfaces into @tarmoto/ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Write the failing guard test**

Create `apps/ingest/src/internal/internal.guard.spec.ts`:

```typescript
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { IngestInternalGuard } from "./internal.guard.js";

function ctx(headers: Record<string, string | string[]>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function cfg(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe("IngestInternalGuard", () => {
  it("allows any request when no token is configured outside production", () => {
    const guard = new IngestInternalGuard(cfg({ NODE_ENV: "test" }));
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it("fails closed in production when no token is configured", () => {
    const guard = new IngestInternalGuard(cfg({ NODE_ENV: "production" }));
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
  });

  it("accepts a matching x-internal-token", () => {
    const guard = new IngestInternalGuard(
      cfg({ TARMOTO_INTERNAL_API_TOKEN: "s3cret" }),
    );
    expect(guard.canActivate(ctx({ "x-internal-token": "s3cret" }))).toBe(true);
  });

  it("rejects a missing or mismatched token", () => {
    const guard = new IngestInternalGuard(
      cfg({ TARMOTO_INTERNAL_API_TOKEN: "s3cret" }),
    );
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(ctx({ "x-internal-token": "wrong" })),
    ).toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 7: Run the guard test to verify it fails**

Run: `pnpm --filter @tarmoto/ingest-service test internal.guard`
Expected: FAIL with "Cannot find module './internal.guard.js'".

- [ ] **Step 8: Implement `IngestInternalGuard`**

Create `apps/ingest/src/internal/internal.guard.ts` — the token half of the backend's `assertInternalToken` (recon-A §4, lines 1379–1407), minus JWT/roles/audit:

```typescript
import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

// The header the backend admin proxy injects to prove a request came from
// inside the trusted infra (server-to-server). apps/ingest's /internal/* is
// never internet-exposed — only the backend calls it.
const INTERNAL_TOKEN_HEADER = "x-internal-token";

// Length-guarded constant-time compare — timingSafeEqual throws on a length
// mismatch, and the provided token is attacker-controlled.
function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Token-only mirror of the backend's InternalGuard (`assertInternalToken`
 * half): gates apps/ingest's `/internal/poi/*` controller with the shared
 * `x-internal-token`. No JWT/role check — that stays the admin edge's job;
 * this is a pure server-to-server gate. Fails closed in production when the
 * token is unset; open in dev/test so the local `pnpm dev` reaches the API
 * without a secret. /healthz is NOT guarded (this is controller-scoped).
 */
@Injectable()
export class IngestInternalGuard implements CanActivate {
  private readonly logger = new Logger(IngestInternalGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = this.config
      .get<string>("TARMOTO_INTERNAL_API_TOKEN")
      ?.trim();

    if (!expected) {
      if (this.config.get<string>("NODE_ENV") === "production") {
        this.logger.warn("internal token not configured — denying");
        throw new UnauthorizedException("Ingest internal API not configured");
      }
      return true;
    }

    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!provided || !tokensEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid internal token");
    }
    return true;
  }
}
```

- [ ] **Step 9: Run the guard test to verify it passes**

Run: `pnpm --filter @tarmoto/ingest-service test internal.guard`
Expected: PASS (4 tests).

- [ ] **Step 10: Write the failing service test**

Create `apps/ingest/src/internal/poi-internal.service.spec.ts`. These mirror the backend admin spec's construction style (`new … (mocks)`) but inject the `POI_IMPORT_SOURCES` registry as the 4th arg. `DEFAULT_REGIONS` includes `CZ` and `SK`.

```typescript
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PoiInternalService } from "./poi-internal.service.js";

// A fake PoiImportService registry entry — only the getters the internal
// service reads.
function fakeImporter(over: {
  source: string;
  enabled: boolean;
  regions: string[];
  extractDirConfigured?: boolean;
}) {
  return {
    source: over.source,
    enabled: over.enabled,
    regions: over.regions.map((code) => ({
      code,
      bbox: { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 },
    })),
    extractDirConfigured: over.extractDirConfigured ?? false,
    getExtractPath: (code: string) => `/extracts/${code.toLowerCase()}.osm`,
  };
}

describe("PoiInternalService", () => {
  describe("listRegionStatus", () => {
    it("emits DEFAULT_REGIONS rows only for ENABLED sources, with configured reflecting the regions list", async () => {
      const dataSource = {
        isInitialized: true,
        query: jest.fn((sql: string) => {
          if (sql.includes("poi_import_regions"))
            return [{ code: "CZ", imported_at: "2026-07-10T00:00:00Z" }];
          if (sql.toLowerCase().includes("group by"))
            return [{ source: "osm", import_region: "CZ", n: "42" }];
          return [];
        }),
      };
      const runsRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      const importers = [
        fakeImporter({ source: "osm", enabled: true, regions: ["CZ", "SK"] }),
        fakeImporter({ source: "fsq", enabled: false, regions: ["CZ"] }),
      ];

      const svc = new PoiInternalService(
        dataSource as never,
        runsRepo as never,
        queue as never,
        importers as never,
      );

      const rows = await svc.listRegionStatus();

      // fsq is disabled → zero fsq rows; osm enabled → one row per
      // DEFAULT_REGIONS code.
      expect(rows.every((r) => r.source === "osm")).toBe(true);
      const osmCz = rows.find((r) => r.code === "CZ");
      expect(osmCz).toMatchObject({
        source: "osm",
        code: "CZ",
        configured: true,
        poi_count: 42,
        imported_at: "2026-07-10T00:00:00.000Z",
        live_state: "idle",
      });
      // A code NOT in the source's regions list is configured:false.
      const osmDe = rows.find((r) => r.code === "DE");
      expect(osmDe?.configured).toBe(false);
    });
  });

  describe("triggerImport", () => {
    const enabledOsm = () => [
      fakeImporter({ source: "osm", enabled: true, regions: ["CZ", "SK"] }),
    ];

    it("400s an unknown source", async () => {
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        {} as never,
        enabledOsm() as never,
      );
      await expect(svc.triggerImport("bogus", "CZ")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("400s a disabled/unconfigured pair (enablement view)", async () => {
      const importers = [
        fakeImporter({ source: "fsq", enabled: false, regions: ["CZ"] }),
      ];
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        { getJobs: jest.fn() } as never,
        importers as never,
      );
      await expect(svc.triggerImport("fsq", "CZ")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("enqueues a manual region job and returns its id", async () => {
      const add = jest.fn();
      const queue = { getJobs: jest.fn().mockResolvedValue([]), add };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        enabledOsm() as never,
      );

      const res = await svc.triggerImport("osm", "CZ");

      expect(res.job_id).toBe("import-region_manual_osm_CZ");
      expect(add).toHaveBeenCalledWith(
        "import-region",
        { code: "CZ", source: "osm", trigger: "manual" },
        expect.objectContaining({
          jobId: "import-region_manual_osm_CZ",
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: true,
        }),
      );
    });

    it("409s when a job for the same (source, code) is already in flight", async () => {
      const queue = {
        getJobs: jest
          .fn()
          .mockResolvedValue([{ data: { code: "CZ", source: "osm" } }]),
        add: jest.fn(),
      };
      const svc = new PoiInternalService(
        {} as never,
        {} as never,
        queue as never,
        enabledOsm() as never,
      );
      await expect(svc.triggerImport("osm", "CZ")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 11: Run the service test to verify it fails**

Run: `pnpm --filter @tarmoto/ingest-service test poi-internal.service`
Expected: FAIL with "Cannot find module './poi-internal.service.js'".

- [ ] **Step 12: Implement `PoiInternalService`**

Create `apps/ingest/src/internal/poi-internal.service.ts`. The `listRegionStatus`/`statusFor`/`withPoiStore`/`listRuns`/`toSummary`/`importInFlight`/`manualJobId` bodies are **relocated verbatim** from the backend `poi-import-admin.service.ts` (recon-A §1), with these three adaptations called out inline: (a) the pair list comes from the enabled `POI_IMPORT_SOURCES` registry × `DEFAULT_REGIONS` (not `SOURCE_STRATEGIES`), with a real per-pair `configured`; (b) the extract stat uses `importer.getExtractPath(code)`/`importer.extractDirConfigured` (not the backend's env-derived `getExtractPath`); (c) `triggerImport` adds the enablement-400 and **drops** the `uploadInProgress` check (that stays on the backend — the backend owns the upload lock).

```typescript
import { stat } from "node:fs/promises";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource, Repository } from "typeorm";
import {
  DEFAULT_REGIONS,
  POI_IMPORT_JOB,
  POI_IMPORT_QUEUE,
  type PoiImportRegionJobData,
  type RegionImportStatus,
  type RunSummary,
  type TriggerImportResponse,
} from "@tarmoto/ingest";
import { PoiImportRun } from "@tarmoto/poi-db";
import {
  POI_IMPORT_SOURCES,
  PoiImportService,
} from "../poi/poi-import.service.js";
import { isPoiConnectionError } from "../poi/poi-repo.js";

/**
 * The internal-API service (Phase 3): owns the whole POI-import admin data
 * plane — the coverage table (`listRegionStatus`), run history (`listRuns`),
 * and the manual enqueue (`triggerImport`). Relocated from the backend
 * `PoiImportAdminService`, but now sourcing enablement from the real
 * `POI_IMPORT_SOURCES` registry instead of the backend's SOURCE_STRATEGIES ×
 * DEFAULT_REGIONS shim. The upload path (and its lock) stays on the backend.
 */
@Injectable()
export class PoiInternalService {
  constructor(
    @InjectDataSource("poi") private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, "poi")
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(POI_IMPORT_QUEUE)
    private readonly queue: Queue<PoiImportRegionJobData>,
    @Inject(POI_IMPORT_SOURCES)
    private readonly importers: PoiImportService[],
  ) {}

  /** Deterministic BullMQ job id for a manual trigger — verbatim from the
   *  backend admin service (`:` stripped, it's BullMQ's key delimiter). */
  manualJobId(source: string, code: string): string {
    return `import-region:manual:${source}:${code}`.replace(/:/g, "_");
  }

  async listRegionStatus(): Promise<RegionImportStatus[]> {
    // ADAPTATION (a): the enablement view. Only ENABLED sources contribute
    // rows (a disabled source drops all 17 — "fewer rows when disabled"), each
    // × DEFAULT_REGIONS, with `configured` = that source's OWN regions list.
    const enabled = this.importers.filter((imp) => imp.enabled);
    const pairs = enabled.flatMap((importer) =>
      DEFAULT_REGIONS.map((region) => ({
        importer,
        code: region.code,
        configured: importer.regions.some((r) => r.code === region.code),
      })),
    );

    // Two bulk queries up front (verbatim from the backend) — one coverage
    // scan, one grouped count — keyed into Maps the per-pair loop reads.
    const [coverageRows, countRows] = await this.withPoiStore(() =>
      Promise.all([
        this.poi.query<{ code: string; imported_at: string | null }[]>(
          `SELECT code, imported_at FROM poi_import_regions`,
        ),
        this.poi.query<
          { source: string; import_region: string; n: number | string }[]
        >(
          `SELECT source, import_region, count(*)::int AS n
             FROM pois
             WHERE deactivated_at IS NULL AND import_region IS NOT NULL
             GROUP BY source, import_region`,
        ),
      ]),
    );
    const coverageByCode = new Map(
      coverageRows.map((r) => [r.code, r.imported_at]),
    );
    const countBySourceRegion = new Map(
      countRows.map((r) => [`${r.source}:${r.import_region}`, Number(r.n)]),
    );

    // One in-flight scan (verbatim) — active/waiting/delayed/prioritized,
    // keyed by payload (source, code).
    const inFlight = await this.queue.getJobs([
      "active",
      "waiting",
      "delayed",
      "prioritized",
    ]);
    const liveBySourceRegion = new Map<string, "running" | "queued">();
    for (const job of inFlight) {
      const data = job?.data as PoiImportRegionJobData | undefined;
      if (!data?.code) continue;
      const key = `${data.source ?? "osm"}:${data.code}`;
      const state = await job.getState();
      if (state === "active") {
        liveBySourceRegion.set(key, "running");
      } else if (
        (state === "waiting" ||
          state === "delayed" ||
          state === "prioritized") &&
        !liveBySourceRegion.has(key)
      ) {
        liveBySourceRegion.set(key, "queued");
      }
    }

    return Promise.all(
      pairs.map((p) =>
        this.statusFor(
          p.importer,
          p.code,
          p.configured,
          coverageByCode,
          countBySourceRegion,
          liveBySourceRegion,
        ),
      ),
    );
  }

  // Verbatim from the backend `withPoiStore` — cold-start / connection-drop →
  // 503; a real query error still propagates.
  private async withPoiStore<T>(op: () => Promise<T>): Promise<T> {
    if (this.poi.isInitialized === false) {
      throw new ServiceUnavailableException("POI store is unavailable");
    }
    try {
      return await op();
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      if (isPoiConnectionError(err)) {
        throw new ServiceUnavailableException("POI store is unavailable");
      }
      throw err;
    }
  }

  private async statusFor(
    importer: PoiImportService,
    code: string,
    configured: boolean,
    coverageByCode: Map<string, string | null>,
    countBySourceRegion: Map<string, number>,
    liveBySourceRegion: Map<string, "running" | "queued">,
  ): Promise<RegionImportStatus> {
    const source = importer.source;
    // OSM-only coverage (verbatim rationale).
    const coverageAt =
      source === "osm" ? (coverageByCode.get(code) ?? null) : null;
    const imported_at = coverageAt ? new Date(coverageAt).toISOString() : null;
    const poi_count = countBySourceRegion.get(`${source}:${code}`) ?? 0;

    // ADAPTATION (b): resolve the extract path from the importer's own
    // strategy. Only stat when this source has a dir AND owns this code —
    // `getExtractPath` throws for a code outside its `regions`. Same
    // ENOENT→null / non-regular→throw / other→throw rules as the backend.
    let extract: RegionImportStatus["extract"] = null;
    if (configured && importer.extractDirConfigured) {
      try {
        const path = importer.getExtractPath(code);
        const s = await stat(path);
        if (!s.isFile()) {
          throw new Error(`POI extract path is not a regular file: ${path}`);
        }
        extract = {
          present: true,
          size_bytes: s.size,
          modified_at: new Date(s.mtimeMs).toISOString(),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    const runRow = await this.withPoiStore(() =>
      this.runs.findOne({
        where: { source, region_code: code },
        order: { started_at: "DESC", id: "DESC" },
      }),
    );

    const live_state: RegionImportStatus["live_state"] =
      liveBySourceRegion.get(`${source}:${code}`) ?? "idle";

    return {
      source,
      code,
      configured,
      imported_at,
      poi_count,
      extract,
      last_run: runRow ? this.toSummary(runRow) : null,
      live_state,
    };
  }

  // Verbatim from the backend `listRuns` (clamp to [1,200], default 50; whole
  // build+run behind withPoiStore).
  async listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit) || 50), 200);
    const rows = await this.withPoiStore(() => {
      const qb = this.runs
        .createQueryBuilder("r")
        .orderBy("r.started_at", "DESC")
        .addOrderBy("r.id", "DESC")
        .limit(limit);
      if (filter.source) {
        qb.andWhere("r.source = :source", { source: filter.source });
      }
      if (filter.code) {
        qb.andWhere("r.region_code = :code", { code: filter.code });
      }
      return qb.getMany();
    });
    return rows.map((r) => this.toSummary(r));
  }

  // Verbatim from the backend `toSummary`.
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
      warning: r.warning,
      error: r.error,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    };
  }

  // Verbatim from the backend `importInFlight` (shared "in flight" definition).
  private async importInFlight(source: string, code: string): Promise<boolean> {
    const inFlight = await this.queue.getJobs([
      "active",
      "waiting",
      "delayed",
      "prioritized",
    ]);
    return inFlight.some(
      (j) => j?.data?.code === code && (j?.data?.source ?? "osm") === source,
    );
  }

  async triggerImport(
    source: string,
    code: string,
    trigger: "manual" | "cron" = "manual",
  ): Promise<TriggerImportResponse> {
    // Unknown source / region → 400 (verbatim intent of the backend
    // `importerFor`).
    const importer = this.importers.find((imp) => imp.source === source);
    if (!importer) {
      throw new BadRequestException(`unknown source: ${source}`);
    }
    if (!DEFAULT_REGIONS.some((r) => r.code === code)) {
      throw new BadRequestException(
        `unknown region ${code} for source ${source}`,
      );
    }
    // ADAPTATION (c): the enablement-400 — stricter than Phase 2's
    // accept-and-skip, and the point of the enablement view. (The worker's own
    // graceful skip stays as defence for a stale queued job.)
    if (!importer.enabled || !importer.regions.some((r) => r.code === code)) {
      throw new BadRequestException(
        `source ${source} is not enabled for region ${code}`,
      );
    }

    // The queue-in-flight 409 lives here now (relocated). The upload-lock 409
    // (`uploadInProgress`) stays on the backend and runs BEFORE this call.
    if (await this.importInFlight(source, code)) {
      throw new ConflictException(
        `import for ${source}/${code} already in flight`,
      );
    }

    const jobId = this.manualJobId(source, code);
    await this.queue.add(
      POI_IMPORT_JOB.REGION,
      { code, source, trigger },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        // Immediate removal on terminal state so a re-import (fresh extract →
        // click Import) is never deduped against a retained terminal job with
        // this stable manual jobId — verbatim rationale from the backend.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return { job_id: jobId };
  }
}
```

- [ ] **Step 13: Run the service test to verify it passes**

Run: `pnpm --filter @tarmoto/ingest-service test poi-internal.service`
Expected: PASS.

- [ ] **Step 14: Add the request DTO + controller + module + pipe + deps**

Add `class-validator` + `class-transformer` (match apps/backend's ranges — `^0.15.1` / `^0.5.1`):

```bash
pnpm --filter @tarmoto/ingest-service add class-validator@^0.15.1 class-transformer@^0.5.1
```

Create `apps/ingest/src/internal/dto/trigger-import.dto.ts`:

```typescript
import { IsIn, IsOptional, IsString } from "class-validator";

/**
 * Body of `POST /internal/poi/import` — the backend admin proxy's manual
 * trigger. `trigger` defaults to `manual` (the proxy is the only caller).
 */
export class TriggerImportRequestDto {
  @IsString()
  source!: string;

  @IsString()
  code!: string;

  @IsOptional()
  @IsIn(["manual", "cron"])
  trigger?: "manual" | "cron";
}
```

Create `apps/ingest/src/internal/poi-internal.controller.ts` (the `runs` conditional-spread mirrors the backend controller's `exactOptionalPropertyTypes` idiom):

```typescript
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  RegionImportStatus,
  RunSummary,
  TriggerImportResponse,
} from "@tarmoto/ingest";
import { IngestInternalGuard } from "./internal.guard.js";
import { PoiInternalService } from "./poi-internal.service.js";
import { TriggerImportRequestDto } from "./dto/trigger-import.dto.js";

/**
 * apps/ingest internal API (Phase 3), server-to-server only — the backend
 * admin proxy is the sole caller. `IngestInternalGuard` gates it with the
 * shared `x-internal-token`; /healthz stays open (controller-scoped guard).
 */
@Controller("internal/poi")
@UseGuards(IngestInternalGuard)
export class PoiInternalController {
  constructor(private readonly svc: PoiInternalService) {}

  @Get("regions")
  regions(): Promise<RegionImportStatus[]> {
    return this.svc.listRegionStatus();
  }

  @Get("runs")
  runs(
    @Query("source") source?: string,
    @Query("code") code?: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ): Promise<RunSummary[]> {
    return this.svc.listRuns({
      ...(source !== undefined ? { source } : {}),
      ...(code !== undefined ? { code } : {}),
      limit,
    });
  }

  @Post("import")
  triggerImport(
    @Body() body: TriggerImportRequestDto,
  ): Promise<TriggerImportResponse> {
    return this.svc.triggerImport(body.source, body.code, body.trigger);
  }
}
```

Create `apps/ingest/src/internal/poi-internal.module.ts`. It registers the `poi.import` queue **token** locally so the service can `@InjectQueue` it — the same producer-only `registerQueue` pattern the backend's `poi.module.ts` uses (the BullMQ root connection is registered globally by `PoiJobsModule` in `AppModule`, so a local `registerQueue` binds to it without importing `PoiJobsModule`):

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { POI_IMPORT_QUEUE } from "@tarmoto/ingest";
import { PoiImportRun } from "@tarmoto/poi-db";
import { PoiModule } from "../poi/poi.module.js";
import { PoiDatabaseModule } from "../poi/poi-database.module.js";
import { IngestInternalGuard } from "./internal.guard.js";
import { PoiInternalController } from "./poi-internal.controller.js";
import { PoiInternalService } from "./poi-internal.service.js";

/**
 * The apps/ingest internal API (Phase 3): a token-guarded /internal/poi/*
 * controller the backend admin proxy calls. Reuses PoiModule's
 * POI_IMPORT_SOURCES registry (enablement + extract paths) + the "poi"
 * connection; registers the poi.import queue token locally so the service can
 * @InjectQueue it for live-state + the manual enqueue.
 */
@Module({
  imports: [
    PoiModule,
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], "poi"),
    BullModule.registerQueue({ name: POI_IMPORT_QUEUE }),
  ],
  controllers: [PoiInternalController],
  providers: [PoiInternalService, IngestInternalGuard],
})
export class PoiInternalModule {}
```

Wire it into `apps/ingest/src/app.module.ts`:

Before:

```typescript
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
```

After:

```typescript
import { PoiModule } from "./poi/poi.module.js";
import { PoiJobsModule } from "./poi/jobs.module.js";
import { PoiInternalModule } from "./internal/poi-internal.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PoiModule,
    PoiJobsModule,
    PoiInternalModule,
  ],
  controllers: [HealthController],
})
```

Add the global `ValidationPipe` in `apps/ingest/src/main.ts` (there is none today):

Before:

```typescript
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
```

```typescript
const app = await NestFactory.create(AppModule);
```

After:

```typescript
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
```

```typescript
const app = await NestFactory.create(AppModule);
// Validate the internal API's POST body (the only routes with a body). A
// no-op on /healthz. `whitelist` strips unknown fields; `transform`
// instantiates the DTO class.
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
```

Document the token in `apps/ingest/.env.example` (append):

```bash

# Shared secret proving an /internal/* request came from the trusted backend
# (sent as the `x-internal-token` header). REQUIRED in production — the guard
# fails closed if NODE_ENV=production and this is unset. Leave BLANK for local
# dev (the gate is off). Must equal the backend's TARMOTO_INTERNAL_API_TOKEN.
TARMOTO_INTERNAL_API_TOKEN=
```

- [ ] **Step 15: Verify unit build + tests pass**

Run: `pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test`
Expected: PASS (guard + service specs; the app compiles with the new module + pipe).

- [ ] **Step 16: Commit the API**

```bash
git add apps/ingest/src/internal apps/ingest/src/app.module.ts apps/ingest/src/main.ts apps/ingest/package.json apps/ingest/.env.example pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(ingest): add token-guarded POI internal API with enablement view

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 17: Write the failing e2e**

Create `apps/ingest/test/poi-internal.e2e-spec.ts`. Reuses the Phase-2 DB-safe fixture pattern; ties the enqueue and coverage endpoints together via `live_state` so the assertion is deterministic against a shared dev DB (no dependence on real POI counts). `CZ` is a real `DEFAULT_REGIONS` code, so it appears in the coverage table for the enabled OSM source.

```typescript
import { Test, type TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POI_IMPORT_QUEUE } from "@tarmoto/ingest";
import { AppModule } from "../src/app.module.js";
import { PoiInternalService } from "../src/internal/poi-internal.service.js";

/**
 * Real-PG + real-Redis proof of the internal API's two live seams: the manual
 * enqueue (`triggerImport`) and the coverage table (`listRegionStatus`).
 * Worker OFF (`TARMOTO_QUEUE_WORKER_ENABLED=false` from test/jest-e2e.setup.ts)
 * so the enqueued job SITS in the queue for the assertions. OSM is enabled via
 * env so CZ is a configured pair. Prerequisite: `pnpm db:up`.
 */
describe("apps/ingest POI internal API (real infra)", () => {
  let app: TestingModule;
  let svc: PoiInternalService;
  let queue: Queue;
  const dir = mkdtempSync(join(tmpdir(), "poi-internal-e2e-"));
  const JOB_ID = "import-region_manual_osm_CZ";

  beforeAll(async () => {
    // Config factories read env at ConfigModule init (during compile()), so
    // set these BEFORE compile. Enable OSM so CZ is enabled+configured.
    process.env.TARMOTO_POI_IMPORT_ENABLED = "true";
    process.env.TARMOTO_POI_IMPORT_DIR = dir;

    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    svc = app.get(PoiInternalService);
    queue = app.get<Queue>(getQueueToken(POI_IMPORT_QUEUE));
    // Clean any leftover from a previous aborted run.
    await queue.remove(JOB_ID).catch(() => undefined);
  }, 30_000);

  afterAll(async () => {
    await queue.remove(JOB_ID).catch(() => undefined);
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("triggerImport enqueues a manual osm/CZ job (worker off)", async () => {
    const res = await svc.triggerImport("osm", "CZ");
    expect(res.job_id).toBe(JOB_ID);
    const job = await queue.getJob(JOB_ID);
    expect(job).toBeTruthy();
  });

  it("listRegionStatus reports osm/CZ configured with live_state reflecting the queued job", async () => {
    const rows = await svc.listRegionStatus();
    const osmCz = rows.find((r) => r.source === "osm" && r.code === "CZ");
    expect(osmCz?.configured).toBe(true);
    expect(typeof osmCz?.poi_count).toBe("number");
    // The job enqueued above is waiting (worker off) → 'queued'.
    expect(osmCz?.live_state).toBe("queued");
  });
});
```

- [ ] **Step 18: Run the e2e to verify it passes**

Run: `pnpm db:up && pnpm --filter @tarmoto/ingest-service test:e2e poi-internal`
Expected: PASS (2 tests).

- [ ] **Step 19: Full Task-1 gate**

Run: `pnpm --filter @tarmoto/ingest test && pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test && pnpm --filter @tarmoto/ingest-service test:e2e`
Expected: PASS.
Run: `pnpm backend:build && pnpm backend:test`
Expected: PASS (backend still runs its own bodies — untouched functionally).
Run: `pnpm openapi:gen && git status --porcelain packages/openapi-client`
Expected: empty output.

- [ ] **Step 20: Commit the e2e**

```bash
git add apps/ingest/test/poi-internal.e2e-spec.ts
git commit -m "$(cat <<'EOF'
test(ingest): e2e the internal API enqueue + coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend admin → thin proxy + drop the `poi.import` queue

Rework `PoiImportAdminService` from a queue-producer + POI-DB-reader into an HTTP client of the internal API, re-source the upload lock onto a dedicated ioredis client, and drop the backend's `poi.import` queue registration across the four files that reference it. `AdminPoiController`, `PoiUploadLockInterceptor`, and the upload path stay.

**Files:**

- Create: `apps/backend/src/modules/poi/poi-upload-lock-redis.ts` (dedicated ioredis provider token)
- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts` (proxy rework; re-source lock; drop the queue-based `importInFlight` guard from `storeExtract`)
- Modify: `apps/backend/src/modules/poi/poi.module.ts` (drop the queue registration + `PoiImportRun` `forFeature`; add the lock-redis provider)
- Modify: `apps/backend/src/modules/jobs/jobs.constants.ts` (drop the POI queue/job/pattern entries)
- Modify: `apps/backend/src/modules/jobs/jobs.constants.spec.ts` (15 → 14)
- Modify: `apps/backend/src/modules/jobs/queue-health.service.ts` (drop the POI injection + `byName` entry)
- Modify: `apps/backend/package.json` (add `ioredis`)
- Modify: `apps/backend/.env.example` (document `TARMOTO_INGEST_INTERNAL_URL`)
- Test: `apps/backend/src/modules/poi/poi-import-admin.service.spec.ts` (proxy tests replace DB/queue tests; lock tests re-source; storeExtract tests drop the queue)

**Interfaces:**

- Consumes (from Task 1): the `@tarmoto/ingest` interfaces `RegionImportStatus`, `RunSummary`, `TriggerImportResponse`; the internal routes `GET /internal/poi/regions`, `GET /internal/poi/runs?source&code&limit`, `POST /internal/poi/import` `{ source, code, trigger }`.
- Consumes (env): `TARMOTO_INGEST_INTERNAL_URL` (backend → ingest base URL), `TARMOTO_INTERNAL_API_TOKEN` (sent as `x-internal-token`), `TARMOTO_REDIS_*` (dedicated lock client).
- Produces: `PoiImportAdminService` keeps the SAME public method signatures (`listRegionStatus(): Promise<RegionImportStatus[]>`, `listRuns(filter): Promise<RunSummary[]>`, `triggerImport(source, code): Promise<TriggerImportResponse>`, `storeExtract(...)`, `acquireUploadLock`/`renewUploadLock`/`releaseUploadLock`/`uploadInProgress`, `POI_UPLOAD_MAX_BYTES`, `UPLOAD_LOCK_RENEW_INTERVAL_MS`) so `AdminPoiController` + `PoiUploadLockInterceptor` are untouched.
- Produces: `export const POI_UPLOAD_LOCK_REDIS: symbol`.

---

- [ ] **Step 1: Add the `ioredis` dep**

The upload-lock methods call ioredis-shaped APIs (`set(k,v,'EX',ttl,'NX')`, `eval(lua, 1, k, tok)`, `exists(k)`) — the backend's other Redis client is node-redis (`createClient`), a different API — so the lock needs a real ioredis client. ioredis is only a transitive (BullMQ) dep today; add it directly:

```bash
pnpm --filter @tarmoto/backend add ioredis@^5
```

- [ ] **Step 2: Create the dedicated lock-redis provider token**

Create `apps/backend/src/modules/poi/poi-upload-lock-redis.ts`:

```typescript
import { Redis } from "ioredis";
import type { ConfigService } from "@nestjs/config";

/**
 * DI token for the dedicated ioredis client backing the POI upload lock
 * (#972). Phase 3 removed the `poi.import` queue from the backend, so the lock
 * can no longer borrow `this.queue.client` — this small client replaces it,
 * built from the same TARMOTO_REDIS_* config the BullMQ connection used.
 */
export const POI_UPLOAD_LOCK_REDIS = Symbol("POI_UPLOAD_LOCK_REDIS");

export function createPoiUploadLockRedis(config: ConfigService): Redis {
  return new Redis({
    host: config.get<string>("TARMOTO_REDIS_HOST") ?? "localhost",
    port: Number.parseInt(
      config.get<string>("TARMOTO_REDIS_PORT") ?? "6379",
      10,
    ),
    username: config.get<string>("TARMOTO_REDIS_USERNAME") || undefined,
    password: config.get<string>("TARMOTO_REDIS_PASSWORD") || undefined,
    // The lock methods issue one-shot commands; no blocking reads.
    maxRetriesPerRequest: null,
    // Don't hammer Redis at boot if it's briefly down — the lock is a
    // best-effort guard with a TTL backstop.
    lazyConnect: false,
  });
}
```

- [ ] **Step 3: Write the failing proxy tests**

Rework `apps/backend/src/modules/poi/poi-import-admin.service.spec.ts`. Replace the `listRegionStatus` / `listRuns` / `triggerImport` / "POI store resilience" describe blocks (which exercised the now-relocated DB + queue logic) with proxy tests that stub global `fetch` and a `ConfigService`; and re-point the `storeExtract` + upload-lock blocks onto the new 2-arg constructor. Add at the top:

```typescript
import { ConfigService } from "@nestjs/config";

function fakeConfig(
  over: Record<string, string | undefined> = {},
): ConfigService {
  const values: Record<string, string | undefined> = {
    TARMOTO_INGEST_INTERNAL_URL: "http://ingest:3005",
    TARMOTO_INTERNAL_API_TOKEN: "tok",
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

// ioredis double for the re-sourced upload lock (was queue.client). Same
// surface the lock methods call: set/del/exists/eval.
function makeLockRedis(over: { exists?: number } = {}) {
  return {
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(over.exists ?? 0),
    eval: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue("OK"),
  };
}
```

New proxy `describe` (replaces the DB/queue-driven `listRegionStatus`/`listRuns`/`triggerImport` blocks):

```typescript
describe("PoiImportAdminService (ingest proxy)", () => {
  const fetchMock = jest.spyOn(global, "fetch");
  afterEach(() => fetchMock.mockReset());

  const svc = () =>
    new PoiImportAdminService(fakeConfig(), makeLockRedis() as never);

  it("listRegionStatus GETs /internal/poi/regions with the internal token and returns the body", async () => {
    const body = [{ source: "osm", code: "CZ", configured: true }];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const rows = await svc().listRegionStatus();

    expect(rows).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ingest:3005/internal/poi/regions");
    expect((init!.headers as Record<string, string>)["x-internal-token"]).toBe(
      "tok",
    );
  });

  it("listRuns forwards source/code/limit as query params", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    await svc().listRuns({ source: "fsq", code: "SK", limit: 5 });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://ingest:3005/internal/poi/runs?source=fsq&code=SK&limit=5",
    );
  });

  it("triggerImport POSTs /internal/poi/import and returns the job id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ job_id: "import-region_manual_osm_CZ" }), {
        status: 201,
      }),
    );

    const res = await svc().triggerImport("osm", "CZ");

    expect(res.job_id).toBe("import-region_manual_osm_CZ");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ingest:3005/internal/poi/import");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      source: "osm",
      code: "CZ",
      trigger: "manual",
    });
  });

  it("propagates the ingest 400 (unconfigured pair) with the same status", async () => {
    fetchMock.mockResolvedValue(
      new Response("source fsq is not enabled for region SK", { status: 400 }),
    );
    await expect(svc().triggerImport("fsq", "SK")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("409s locally (before calling ingest) when an upload is in progress for the pair", async () => {
    const lock = makeLockRedis({ exists: 1 });
    const s = new PoiImportAdminService(fakeConfig(), lock as never);
    await expect(s.triggerImport("osm", "CZ")).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s when TARMOTO_INGEST_INTERNAL_URL is unset", async () => {
    const s = new PoiImportAdminService(
      fakeConfig({ TARMOTO_INGEST_INTERNAL_URL: undefined }),
      makeLockRedis() as never,
    );
    await expect(s.listRegionStatus()).rejects.toMatchObject({ status: 503 });
  });
});
```

Migrate the retained blocks to the 2-arg constructor:

- In the `storeExtract` describe: every `new PoiImportAdminService({} as never, {} as never, queue/redis as never)` becomes `new PoiImportAdminService(fakeConfig(), makeLockRedis() as never)`. **Delete** the two queue-dependent tests — `'rejects with 409 when an import is already in flight for (source, code), and writes nothing'` and `'does not block a storeExtract upload on an in-flight job for a different region or source'` — and drop the `idleQueue()` helper (storeExtract no longer scans the queue). The atomic-write / mount-check / 503 / lock-untouched tests stay (retarget the constructor only).
- In the `upload lock (acquire / renew / release, #972)` describe: change `makeSvc` from `new PoiImportAdminService({} as never, {} as never, { client: Promise.resolve(redis) } as never)` to `new PoiImportAdminService(fakeConfig(), redis as never)`.
- **Delete** the `manualJobId` describe block (the job id is computed in ingest now).

- [ ] **Step 4: Run the reworked spec to verify it fails**

Run: `pnpm --filter @tarmoto/backend test poi-import-admin`
Expected: FAIL (constructor arity mismatch / missing proxy methods).

- [ ] **Step 5: Rework `PoiImportAdminService`**

Edit `apps/backend/src/modules/poi/poi-import-admin.service.ts`:

**5a — imports.** Remove the TypeORM/BullMQ/DataSource imports no longer used; add `ConfigService`, `HttpException`, `Redis`, and the lock-redis token. Before (top of file):

```typescript
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource, Repository } from "typeorm";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { JOB_NAMES, QUEUE_NAMES } from "../jobs/jobs.constants.js";
import { DEFAULT_JOB_OPTIONS } from "../jobs/jobs.config.js";
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type PoiImportRegion,
  type PoiImportRegionJobData,
  type PoiImportSource,
  type RegionImportStatus,
  type RunSummary,
} from "@tarmoto/ingest";
import { PoiImportRun } from "@tarmoto/poi-db";
import { isPoiConnectionError } from "./poi-repo.js";
```

After:

```typescript
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_REGIONS,
  FsqPoiImportSource,
  OsmPoiImportSource,
  type PoiImportRegion,
  type PoiImportSource,
  type RegionImportStatus,
  type RunSummary,
  type TriggerImportResponse,
} from "@tarmoto/ingest";
import { POI_UPLOAD_LOCK_REDIS } from "./poi-upload-lock-redis.js";
```

**5b — delete the relocated interface blocks** (already removed in Task 1 Step 3 — confirm they are gone).

**5c — constructor.** Before:

```typescript
  constructor(
    @InjectDataSource('poi') private readonly poi: DataSource,
    @InjectRepository(PoiImportRun, 'poi')
    private readonly runs: Repository<PoiImportRun>,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT)
    private readonly queue: Queue<PoiImportRegionJobData>,
  ) {}
```

After:

```typescript
  constructor(
    private readonly config: ConfigService,
    @Inject(POI_UPLOAD_LOCK_REDIS) private readonly lockRedis: Redis,
  ) {}
```

**5d — delete the relocated read/enqueue methods:** `manualJobId`, `listRegionStatus`, `withPoiStore`, `statusFor`, `listRuns`, `toSummary`, `importInFlight`. (They now live in `PoiInternalService`.)

**5e — add the proxy methods** (replace the deleted `listRegionStatus`/`listRuns`/`triggerImport`):

```typescript
  private ingestUrl(path: string): string {
    const base = this.config.get<string>('TARMOTO_INGEST_INTERNAL_URL')?.trim();
    if (!base) {
      throw new ServiceUnavailableException(
        'TARMOTO_INGEST_INTERNAL_URL is not configured — the POI import admin API is unavailable',
      );
    }
    return `${base.replace(/\/$/, '')}${path}`;
  }

  private async ingestFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.config.get<string>('TARMOTO_INTERNAL_API_TOKEN')?.trim();
    let res: Response;
    try {
      res = await fetch(this.ingestUrl(path), {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-internal-token': token } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `ingest internal API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      // Propagate the ingest status verbatim so the admin UI sees the same
      // error class: 400 (unknown/disabled pair), 409 (in-flight), 503 (store).
      const detail = await res.text();
      throw new HttpException(detail || res.statusText, res.status);
    }
    return (await res.json()) as T;
  }

  /** Proxy → GET /internal/poi/regions (the full coverage table). */
  listRegionStatus(): Promise<RegionImportStatus[]> {
    return this.ingestFetch<RegionImportStatus[]>('/internal/poi/regions');
  }

  /** Proxy → GET /internal/poi/runs. */
  listRuns(filter: {
    source?: string;
    code?: string;
    limit: number;
  }): Promise<RunSummary[]> {
    const params = new URLSearchParams();
    if (filter.source) params.set('source', filter.source);
    if (filter.code) params.set('code', filter.code);
    params.set('limit', String(filter.limit));
    return this.ingestFetch<RunSummary[]>(
      `/internal/poi/runs?${params.toString()}`,
    );
  }

  /**
   * Proxy → POST /internal/poi/import. The upload↔import coordination stays
   * here (the backend owns the upload lock): block a manual trigger while a
   * replacement extract for this pair is still landing. The queue-in-flight
   * 409 + the enqueue itself live in ingest.
   */
  async triggerImport(
    source: string,
    code: string,
  ): Promise<TriggerImportResponse> {
    if (await this.uploadInProgress(source, code)) {
      throw new ConflictException(
        `an extract upload is in progress for ${source}/${code}; wait for it to finish before importing`,
      );
    }
    return this.ingestFetch<TriggerImportResponse>('/internal/poi/import', {
      method: 'POST',
      body: JSON.stringify({ source, code, trigger: 'manual' }),
    });
  }
```

**5f — re-source the lock methods.** In `uploadInProgress`, `acquireUploadLock`, `renewUploadLock`, `releaseUploadLock`, replace `const redis = await this.queue.client;` with `const redis = this.lockRedis;`. Bodies are otherwise verbatim. Example — `uploadInProgress` before:

```typescript
  private async uploadInProgress(
    source: string,
    code: string,
  ): Promise<boolean> {
    const redis = await this.queue.client;
    return (await redis.exists(this.uploadLockKey(source, code))) > 0;
  }
```

after:

```typescript
  private async uploadInProgress(
    source: string,
    code: string,
  ): Promise<boolean> {
    const redis = this.lockRedis;
    return (await redis.exists(this.uploadLockKey(source, code))) > 0;
  }
```

(Apply the same `const redis = this.lockRedis;` change in `acquireUploadLock`, `renewUploadLock`, `releaseUploadLock`.)

**5g — de-guard `storeExtract`.** It kept its file logic + local helpers (`importerFor`, `SOURCE_STRATEGIES`, `regionFor`, `extractDir`, `extractDirConfigured`, `getExtractPath`, `POI_UPLOAD_MAX_BYTES`) — those STAY (they are what the upload path needs). Remove only the queue-based in-flight guard, which no longer has a queue. Before:

```typescript
// Defense-in-depth against a replacement upload racing a LIVE import for
// this exact (source, code): a worker may be mid-read of the CURRENT
// extract file while an operator's new upload is about to atomically
// replace it out from under it. Same in-flight criteria as
// `triggerImport`'s own 409 guard, shared via `importInFlight` so the two
// checks can never desync (#847 review).
if (await this.importInFlight(source, code)) {
  throw new ConflictException(
    `an import is in progress for ${source}/${code}; wait before replacing the extract`,
  );
}

// Unique per call (not a fixed `<target>.part`) — see the doc comment
```

After:

```typescript
// NOTE (Phase 3): the queue-based in-flight guard that used to sit here is
// gone — the backend no longer holds the `poi.import` queue. Upload safety
// now rests on the per-(source, code) upload lock (which still serializes
// concurrent uploads) plus the import's own atomic read + PG advisory lock
// in apps/ingest; the queue-in-flight 409 moved to the internal API's
// POST /internal/poi/import.

// Unique per call (not a fixed `<target>.part`) — see the doc comment
```

- [ ] **Step 6: Wire the provider + drop the queue registration in `poi.module.ts`**

Rework `apps/backend/src/modules/poi/poi.module.ts`. Before:

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { POI_PROVIDER } from "./poi-provider.interface.js";
import { OverpassPoiProvider } from "./providers/overpass.provider.js";
import { PoiController } from "./poi.controller.js";
import { PoiService } from "./poi.service.js";
import { PoiStoreService } from "./poi-store.service.js";
import { PoiImportAdminService } from "./poi-import-admin.service.js";
import { PoiDatabaseModule } from "./poi-database.module.js";
import { PoiImportRun } from "@tarmoto/poi-db";
import { QUEUE_NAMES } from "../jobs/jobs.constants.js";
```

```typescript
@Module({
  imports: [
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], "poi"),
    // Register the poi.import queue TOKEN so PoiImportAdminService can
    // `@InjectQueue` it (enqueue manual triggers + probe `getJobs` for
    // live_state). ...
    BullModule.registerQueue({ name: QUEUE_NAMES.POI_IMPORT }),
  ],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportAdminService,
  ],
  exports: [PoiService, PoiImportAdminService],
})
export class PoiModule {}
```

After (drop `BullModule` + `QUEUE_NAMES` + `PoiImportRun` `forFeature`; add the lock-redis provider; keep `PoiDatabaseModule` for the read connection):

```typescript
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { POI_PROVIDER } from "./poi-provider.interface.js";
import { OverpassPoiProvider } from "./providers/overpass.provider.js";
import { PoiController } from "./poi.controller.js";
import { PoiService } from "./poi.service.js";
import { PoiStoreService } from "./poi-store.service.js";
import { PoiImportAdminService } from "./poi-import-admin.service.js";
import { PoiDatabaseModule } from "./poi-database.module.js";
import {
  createPoiUploadLockRedis,
  POI_UPLOAD_LOCK_REDIS,
} from "./poi-upload-lock-redis.js";
```

```typescript
/**
 * POI module — Phase 3 reader + admin gateway. The bulk IMPORT ENGINE, the
 * `poi.import` queue, and the coverage/runs/enqueue data plane now live in
 * apps/ingest; `PoiImportAdminService` is a thin HTTP proxy to the ingest
 * internal API, plus the upload path (extract upload → shared volume) which
 * keeps a dedicated Redis client for its per-(source, code) upload lock.
 */
@Module({
  imports: [PoiDatabaseModule],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportAdminService,
    {
      provide: POI_UPLOAD_LOCK_REDIS,
      useFactory: createPoiUploadLockRedis,
      inject: [ConfigService],
    },
  ],
  exports: [PoiService, PoiImportAdminService],
})
export class PoiModule {}
```

- [ ] **Step 7: Drop the POI queue/job/pattern entries from `jobs.constants.ts`**

Edit `apps/backend/src/modules/jobs/jobs.constants.ts`. (1) Remove the `@tarmoto/ingest` import (all three symbols are now unused in the backend):

```typescript
import {
  POI_IMPORT_QUEUE,
  POI_IMPORT_JOB,
  POI_IMPORT_WEEKLY_CRON,
} from "@tarmoto/ingest";
```

Delete that whole import. (2) Remove the `POI_IMPORT` entry from `QUEUE_NAMES` (the doc block + `POI_IMPORT: POI_IMPORT_QUEUE,`). (3) Remove `POI_IMPORT_DISPATCH: POI_IMPORT_JOB.DISPATCH,` and `POI_IMPORT_REGION: POI_IMPORT_JOB.REGION,` (+ their two doc lines) from `JOB_NAMES`. (4) Remove `WEEKLY_SUN_0300: POI_IMPORT_WEEKLY_CRON,` (+ its doc line) from `RECURRING_PATTERNS`. `ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES)` then automatically drops `poi.import`, so `jobs.module.ts`'s bulk `ALL_QUEUE_NAMES.map(registerQueue)` no longer registers it (no edit to `jobs.module.ts`).

- [ ] **Step 8: Drop the POI queue from `queue-health.service.ts`**

Edit `apps/backend/src/modules/jobs/queue-health.service.ts`. Remove the constructor injection:

```typescript
    @InjectQueue(QUEUE_NAMES.POI_IMPORT)
    private readonly poiImport: Queue,
```

and the `byName()` entry:

```typescript
      [QUEUE_NAMES.POI_IMPORT]: this.poiImport,
```

(`snapshot()`/`entryFor` iterate `ALL_QUEUE_NAMES`, which no longer includes `poi.import`, so nothing else changes.)

- [ ] **Step 9: Update the queue-count assertion**

Edit `apps/backend/src/modules/jobs/jobs.constants.spec.ts` line ~35. Before:

```typescript
// #781 added the OSM import queue (15th); #779 the quality conflation (16th).
// #867 removed the unused push-notification stub queue (back to 15).
expect(ALL_QUEUE_NAMES).toHaveLength(15);
```

After:

```typescript
// #781 added the OSM import queue; #779 the quality conflation; #867
// removed the push-notification stub. Phase 3 moved poi.import wholly into
// apps/ingest, dropping it from the backend registry (15 → 14).
expect(ALL_QUEUE_NAMES).toHaveLength(14);
```

(`queue-health.service.spec.ts` and `jobs.scheduler.spec.ts` build their fakes from `ALL_QUEUE_NAMES.map(...)` and assert against `ALL_QUEUE_NAMES.length`, so they auto-follow — no edits; the gate confirms.)

- [ ] **Step 10: Document the backend env var**

In `apps/backend/.env.example`, after the `TARMOTO_INTERNAL_API_TOKEN=` block (line ~54), add:

```bash
# Base URL of the apps/ingest internal API (server-to-server) the POI import
# admin proxies to for coverage/runs/trigger — e.g. the ingest service's
# internal address. REQUIRED for the admin POI management page; without it the
# trigger/coverage/runs calls 503 (the upload path still works — it's local).
# The proxy sends TARMOTO_INTERNAL_API_TOKEN as the `x-internal-token` header.
TARMOTO_INGEST_INTERNAL_URL=http://localhost:3005
```

- [ ] **Step 11: Run the backend suite to verify it passes**

Run: `pnpm --filter @tarmoto/backend test poi-import-admin`
Expected: PASS (proxy + re-sourced lock + de-guarded storeExtract).
Run: `pnpm --filter @tarmoto/backend test jobs.constants queue-health jobs.scheduler`
Expected: PASS (14 queues; POI injection gone).

- [ ] **Step 12: Full Task-2 gate**

Run: `pnpm backend:build && pnpm backend:test`
Expected: PASS.
Run: `pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service test`
Expected: PASS (apps/ingest untouched by Task 2).
Run: `pnpm openapi:gen && git status --porcelain packages/openapi-client`
Expected: empty output (no `/admin/poi/*` DTO shape change; the internal API is not in the exported spec).

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/modules/poi apps/backend/src/modules/jobs/jobs.constants.ts apps/backend/src/modules/jobs/jobs.constants.spec.ts apps/backend/src/modules/jobs/queue-health.service.ts apps/backend/package.json apps/backend/.env.example pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
refactor(backend): proxy the POI import admin to the ingest internal API

Turns PoiImportAdminService into an HTTP client of apps/ingest's
/internal/poi/* API, re-sources the upload lock onto a dedicated ioredis
client, and drops the backend poi.import queue registration (queue/job/pattern
entries + queue-health injection). The upload path stays admin -> backend ->
shared volume.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Docs / runbook

Document the cutover: the admin POI management page now proxies to the `apps/ingest` internal API; the new required config; uploads unchanged; the extraction is complete.

**Files:**

- Modify: `docs/reference/data-sources-and-storage.md`
- Modify: `docs/process/runbook.md`

**Interfaces:**

- Consumes: the final architecture from Tasks 1–2 (backend = POI reader + admin gateway; apps/ingest owns config/queue/schema/import + the internal API); env vars `TARMOTO_INTERNAL_API_TOKEN` (both apps) + `TARMOTO_INGEST_INTERNAL_URL` (backend).

---

- [ ] **Step 1: Update `data-sources-and-storage.md`**

Add/adjust the POI-ingestion section to state:

- The admin POI management page (`/admin/poi/*`) is a **thin proxy** to `apps/ingest`'s `/internal/poi/*` internal API (server-to-server, `x-internal-token`, not internet-exposed). `apps/ingest` owns the import config, the `poi.import` queue, the POI write-schema, and the coverage/runs/enqueue data plane. The backend's remaining POI role is a **reader** (`PoiService`/`PoiStoreService`) + an **admin gateway** (proxy + receive extract uploads → shared volume).
- The enablement view: `/internal/poi/regions` returns only enabled `(source, code)` pairs (a disabled source drops its rows; a configured pair carries `configured: true`), and the manual trigger `400`s an unconfigured pair — replacing Phase 2's "advertise all 34 + graceful skip."
- Uploads are **unchanged** (Option A): `admin → backend → shared `/data/poi-extracts` volume`; `apps/ingest` reads the same volume. The subsequent import is triggered via the API.
- New required config: `TARMOTO_INTERNAL_API_TOKEN` (both apps, equal) + `TARMOTO_INGEST_INTERNAL_URL` (backend). Without them the admin trigger/coverage/runs `503`/fail; the local upload path still works.

- [ ] **Step 2: Update `runbook.md`**

Add an operational note under the POI import / ingest section:

- Deploy order unchanged: `apps/ingest` first (now also serving `/internal/poi/*`), then the backend (which now depends on the API for the admin management page). Until both are up + configured, the admin management page degrades (trigger/coverage error), but POI reads + the scheduled import are unaffected.
- Set `TARMOTO_INTERNAL_API_TOKEN` on BOTH apps (same secret) and `TARMOTO_INGEST_INTERNAL_URL` on the backend (the ingest service's internal address).
- Note this pairs with the Phase-2 ops-enablement (the Coolify `apps/ingest` app + `INGEST_URL`/`COOLIFY_INGEST_UUID`).
- The `poi.import` queue now lives wholly inside `apps/ingest`; a stale job enqueued by an old backend before cutover is still consumed by `apps/ingest` (same queue name/Redis), and the worker's enablement skip guards an unconfigured stale job.

- [ ] **Step 3: Commit**

```bash
git add docs/reference/data-sources-and-storage.md docs/process/runbook.md
git commit -m "$(cat <<'EOF'
docs(ingest): document the internal API + backend proxy cutover

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-16-ingest-internal-api.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Fresh subagent per task + two-stage review. Task 2 is the largest (proxy rework + lock re-sourcing + queue-registry drop across four files + spec rework) — review it closely, or split its commit into "proxy + lock" and "queue-registry drop" if a reviewer prefers a smaller diff.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

- **REQUIRED SUB-SKILL:** Use superpowers:executing-plans
- Batch execution with checkpoints for review.

**Which approach?**
