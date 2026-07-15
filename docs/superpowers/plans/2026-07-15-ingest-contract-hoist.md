# `@tarmoto/ingest` Contract Hoist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the framework-free POI ingestion contract out of `apps/backend` into a new `@tarmoto/ingest` package, so the backend importer and the future `apps/ingest` service share one drift-proof source of truth. **Zero behavior change** — a pure import-path move.

**Architecture:** New dependency-light workspace package `packages/ingest` (CommonJS, Vitest — an exact clone of `@tarmoto/shared`'s setup) holds the region contract + the extract-refresh config under `src/poi/`. The backend's `registerAs` configs stay put and import the moved symbols back from `@tarmoto/ingest`. Both backend-compiling Docker images build the new package.

**Tech Stack:** pnpm workspaces, TypeScript (`module: NodeNext`, CommonJS output), Vitest (package tests), Jest (backend tests), Docker multi-stage.

## Global Constraints

- **Zero behavior change.** Only import paths + file locations change; no logic edits. Correctness = every existing test still passes, now resolving to the package.
- **`@tarmoto/ingest` mirrors `@tarmoto/shared` EXACTLY:** CommonJS (**no `"type"` field**), `main: dist/index.js` + `types: dist/index.d.ts` (no `exports` map), Vitest (`"test": "vitest run"` + a `vitest.config.ts`), `tsconfig.json` extends `../../tsconfig.base.json` with `outDir: dist` / `rootDir: src`. devDeps: `typescript: ^5.9.2`, `vitest: ^4.1.5`.
- **What MOVES:** `PoiImportRegion`, `DEFAULT_REGIONS`, `parseRegions` (from `poi-import.config.ts`) + the **entire** `poi-refresh.config.ts`.
- **What STAYS in `apps/backend/src/modules/poi/poi-import.config.ts`:** the `PoiImportConfig` interface, `boolEnv`, and `poiImportConfig` / `fsqImportConfig` (`registerAs` — NestJS). After the cut this file **becomes a consumer** of `@tarmoto/ingest`.
- **Commit convention:** conventional commits, lowercase subject, scope from {`backend`, `shared`, `cross`, `infra`, …}. End every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `refactor/ingest-contract-hoist` (already checked out; spec committed `fcdab0e3`).
- **Pre-production; monorepo.** No migration, no OpenAPI/mobile/companion contract change (moved symbols are backend/extractor-internal).

## File structure

- `packages/ingest/package.json`, `tsconfig.json`, `vitest.config.ts` — **create** (clone shared).
- `packages/ingest/src/index.ts` — **create**: `export * from './poi/index.js';`
- `packages/ingest/src/poi/index.ts` — **create**: barrel for `regions` + `refresh-config`.
- `packages/ingest/src/poi/regions.ts` (+ `regions.spec.ts`) — **create**: the region contract.
- `packages/ingest/src/poi/refresh-config.ts` (+ `refresh-config.spec.ts`) — **create**: the moved `poi-refresh.config`.
- `apps/backend/src/modules/poi/poi-import.config.ts` — **modify**: cut 3 symbols, import them back.
- `apps/backend/src/modules/poi/poi-import.config.spec.ts` — **modify**: split import, drop the moved test.
- `apps/backend/src/modules/poi/poi-refresh.config.ts` (+ `.spec.ts`) — **delete** (moved).
- 10 consumer files + the `.mjs` + `assets/README.md` — **modify** import/path.
- `apps/backend/package.json` — **modify**: add `@tarmoto/ingest` dep.
- Root `package.json` — **modify**: `ingest:build` + build-chain inserts.
- `apps/backend/Dockerfile` + `apps/backend/Dockerfile.poi-refresh` — **modify**: 4 edits each.

---

### Task 1: Scaffold the `@tarmoto/ingest` package

**Files:**

- Create: `packages/ingest/package.json`, `packages/ingest/tsconfig.json`, `packages/ingest/vitest.config.ts`, `packages/ingest/src/index.ts`

**Interfaces:**

- Produces: an empty, buildable `@tarmoto/ingest` workspace package (barrel filled in Task 2).

- [ ] **Step 1: Create `packages/ingest/package.json`** (clone of shared, renamed):

```json
{
  "name": "@tarmoto/ingest",
  "version": "0.0.1",
  "description": "Shared ingestion contract for Tarmoto (POI regions, extract config, SQL builders)",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/ingest/tsconfig.json`** (identical to shared):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/ingest/vitest.config.ts`** (identical to shared):

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
  },
});
```

- [ ] **Step 4: Create a placeholder barrel** `packages/ingest/src/index.ts` (replaced in Task 2):

```typescript
export {};
```

- [ ] **Step 5: Register + build the package**

Run: `pnpm install`
Expected: links `@tarmoto/ingest` into the workspace, updates `pnpm-lock.yaml` (the `packages/*` glob auto-includes it — no `pnpm-workspace.yaml` edit).

Run: `pnpm --filter @tarmoto/ingest build`
Expected: exits 0, emits `packages/ingest/dist/index.js` (empty module).

- [ ] **Step 6: Commit**

```bash
git add packages/ingest pnpm-lock.yaml
git commit -m "chore(cross): scaffold @tarmoto/ingest workspace package

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Hoist the contract + cut backend over (atomic)

This is one atomic task: the moment `poi-refresh.config.ts` and the region symbols leave the backend, every importer must already point at `@tarmoto/ingest`, or the backend won't compile. Do all of it, then run the full gate.

**Files:**

- Create: `packages/ingest/src/poi/regions.ts`, `packages/ingest/src/poi/regions.spec.ts`, `packages/ingest/src/poi/refresh-config.ts`, `packages/ingest/src/poi/refresh-config.spec.ts`, `packages/ingest/src/poi/index.ts`
- Modify: `packages/ingest/src/index.ts`, `apps/backend/package.json`, `apps/backend/src/modules/poi/poi-import.config.ts`, `apps/backend/src/modules/poi/poi-import.config.spec.ts`, and the 10 consumers + `.mjs` + README below.
- Delete: `apps/backend/src/modules/poi/poi-refresh.config.ts`, `apps/backend/src/modules/poi/poi-refresh.config.spec.ts`

**Interfaces:**

- Produces: `@tarmoto/ingest` exports `PoiImportRegion`, `DEFAULT_REGIONS`, `parseRegions`, and all former `poi-refresh.config` symbols (`GEOFABRIK_BASE_URL`, `GEOFABRIK_SLUGS`, `POI_TAGS_FILTER_EXPRESSIONS`, `geofabrikUrl`, `bboxArg`, `PoiRefreshConfig`, `resolvePoiRefreshConfig`, `FSQ_CATALOG_ENDPOINT`, `FSQ_PLACES_TABLE`, `FSQ_CATEGORY_PREFILTER`, `FSQ_DUCKDB_MEMORY_LIMIT`, `FsqRefreshConfig`, `FsqExtractSqlParams`, `resolveFsqRefreshConfig`, `buildFsqExtractSql`).
- Consumes: nothing new.

- [ ] **Step 1: Create `packages/ingest/src/poi/regions.ts`** — cut `PoiImportRegion` (current `poi-import.config.ts:24-29`), `DEFAULT_REGIONS` (`43-120`), and `parseRegions` (`122-158`) **verbatim, including their doc comments**, into this new file. It has no imports (self-contained). The file's top-level doc comment should describe the region contract (adapt the `regions` paragraph from `poi-import.config.ts:16-22`). Do not alter any logic, values, or the `throw` message.

- [ ] **Step 2: Create `packages/ingest/src/poi/regions.spec.ts`** — `parseRegions` had no direct tests (it was only exercised via the `registerAs` configs), so add direct coverage plus the bbox-validity test lifted from `poi-import.config.spec.ts:67-73`:

```typescript
import { DEFAULT_REGIONS, parseRegions } from "./regions.js";

describe("DEFAULT_REGIONS", () => {
  it("is the full 17-region coverage list", () => {
    expect(DEFAULT_REGIONS).toHaveLength(17);
  });

  it("every region carries a valid ISO-2 code and a non-degenerate bbox", () => {
    for (const { code, bbox } of DEFAULT_REGIONS) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(bbox.maxLng - bbox.minLng).toBeGreaterThan(0);
      expect(bbox.maxLat - bbox.minLat).toBeGreaterThan(0);
    }
  });
});

describe("parseRegions", () => {
  const ENV = "TARMOTO_POI_IMPORT_REGIONS";

  it("returns the full list for undefined or blank input", () => {
    expect(parseRegions(undefined, ENV)).toHaveLength(17);
    expect(parseRegions("   ", ENV)).toHaveLength(17);
  });

  it("narrows to the selected codes — upper-cased, trimmed, deduped, in order", () => {
    const r = parseRegions("sk, cz , CZ", ENV);
    expect(r.map((x) => x.code)).toEqual(["SK", "CZ"]);
    // bbox comes from the authoritative default, not the input
    expect(r[0]?.bbox).toEqual(
      DEFAULT_REGIONS.find((x) => x.code === "SK")?.bbox,
    );
  });

  it("throws on an unknown code, naming the env var", () => {
    expect(() => parseRegions("CZ,ZZ", ENV)).toThrow(
      /Invalid TARMOTO_POI_IMPORT_REGIONS: unknown region "ZZ"/,
    );
  });
});
```

- [ ] **Step 3: Create `packages/ingest/src/poi/refresh-config.ts`** — copy the **entire** current `apps/backend/src/modules/poi/poi-refresh.config.ts` verbatim, changing **only line 1** from:

```typescript
import { parseRegions, type PoiImportRegion } from "./poi-import.config.js";
```

to (now intra-package):

```typescript
import { parseRegions, type PoiImportRegion } from "./regions.js";
```

Everything else (the `GEOFABRIK_*`, `POI_TAGS_FILTER_EXPRESSIONS`, `geofabrikUrl`, `bboxArg`, local `boolEnv`, `PoiRefreshConfig`, `resolvePoiRefreshConfig`, all FSQ constants + `FsqRefreshConfig` + `resolveFsqRefreshConfig` + `sqlLiteral` + `FsqExtractSqlParams` + `buildFsqExtractSql`) is unchanged.

- [ ] **Step 4: Create `packages/ingest/src/poi/refresh-config.spec.ts`** — copy the **entire** current `apps/backend/src/modules/poi/poi-refresh.config.spec.ts` verbatim, changing only its two import statements (`poi-refresh.config.spec.ts:1-13`):

```typescript
import { DEFAULT_REGIONS } from "./regions.js";
import {
  FSQ_CATALOG_ENDPOINT,
  FSQ_CATEGORY_PREFILTER,
  FSQ_PLACES_TABLE,
  GEOFABRIK_SLUGS,
  POI_TAGS_FILTER_EXPRESSIONS,
  bboxArg,
  buildFsqExtractSql,
  geofabrikUrl,
  resolveFsqRefreshConfig,
  resolvePoiRefreshConfig,
} from "./refresh-config.js";
```

(The spec uses only `describe`/`it`/`expect` — Vitest-compatible as-is. If it references any `jest.*` API, replace with the `vi.*` equivalent; it should not, being a pure-function config spec.)

- [ ] **Step 5: Create `packages/ingest/src/poi/index.ts`** and update `packages/ingest/src/index.ts`:

`packages/ingest/src/poi/index.ts`:

```typescript
export * from "./regions.js";
export * from "./refresh-config.js";
```

`packages/ingest/src/index.ts` (replace the placeholder):

```typescript
export * from "./poi/index.js";
```

- [ ] **Step 6: Verify the package builds + tests green in isolation**

Run: `pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/ingest test`
Expected: build exits 0; Vitest reports all `regions.spec` + `refresh-config.spec` tests passing.

- [ ] **Step 7: Add the backend dependency**

Add to `apps/backend/package.json` `dependencies`, immediately after the `"@tarmoto/shared": "workspace:*",` line:

```json
    "@tarmoto/ingest": "workspace:*",
```

Run: `pnpm install`
Expected: links the dep, updates the lockfile.

- [ ] **Step 8: Cut the moved symbols out of `poi-import.config.ts`.** Delete `PoiImportRegion` (`24-29`), `DEFAULT_REGIONS` + its doc (`43-120`), and `parseRegions` + its doc (`122-158`). Add this import at the top (after the `registerAs` import at line 1):

```typescript
import { registerAs } from "@nestjs/config";
import { parseRegions, type PoiImportRegion } from "@tarmoto/ingest";
```

Keep `PoiImportConfig`, `boolEnv`, `poiImportConfig`, `fsqImportConfig` unchanged (they still call `parseRegions(...)` and reference `PoiImportRegion`). Do **not** re-import `DEFAULT_REGIONS` — the trimmed file references it only in a doc comment.

- [ ] **Step 9: Fix `poi-import.config.spec.ts`.** Change the import (`1-5`) to a split, and **delete** the bbox-validity test (`67-73`, now covered in the package):

```typescript
import { fsqImportConfig, poiImportConfig } from "./poi-import.config.js";
import { DEFAULT_REGIONS } from "@tarmoto/ingest";
```

(The remaining tests still use `DEFAULT_REGIONS` at lines 32-34 and 50-52 — now sourced from `@tarmoto/ingest`. Keep all `poiImportConfig`/`fsqImportConfig` tests.)

- [ ] **Step 10: Rewire the region-symbol consumers.** Repoint each import to `@tarmoto/ingest`:

- `apps/backend/src/modules/poi/poi-import-source.ts:3` → `import type { PoiImportRegion } from '@tarmoto/ingest';`
- `apps/backend/src/modules/poi/poi-import-source.spec.ts:7` → `import type { PoiImportRegion } from '@tarmoto/ingest';`
- `apps/backend/src/modules/jobs/processors/poi-import.processor.spec.ts:8` → `import type { PoiImportRegion } from '@tarmoto/ingest';`
- `apps/backend/src/scripts/load-region-boundaries.ts:7` → `import { DEFAULT_REGIONS } from '@tarmoto/ingest';`
- `apps/backend/src/scripts/refresh-fsq-extracts.spec.ts:11` → `import type { PoiImportRegion } from '@tarmoto/ingest';`

**Mixed imports — split into two statements** (one symbol stays, one moves):

- `apps/backend/src/modules/poi/poi-import.service.ts:15` — replace `import { poiImportConfig, type PoiImportRegion } from './poi-import.config.js';` with:
  ```typescript
  import { poiImportConfig } from "./poi-import.config.js";
  import type { PoiImportRegion } from "@tarmoto/ingest";
  ```
- `apps/backend/src/modules/poi/poi-import.service.spec.ts:27` — replace `import type { PoiImportConfig, PoiImportRegion } from './poi-import.config.js';` with:

  ```typescript
  import type { PoiImportConfig } from "./poi-import.config.js";
  import type { PoiImportRegion } from "@tarmoto/ingest";
  ```

- [ ] **Step 11: Rewire the two refresh scripts + their specs** (they import both a region symbol and `poi-refresh.config` symbols — repoint both statements to `@tarmoto/ingest`):

- `apps/backend/src/scripts/refresh-poi-extracts.ts:38-45` → change the `poi-import.config.js` path on line 38 and the `poi-refresh.config.js` path on line 45 both to `@tarmoto/ingest`:
  ```typescript
  import type { PoiImportRegion } from "@tarmoto/ingest";
  import {
    bboxArg,
    geofabrikUrl,
    POI_TAGS_FILTER_EXPRESSIONS,
    resolvePoiRefreshConfig,
    type PoiRefreshConfig,
  } from "@tarmoto/ingest";
  ```
- `apps/backend/src/scripts/refresh-fsq-extracts.ts:30-35` →
  ```typescript
  import type { PoiImportRegion } from "@tarmoto/ingest";
  import {
    buildFsqExtractSql,
    resolveFsqRefreshConfig,
    type FsqRefreshConfig,
  } from "@tarmoto/ingest";
  ```
- `apps/backend/src/scripts/refresh-poi-extracts.spec.ts:12-13` →

  ```typescript
  import type { PoiImportRegion } from "@tarmoto/ingest";
  import { bboxArg } from "@tarmoto/ingest";
  ```

- [ ] **Step 12: Fix the non-import couplings.**

`apps/backend/src/scripts/derive-region-boundaries.mjs:13-16` regex-scrapes the config **source file** for `DEFAULT_REGIONS`; repoint `readFileSync` at the new location:

```javascript
const configSrc = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "ingest",
    "src",
    "poi",
    "regions.ts",
  ),
  "utf8",
);
```

(Verify the relative depth from `apps/backend/src/scripts/` to `packages/ingest/src/poi/regions.ts` and adjust the `..` segments so the path resolves; the regex `code:\s*'([A-Z]{2})'` still matches the moved `DEFAULT_REGIONS`.)

`apps/backend/src/assets/README.md:24,46` — update the two references from `apps/backend/src/modules/poi/poi-import.config.ts` to `packages/ingest/src/poi/regions.ts`.

- [ ] **Step 13: Delete the moved backend files**

```bash
git rm apps/backend/src/modules/poi/poi-refresh.config.ts \
       apps/backend/src/modules/poi/poi-refresh.config.spec.ts
```

- [ ] **Step 14: Run the full gate**

Run: `pnpm --filter @tarmoto/ingest build`
Then: `pnpm --filter @tarmoto/backend test` — Expected: full backend suite passes (incl. `poi-import.config.spec`, `refresh-poi-extracts.spec`, `refresh-fsq-extracts.spec`, `migration-registry.spec`), 0 failures.
Then: `pnpm openapi:gen` — Expected: the strict backend build (`noUncheckedIndexedAccess` gate) + client regen succeed with **no diff** to `packages/openapi-client/src/generated/schema.d.ts` (no contract change).
Then (proves the `.mjs` fix): `node apps/backend/src/scripts/derive-region-boundaries.mjs` if it runs standalone, else confirm it no longer throws `"Failed to parse DEFAULT_REGIONS codes"` — Expected: parses ≥17 codes.

If `openapi:gen` fails because `@tarmoto/ingest` isn't built first, that's expected until Task 3 wires the chain — build it manually first (`pnpm --filter @tarmoto/ingest build`) for this gate.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "refactor(cross): hoist POI ingestion contract into @tarmoto/ingest

Move PoiImportRegion/DEFAULT_REGIONS/parseRegions + the whole poi-refresh.config
into @tarmoto/ingest/src/poi; backend registerAs configs + consumers import them
back. Pure import-path move, zero behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire build chains + both Dockerfiles

**Files:**

- Modify: root `package.json` (scripts), `apps/backend/Dockerfile`, `apps/backend/Dockerfile.poi-refresh`

**Interfaces:**

- Consumes: `@tarmoto/ingest` (built before backend everywhere backend is built).

- [ ] **Step 1: Add an `ingest:build` script + insert it into the chains** in root `package.json` `scripts`. Add after the `"shared:build"` line:

```json
    "ingest:build": "pnpm --filter @tarmoto/ingest build",
```

Then prepend `pnpm ingest:build && ` before the backend build in every composite that builds/runs the backend, so the package's `dist` exists first. Edit these exact scripts:

- `"openapi:gen": "pnpm shared:build && pnpm ingest:build && pnpm --filter @tarmoto/openapi generate",`
- `"db:seed": "pnpm shared:build && pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend seed:demo",`
- `"db:migrate:poi": "pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend db:migrate:poi",`
- `"poi:import": "pnpm shared:build && pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend poi:import",`
- `"fsq:import": "pnpm shared:build && pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend fsq:import",`
- `"poi:load-boundaries": "pnpm shared:build && pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend poi:load-boundaries",`
- `"backend:db:migrate": "pnpm ingest:build && pnpm backend:build && pnpm --filter @tarmoto/backend db:migrate",`

- [ ] **Step 2: Verify the chain**

Run: `pnpm openapi:gen`
Expected: builds shared → ingest → backend (via openapi) cleanly; exits 0.

- [ ] **Step 3: Edit `apps/backend/Dockerfile`** — four insertions (mirrors the `shared` wiring):

1. Deps stage, after `COPY packages/shared/package.json packages/shared/package.json` (line 32):
   ```dockerfile
   COPY packages/ingest/package.json packages/ingest/package.json
   ```
2. Build stage, after `COPY packages/shared packages/shared` (line 40):
   ```dockerfile
   COPY packages/ingest packages/ingest
   ```
3. Build stage, insert the ingest build before the backend build (line 42-43 becomes):
   ```dockerfile
   RUN pnpm --filter @tarmoto/shared build \
    && pnpm --filter @tarmoto/ingest build \
    && pnpm --filter @tarmoto/backend build
   ```
4. Runtime stage: after `COPY --from=build /workspace/packages/shared/package.json ...` (line 58):
   ```dockerfile
   COPY --from=build /workspace/packages/ingest/package.json packages/ingest/package.json
   ```
   and after `COPY --from=build /workspace/packages/shared/dist packages/shared/dist` (line 64):
   ```dockerfile
   COPY --from=build /workspace/packages/ingest/dist packages/ingest/dist
   ```
   (The runtime prod install `--filter @tarmoto/backend...` already pulls ingest's deps via the `...` selector — no change.)

- [ ] **Step 4: Edit `apps/backend/Dockerfile.poi-refresh`** — the same four insertions at its stage lines: after deps `COPY packages/shared/package.json` (line 49); after build `COPY packages/shared packages/shared` (line 57); the ingest build between the shared+backend build (lines 59-60); and the runtime `package.json` + `dist` COPYs (after lines 104 and 110).

- [ ] **Step 5: Build BOTH images locally (the real wiring gate)**

Run: `docker build -f apps/backend/Dockerfile -t tarmoto-backend:ingest-test .`
Expected: BUILD SUCCESS (resolves `@tarmoto/ingest` at the backend build step).

Run: `docker build -f apps/backend/Dockerfile.poi-refresh -t tarmoto-poi-refresh:ingest-test .`
Expected: BUILD SUCCESS. Then clean up: `docker image rm tarmoto-backend:ingest-test tarmoto-poi-refresh:ingest-test`.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/backend/Dockerfile apps/backend/Dockerfile.poi-refresh
git commit -m "build(infra): build @tarmoto/ingest before backend (chains + both images)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** package (Task 1), region + refresh-config move (Task 2 Steps 1-6), backend cutover incl. `registerAs`-stays + mixed-import splits + the `.mjs`/README couplings (Task 2 Steps 7-13), zero-behavior gate (Step 14), build/Docker topology (Task 3). The spec's "config-contract only" boundary holds — no import logic, entities, or `refresh-*` scripts move. ✔
- **Placeholder scan:** none — every new file's content is given or specified as an exact verbatim-move + one-line change; every consumer edit shows the exact new import; the `.mjs` path depth is flagged to verify. ✔
- **Type consistency:** the exported symbol names in Task 2's `Produces` block match the consumer imports in Steps 10-11 and the `refresh-config.spec` import in Step 4; `PoiImportRegion`/`DEFAULT_REGIONS`/`parseRegions` are identical everywhere. ✔
- **Known deviation from the spec (intentional):** the spec said "jest config mirroring packages/shared" — shared actually uses **Vitest**, so the package uses Vitest (`vitest.config.ts` + `vitest run`); the moved config spec is Vitest-compatible. And `poi.module.ts` imports only `poiImportConfig`/`fsqImportConfig` (both stay) → **no edit**, correctly excluded.
