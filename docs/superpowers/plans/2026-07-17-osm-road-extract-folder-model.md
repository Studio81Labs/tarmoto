# OSM Road Extract Producer + Folder-Model Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the road importer's single-file / single-bbox extract model with the POI pipeline's automated per-region folder model — a road-extract producer in `apps/ingest` and a backend importer that reads a folder of `<code>.osm` extracts and imports every configured region in one pass.

**Architecture:** A new `refresh-road-extracts.ts` in `apps/ingest` mirrors `refresh-poi-extracts.ts` with a drivable-highway `osmium tags-filter`, writing one `<code>.osm` per region to a shared volume. The backend `OsmImportService` grows `importAll()` (loop regions → per-region read + reconcile). The existing `reconcile()` is **already tile-aware** (it filters incoming rows to the region via `intersectsRegion` and tombstones per-bbox), so the core change is parameterizing its `region` (was `this.config.bbox`) and looping. `quality-conflation` loses its `osmRoadImportConfig.bbox` coupling (→ whole-network). `road_segments` and the `road.import` queue are unchanged.

**Tech Stack:** TypeScript (strict), NestJS 11, TypeORM + PostGIS, osmium (extractor container), Jest, pnpm workspaces, `@tarmoto/ingest` shared package.

## Global Constraints

- **Dormant / dark:** `TARMOTO_OSM_ROAD_IMPORT_ENABLED` and `TARMOTO_OSM_ROAD_REFRESH_ENABLED` default **false**. Nothing served changes.
- **No DB migration.** `road_segments` is untouched (as Sub-project A / migration 1811 left it), on the backend's default connection. `openapi:gen` must be **byte-identical** (no contract change).
- **No backward-compat.** Remove `TARMOTO_OSM_ROAD_IMPORT_FILE` and `TARMOTO_OSM_ROAD_IMPORT_BBOX` entirely (pre-production; breaking env vars is acceptable). No shim.
- **Naming (`{source}_{domain}`, PR #1016):** the road import stays `osm_road` — queue `road.import`, config key `'osmRoadImport'`, envs `TARMOTO_OSM_ROAD_IMPORT_*`. Do **not** rename these.
- **New envs:** add `TARMOTO_OSM_ROAD_IMPORT_DIR`, `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (both read by producer _and_ importer), and `TARMOTO_OSM_ROAD_REFRESH_ENABLED` (producer gate only).
- **`DRIVABLE_HIGHWAYS` is one source of truth** in `@tarmoto/ingest` — the backend importer and the ingest producer both import it. Divergence would silently drop road classes from the extract.
- **Extract strategy = `complete_ways`** (osmium `extract -b` default, no `-s` flag), matching the POI refresh. `reconcile()` already documents and handles this: it filters incoming rows to the region bbox (`intersectsRegion`) so out-of-region segments of a boundary-crossing way are dropped, and a straddling segment kept by two adjacent regions upserts idempotently.
- **Empty-extract guard (intentional departure):** in the folder path, an **absent** region file → skip; a **present but 0-way** extract → skip **with a warning** (do NOT reconcile/tombstone). This deliberately overrides `reconcile()`'s "empty tile + region is authoritative → tombstone the region" behavior, because folder-model regions are automated whole-country extracts where an empty result signals a broken refresh, never a genuinely empty country.
- **quality-conflation is decoupled, not folder-model-ized:** it stops reading `osmRoadImportConfig.bbox` and conflates the **whole network**. Its own `TARMOTO_QUALITY_CONFLATION_*` envs and single-file behavior are untouched.
- Every task ends with: grep for retired tokens (`TARMOTO_OSM_ROAD_IMPORT_FILE`, `TARMOTO_OSM_ROAD_IMPORT_BBOX`, `importFromConfiguredFile`, `parseBbox`) returning nothing in scope + `pnpm --filter @tarmoto/backend build`, `pnpm --filter @tarmoto/backend lint`, the touched Jest suites, and (Tasks 3-5) `pnpm --filter @tarmoto/backend openapi:gen` byte-identical.

---

### Task 1: Hoist `DRIVABLE_HIGHWAYS` + road tag filter into `@tarmoto/ingest`

**Files:**

- Create: `packages/ingest/src/roads/road-tags.ts`
- Create: `packages/ingest/src/roads/road-refresh-config.ts`
- Create: `packages/ingest/src/roads/index.ts`
- Create: `packages/ingest/src/roads/road-refresh-config.spec.ts`
- Modify: `packages/ingest/src/index.ts:1`
- Modify: `apps/backend/src/modules/roads/osm-import/osm-tags.ts:1,17-33,80`

**Interfaces:**

- Produces: `DRIVABLE_HIGHWAYS: readonly string[]`, `ROAD_TAGS_FILTER_EXPRESSIONS: readonly string[]`, `interface RoadRefreshConfig { enabled: boolean; targetDir: string | null; regions: readonly PoiImportRegion[] }`, `resolveRoadRefreshConfig(env?: NodeJS.ProcessEnv): RoadRefreshConfig` — all exported from `@tarmoto/ingest`.
- Consumes: `parseRegions`, `PoiImportRegion` from `../poi/regions.js`.

- [ ] **Step 1: Write the failing test** — `packages/ingest/src/roads/road-refresh-config.spec.ts`

```ts
import {
  DRIVABLE_HIGHWAYS,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  resolveRoadRefreshConfig,
} from "./index.js";

describe("road tag filter", () => {
  it("is one w/highway= expression covering every drivable class (importer superset)", () => {
    expect(ROAD_TAGS_FILTER_EXPRESSIONS).toHaveLength(1);
    const expr = ROAD_TAGS_FILTER_EXPRESSIONS[0]!;
    expect(expr.startsWith("w/highway=")).toBe(true);
    for (const hw of DRIVABLE_HIGHWAYS) {
      expect(expr).toContain(hw);
    }
    // ways only — roads are ways, not nodes/relations (unlike the POI nwr/ filter)
    expect(expr.startsWith("nwr/")).toBe(false);
  });
});

describe("resolveRoadRefreshConfig", () => {
  it("reads the road env (enabled gate, shared dir + regions)", () => {
    const cfg = resolveRoadRefreshConfig({
      TARMOTO_OSM_ROAD_REFRESH_ENABLED: "true",
      TARMOTO_OSM_ROAD_IMPORT_DIR: "/data/road-extracts",
      TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,SK",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.targetDir).toBe("/data/road-extracts");
    expect(cfg.regions.map((r) => r.code)).toEqual(["CZ", "SK"]);
  });

  it("defaults off, null dir, all regions when unset", () => {
    const cfg = resolveRoadRefreshConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.targetDir).toBeNull();
    expect(cfg.regions.length).toBeGreaterThan(1);
  });

  it("throws on an unknown region code (no silent drop)", () => {
    expect(() =>
      resolveRoadRefreshConfig({
        TARMOTO_OSM_ROAD_IMPORT_REGIONS: "CZ,ZZ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ZZ/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tarmoto/ingest test -- road-refresh-config`
Expected: FAIL — `Cannot find module './index.js'` / exports undefined.

- [ ] **Step 3: Create `packages/ingest/src/roads/road-tags.ts`**

```ts
/**
 * `highway=*` values imported as drivable roads (#781, Sub-project B).
 *
 * SINGLE SOURCE OF TRUTH for two consumers that must never drift:
 *  - the backend importer's `isDrivableHighway` gate (`osm-tags.ts`), and
 *  - the ingest road-extract producer's `osmium tags-filter` expression
 *    (`road-refresh-config.ts`).
 *
 * If these diverged, the extract could silently drop a class the importer keeps
 * — a permanent coverage gap that looks like "no roads there". The extract
 * filter is a deliberate SUPERSET: the importer still applies finer
 * access/service gating downstream; this list only makes the coarse
 * "is this way a road at all?" cut. `track` is included (forest/agri roads
 * riders use); footways / cycleways / paths are excluded.
 */
export const DRIVABLE_HIGHWAYS: readonly string[] = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "track",
];
```

- [ ] **Step 4: Create `packages/ingest/src/roads/road-refresh-config.ts`**

```ts
import { parseRegions, type PoiImportRegion } from "../poi/regions.js";
import { DRIVABLE_HIGHWAYS } from "./road-tags.js";

/**
 * `osmium tags-filter` expression for the road-extract producer — WAYS whose
 * `highway` is a drivable class (osmium ORs the comma-separated values within
 * one `key=v1,v2,…`). Built from {@link DRIVABLE_HIGHWAYS} so it stays a
 * superset of the importer's gate. `w/` = ways only.
 */
export const ROAD_TAGS_FILTER_EXPRESSIONS: readonly string[] = [
  `w/highway=${DRIVABLE_HIGHWAYS.join(",")}`,
];

function boolEnv(value: string | undefined): boolean {
  return (value ?? "false").trim().toLowerCase() === "true";
}

export interface RoadRefreshConfig {
  /** Gate — off unless `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true`. */
  enabled: boolean;
  /**
   * Directory the fresh `<code>.osm` files are written to — the SAME
   * `TARMOTO_OSM_ROAD_IMPORT_DIR` the backend importer reads. `null` when unset
   * (the script fails fast: nowhere to write). MUST differ from the POI import
   * dir, or POI + road `<code>.osm` files would collide.
   */
  targetDir: string | null;
  /**
   * Regions to refresh: `DEFAULT_REGIONS` narrowed by
   * `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (default all). Shares the importer's region
   * env so refresh and import always target the same set; an unknown code fails
   * fast rather than being silently dropped.
   */
  regions: readonly PoiImportRegion[];
}

/**
 * Resolve the road refresh config from the environment — standalone (no Nest
 * DI), so the refresh container needn't boot the app. Mirrors
 * `resolvePoiRefreshConfig` but for the road source's env (`TARMOTO_OSM_ROAD_*`).
 */
export function resolveRoadRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): RoadRefreshConfig {
  const dir = env.TARMOTO_OSM_ROAD_IMPORT_DIR?.trim();
  return {
    enabled: boolEnv(env.TARMOTO_OSM_ROAD_REFRESH_ENABLED),
    targetDir: dir ? dir : null,
    regions: parseRegions(
      env.TARMOTO_OSM_ROAD_IMPORT_REGIONS,
      "TARMOTO_OSM_ROAD_IMPORT_REGIONS",
    ),
  };
}
```

- [ ] **Step 5: Create `packages/ingest/src/roads/index.ts`**

```ts
export * from "./road-tags.js";
export * from "./road-refresh-config.js";
```

- [ ] **Step 6: Add the roads barrel to the package root** — `packages/ingest/src/index.ts`

```ts
export * from "./poi/index.js";
export * from "./roads/index.js";
```

- [ ] **Step 7: Rewire the backend importer to the hoisted list** — `apps/backend/src/modules/roads/osm-import/osm-tags.ts`

Replace the local `const DRIVABLE_HIGHWAYS = new Set([...])` (lines 17-33) with an import + a Set built from the shared list. At the top (after line 1's `import type { SurfaceType }`):

```ts
import { DRIVABLE_HIGHWAYS } from "@tarmoto/ingest";
```

Delete the entire local `const DRIVABLE_HIGHWAYS = new Set([...]);` block and replace with:

```ts
/** Set for O(1) membership — the canonical list lives in `@tarmoto/ingest`
 *  (`DRIVABLE_HIGHWAYS`) so the extract producer's tag filter can't drift. */
const DRIVABLE_HIGHWAY_SET = new Set<string>(DRIVABLE_HIGHWAYS);
```

Then in `isDrivableHighway` (line 80) change `DRIVABLE_HIGHWAYS.has(hw)` → `DRIVABLE_HIGHWAY_SET.has(hw)`.

- [ ] **Step 8: Build the shared package + run both suites**

Run: `pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/ingest test -- road-refresh-config`
Expected: PASS.
Run: `pnpm --filter @tarmoto/backend test -- osm-tags`
Expected: PASS (isDrivableHighway behavior unchanged).

- [ ] **Step 9: Gate — build + lint + grep**

Run: `pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend lint`
Run: `rg -n "new Set\(\[$" apps/backend/src/modules/roads/osm-import/osm-tags.ts` (expect the local DRIVABLE_HIGHWAYS Set literal to be gone)
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add packages/ingest/src apps/backend/src/modules/roads/osm-import/osm-tags.ts
git commit -m "feat(ingest): hoist DRIVABLE_HIGHWAYS + add road tag-filter config"
```

---

### Task 2: Road-extract producer (`refresh-road-extracts.ts`)

**Files:**

- Create: `apps/ingest/src/scripts/refresh-road-extracts.ts`
- Create: `apps/ingest/src/scripts/refresh-road-extracts.spec.ts`
- Modify: `apps/ingest/package.json:20` (add a `road:refresh` script)

**Interfaces:**

- Consumes: `ROAD_TAGS_FILTER_EXPRESSIONS`, `resolveRoadRefreshConfig`, `RoadRefreshConfig`, `bboxArg`, `geofabrikUrl`, `PoiImportRegion` from `@tarmoto/ingest` (Task 1); `describeExecError`, `refreshTmpPath`, `sweepStaleTempFiles`, `RefreshSummary` from `./refresh-common.js` (verbatim reuse).
- Produces: `refreshRegion(region, targetDir, workDir, deps)`, `refreshAll(config, workDir, deps, log?)`, `interface RefreshDeps { download; osmium }` — same shapes as `refresh-poi-extracts.ts`.

This is a structural mirror of `apps/ingest/src/scripts/refresh-poi-extracts.ts`. It differs only in: the tag filter (road, not POI), the log/label prefix, the work-dir/intermediate names, and the CLI guard filename.

- [ ] **Step 1: Write the failing test** — `apps/ingest/src/scripts/refresh-road-extracts.spec.ts` (mirror `refresh-poi-extracts.spec.ts`; road-filter assertion)

```ts
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bboxArg,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  type PoiImportRegion,
} from "@tarmoto/ingest";
import { refreshRegion } from "./refresh-road-extracts.js";

const CZ: PoiImportRegion = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};

function fakeOsmium(): jest.Mock<Promise<void>, [readonly string[]]> {
  return jest.fn(async (args: readonly string[]) => {
    const out = args[args.indexOf("-o") + 1];
    if (out) await writeFile(out, `built:${args[0]}`);
  });
}
function fakeDownload(): jest.Mock<Promise<void>, [string, string]> {
  return jest.fn(async (_url: string, dest: string) => {
    await writeFile(dest, "pbf-bytes");
  });
}

describe("refresh-road-extracts", () => {
  let targetDir: string;
  let workDir: string;
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "road-refresh-test-"));
    targetDir = join(root, "extracts");
    workDir = join(root, "work");
    await mkdir(targetDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(targetDir, ".."), { recursive: true, force: true });
  });

  it("downloads, road-filters, clips, and atomically writes <code>.osm", async () => {
    const download = fakeDownload();
    const osmium = fakeOsmium();
    await refreshRegion(CZ, targetDir, workDir, { download, osmium });

    expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe(
      "built:extract",
    );
    expect(download).toHaveBeenCalledWith(
      expect.stringContaining("czech-republic-latest.osm.pbf"),
      expect.any(String),
    );
    const calls = osmium.mock.calls.map((c) => c[0]);
    expect(calls[0]?.[0]).toBe("tags-filter");
    expect(calls[0]).toContain(ROAD_TAGS_FILTER_EXPRESSIONS[0]);
    expect(calls[1]?.[0]).toBe("extract");
    expect(calls[1]).toContain(bboxArg(CZ.bbox));
    expect(calls[1]).toEqual(expect.arrayContaining(["-f", "osm"]));
    expect(await readdir(workDir)).toEqual([]);
    expect(await readdir(targetDir)).toEqual(["cz.osm"]);
  });

  it("keeps the previous extract when a step fails", async () => {
    await writeFile(join(targetDir, "cz.osm"), "OLD-GOOD");
    const download = fakeDownload();
    const osmium = jest.fn(async (args: readonly string[]) => {
      if (args[0] === "extract") throw new Error("osmium extract boom");
      const out = args[args.indexOf("-o") + 1];
      if (out) await writeFile(out, "filtered");
    });
    await expect(
      refreshRegion(CZ, targetDir, workDir, { download, osmium }),
    ).rejects.toThrow("osmium extract boom");
    expect(await readFile(join(targetDir, "cz.osm"), "utf8")).toBe("OLD-GOOD");
    expect(await readdir(workDir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tarmoto/ingest-service test -- refresh-road-extracts`
Expected: FAIL — cannot find `./refresh-road-extracts.js`.

(Note: the app package name is `@tarmoto/ingest-service`; the shared package is `@tarmoto/ingest`. Verify from `apps/ingest/package.json` `name` field before running.)

- [ ] **Step 3: Create `apps/ingest/src/scripts/refresh-road-extracts.ts`**

```ts
/**
 * Automated OSM road-extract refresh (#781, Sub-project B) — the "fetch" half of
 * the offline road-quality pipeline, the road analogue of `refresh-poi-extracts`.
 * Runs via a scheduled Coolify `docker exec` into the already-running
 * `apps/ingest` container, SEPARATE from the backend runtime so osmium + multi-GB
 * PBF handling never bloat the app image. For each configured region it downloads
 * the Geofabrik country PBF, `osmium tags-filter`s it to the drivable-highway set
 * (`ROAD_TAGS_FILTER_EXPRESSIONS`), `osmium extract -b`s it to the region's bbox
 * (default `complete_ways` — boundary-crossing ways stay whole; the backend
 * importer scopes them per-region), and ATOMICALLY writes `<code>.osm` to
 * `TARMOTO_OSM_ROAD_IMPORT_DIR` — the shared volume the backend `road.import`
 * cron reads.
 *
 * Guarantees mirror `refresh-poi-extracts`: atomic keep-last-good (`.part` then
 * rename), a partial failure exits non-zero, bounded disk (sequential regions),
 * env-gated on `TARMOTO_OSM_ROAD_REFRESH_ENABLED`.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PoiImportRegion } from "@tarmoto/ingest";
import {
  bboxArg,
  geofabrikUrl,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  resolveRoadRefreshConfig,
  type RoadRefreshConfig,
} from "@tarmoto/ingest";
import {
  describeExecError,
  refreshTmpPath,
  sweepStaleTempFiles,
  type RefreshSummary,
} from "./refresh-common.js";

const execFileAsync = promisify(execFile);

/** Injectable I/O seams so orchestration is unit-testable without a network or a
 *  real `osmium` binary. */
export interface RefreshDeps {
  download: (url: string, dest: string) => Promise<void>;
  osmium: (args: readonly string[]) => Promise<void>;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || res.body === null) {
    throw new Error(
      `download failed (${res.status} ${res.statusText}) for ${url}`,
    );
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function runOsmium(args: readonly string[]): Promise<void> {
  try {
    await execFileAsync("osmium", [...args], { maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    throw new Error(describeExecError(`osmium ${args[0] ?? ""}`.trim(), err), {
      cause: err,
    });
  }
}

/**
 * Refresh one region end-to-end. Builds the extract at a unique sibling `.part`
 * file and only renames onto `<code>.osm` after every step succeeds, so a
 * failure never truncates the live extract. Always cleans up the (multi-GB)
 * intermediates and any leftover `.part`.
 */
export async function refreshRegion(
  region: PoiImportRegion,
  targetDir: string,
  workDir: string,
  deps: RefreshDeps,
): Promise<void> {
  const url = geofabrikUrl(region.code);
  if (url === null) {
    throw new Error(`no Geofabrik slug configured for ${region.code}`);
  }
  const pbf = join(workDir, `${region.code}-latest.osm.pbf`);
  const filtered = join(workDir, `${region.code}-road.osm.pbf`);
  const finalOut = join(targetDir, `${region.code.toLowerCase()}.osm`);
  const tmpOut = refreshTmpPath(finalOut);

  try {
    await deps.download(url, pbf);
    await deps.osmium([
      "tags-filter",
      pbf,
      ...ROAD_TAGS_FILTER_EXPRESSIONS,
      "-o",
      filtered,
      "--overwrite",
    ]);
    await deps.osmium([
      "extract",
      "-b",
      bboxArg(region.bbox),
      filtered,
      // Write OSM XML explicitly — osmium can't detect the format from our `.part`
      // temp suffix, so without `-f osm` the extract fails for every region.
      "-f",
      "osm",
      "-o",
      tmpOut,
      "--overwrite",
    ]);
    await rename(tmpOut, finalOut);
  } finally {
    await Promise.all([
      rm(pbf, { force: true }),
      rm(filtered, { force: true }),
      rm(tmpOut, { force: true }),
    ]);
  }
}

/**
 * Refresh every region in `config`, isolating failures: one region's error is
 * logged and recorded, and the loop moves on (its live extract stays as-is).
 */
export async function refreshAll(
  config: RoadRefreshConfig,
  workDir: string,
  deps: RefreshDeps,
  log: (msg: string) => void = console.log,
): Promise<RefreshSummary> {
  if (config.targetDir === null) {
    throw new Error(
      "TARMOTO_OSM_ROAD_IMPORT_DIR is not set — nowhere to write refreshed extracts",
    );
  }
  await sweepStaleTempFiles(config.targetDir, log);
  const summary: RefreshSummary = { ok: [], failed: [] };
  log(
    `road refresh: ${config.regions.length} region(s) — ` +
      `${config.regions.map((r) => r.code).join(", ") || "(none)"}`,
  );
  for (const region of config.regions) {
    try {
      log(`road refresh (${region.code}): download → filter → clip…`);
      await refreshRegion(region, config.targetDir, workDir, deps);
      summary.ok.push(region.code);
      log(
        `road refresh (${region.code}): wrote ${region.code.toLowerCase()}.osm`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.failed.push({ code: region.code, error });
      log(
        `road refresh (${region.code}): FAILED — ${error} (kept the previous extract)`,
      );
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const config = resolveRoadRefreshConfig();
  if (!config.enabled) {
    console.log(
      "road refresh: TARMOTO_OSM_ROAD_REFRESH_ENABLED is not true — skipping.",
    );
    return;
  }
  const workDir = join(tmpdir(), `road-refresh-${process.pid}`);
  await mkdir(workDir, { recursive: true });
  try {
    const { ok, failed } = await refreshAll(config, workDir, {
      download: downloadToFile,
      osmium: runOsmium,
    });
    console.log(`road refresh done: ${ok.length} ok, ${failed.length} failed.`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("refresh-road-extracts.js")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/ingest-service test -- refresh-road-extracts`
Expected: PASS.

- [ ] **Step 5: Add the `road:refresh` script** — `apps/ingest/package.json` (after the `fsq:refresh` line)

```json
    "road:refresh": "node dist/scripts/refresh-road-extracts.js",
```

- [ ] **Step 6: Gate — build + lint**

Run: `pnpm --filter @tarmoto/ingest-service build && pnpm --filter @tarmoto/ingest-service lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/ingest/src/scripts/refresh-road-extracts.ts apps/ingest/src/scripts/refresh-road-extracts.spec.ts apps/ingest/package.json
git commit -m "feat(ingest): add automated OSM road-extract refresh producer"
```

---

### Task 3: Folder-model road import (config + `OsmImportService`)

**Files:**

- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.config.ts` (full rewrite of the config shape + doc)
- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.service.ts` (add `importAll`/`importRegion`/`bboxTuple`/`bufferRows`; parameterize `reconcile`/`importFrom`; remove `importFromConfiguredFile`)
- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.service.spec.ts` (config shape; `importFrom` region param; new `importAll`/`importRegion` tests)

**Interfaces:**

- Consumes: `parseRegions`, `PoiImportRegion` from `@tarmoto/ingest` (Task 1).
- Produces: `interface RoadImportConfig { enabled: boolean; extractDir: string | null; regions: PoiImportRegion[] }`; `OsmImportService.importAll(): Promise<OsmImportResult>`; `OsmImportService.importRegion(region: PoiImportRegion, extractDir: string): Promise<OsmImportResult>`; `OsmImportService.importFrom(source: OsmWaySource, region?: [number, number, number, number] | null): Promise<OsmImportResult>`. `OsmImportResult` unchanged (`{ upserted; carriedOver; deactivated }`). `enabled` getter unchanged. Config key stays `'osmRoadImport'`.

- [ ] **Step 1: Rewrite the config** — `apps/backend/src/modules/roads/osm-import/osm-import.config.ts` (replace the whole file)

```ts
import { registerAs } from "@nestjs/config";
import { parseRegions, type PoiImportRegion } from "@tarmoto/ingest";

/**
 * Config for the scheduled OSM → `road_segments` import (#781, folder model in
 * Sub-project B).
 *
 * `enabled` defaults to **false** so the weekly job is dormant until a
 * deployment opts in.
 *
 * `extractDir` (`TARMOTO_OSM_ROAD_IMPORT_DIR`) is the folder of per-region
 * `<code>.osm` extracts the ingest producer (`refresh-road-extracts`) writes — the
 * SAME shared volume, read here. `null` when unset; the importer skips (nothing
 * to read). The importer reads `<extractDir>/<code>.osm` for each region.
 *
 * `regions` (`TARMOTO_OSM_ROAD_IMPORT_REGIONS`, default all `DEFAULT_REGIONS`)
 * is the coverage list. Each region carries its authoritative bbox, which bounds
 * **stale-by-absence** tombstoning for that region (a re-import may tombstone rows
 * inside the region's bbox that are absent from its extract, never rows outside).
 * Shared with the producer's region env so refresh + import target the same set;
 * an unknown code fails fast rather than being silently dropped.
 *
 * Extract contract: each `<code>.osm` is an `osmium extract -b` output using the
 * default `complete_ways` strategy — boundary-crossing ways are emitted COMPLETE
 * (extending beyond the bbox). The importer's `reconcile()` filters incoming rows
 * to the region bbox (`intersectsRegion`) and tombstones only within it, so a way
 * straddling two adjacent regions is scoped correctly and its shared segment
 * upserts idempotently. (This replaces the old single-file "clip to exactly this
 * rectangle" contract.)
 */
export interface RoadImportConfig {
  enabled: boolean;
  extractDir: string | null;
  regions: PoiImportRegion[];
}

export const osmRoadImportConfig = registerAs(
  "osmRoadImport",
  (): RoadImportConfig => {
    const extractDir = process.env.TARMOTO_OSM_ROAD_IMPORT_DIR?.trim();
    return {
      enabled:
        (process.env.TARMOTO_OSM_ROAD_IMPORT_ENABLED ?? "false")
          .trim()
          .toLowerCase() === "true",
      extractDir: extractDir ? extractDir : null,
      regions: parseRegions(
        process.env.TARMOTO_OSM_ROAD_IMPORT_REGIONS,
        "TARMOTO_OSM_ROAD_IMPORT_REGIONS",
      ),
    };
  },
);
```

- [ ] **Step 2: Write the failing service tests** — edit `apps/backend/src/modules/roads/osm-import/osm-import.service.spec.ts`

Change the `osmConfig` mock object (near line 188) from `{ enabled, filePath, bbox }` to the new shape. Find where `osmConfig` is declared and set it to:

```ts
const osmConfig: {
  enabled: boolean;
  extractDir: string | null;
  regions: PoiImportRegion[];
} = { enabled: true, extractDir: null, regions: [] };
```

Add the import at the top: `import type { PoiImportRegion } from '@tarmoto/ingest';`

Replace the `describe('importFromConfiguredFile', …)` block (lines ~528-560) with `importAll` + `importRegion` coverage. Add these tests (write real extract files into a temp dir):

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A minimal valid <osm> XML extract with one drivable way. `straightWayXml`
// builds a 2-node highway=residential way. (Reuse the module's existing XML
// helpers if present; otherwise inline this.)
function wayXml(id: number): string {
  return (
    `<osm version="0.6">` +
    `<node id="${id}0" lat="50.0" lon="14.0"/>` +
    `<node id="${id}1" lat="50.0" lon="14.01"/>` +
    `<way id="${id}"><nd ref="${id}0"/><nd ref="${id}1"/>` +
    `<tag k="highway" v="residential"/></way></osm>`
  );
}

describe("importRegion", () => {
  let dir: string;
  const CZ: PoiImportRegion = {
    code: "CZ",
    bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "road-import-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips a region whose extract file is absent (no tombstone)", async () => {
    const result = await service.importRegion(CZ, dir);
    expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
    // reconcile never ran → no load/transaction
    expect(loadExisting).not.toHaveBeenCalled();
  });

  it("skips a present-but-empty extract with a warning (no tombstone)", async () => {
    await writeFile(join(dir, "cz.osm"), '<osm version="0.6"></osm>');
    const warn = jest.spyOn(service["logger"], "warn");
    const result = await service.importRegion(CZ, dir);
    expect(result).toEqual({ upserted: 0, carriedOver: 0, deactivated: 0 });
    expect(loadExisting).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("reconciles a non-empty extract scoped to the region bbox", async () => {
    await writeFile(join(dir, "cz.osm"), wayXml(1));
    loadExisting.mockResolvedValue([]); // no existing rows
    const result = await service.importRegion(CZ, dir);
    expect(result.upserted).toBe(1);
    // loadExistingInBbox called with the CZ tuple
    expect(loadExisting).toHaveBeenCalled();
  });
});

describe("importAll", () => {
  it("loops the configured regions and aggregates upserts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "road-import-all-"));
    await writeFile(join(dir, "cz.osm"), wayXml(1));
    await writeFile(join(dir, "sk.osm"), wayXml(2));
    osmConfig.extractDir = dir;
    osmConfig.regions = [
      {
        code: "CZ",
        bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
      },
      {
        code: "SK",
        bbox: { minLng: 16.83, minLat: 47.73, maxLng: 22.57, maxLat: 49.61 },
      },
    ];
    loadExisting.mockResolvedValue([]);
    const result = await service.importAll();
    expect(result.upserted).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when extractDir is unset", async () => {
    osmConfig.extractDir = null;
    await expect(service.importAll()).rejects.toThrow(
      /TARMOTO_OSM_ROAD_IMPORT_DIR/,
    );
  });
});
```

For the existing `importFrom` region tests: any test that set `osmConfig.bbox = [...]` to exercise the region path must now pass the region explicitly, e.g. `await service.importFrom(source, [12, 48, 19, 51])`; no-region tests call `service.importFrom(source)` unchanged (region defaults to null). Update those call sites.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.service`
Expected: FAIL — `importRegion`/`importAll` undefined; config shape mismatch.

- [ ] **Step 4: Implement the service changes** — `apps/backend/src/modules/roads/osm-import/osm-import.service.ts`

Add the imports at the top (after the existing node/typeorm imports):

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { PoiImportRegion } from "@tarmoto/ingest";
```

Add these module-level helpers near the top (after `UPSERT_CHUNK`):

```ts
/** Zero result — a skipped (absent / empty) region contributes nothing. */
const EMPTY_RESULT: OsmImportResult = {
  upserted: 0,
  carriedOver: 0,
  deactivated: 0,
};

/** `PoiImportRegion.bbox` is an object; the reconcile/PostGIS layer uses the
 *  `[minLng, minLat, maxLng, maxLat]` tuple. Convert at the boundary. */
function bboxTuple(
  b: PoiImportRegion["bbox"],
): [number, number, number, number] {
  return [b.minLng, b.minLat, b.maxLng, b.maxLat];
}
```

Replace `importFromConfiguredFile()` (lines 254-270) with `importAll()` + `importRegion()`:

```ts
  /**
   * Import every configured region's `<code>.osm` extract from `extractDir` in
   * one pass (the folder model, Sub-project B). Each region reconciles against
   * its own bbox; results aggregate. A region whose extract is absent or empty is
   * skipped (never tombstoned — see {@link importRegion}), so one missing/broken
   * extract can't wipe a region or abort the others.
   */
  async importAll(): Promise<OsmImportResult> {
    const { extractDir, regions } = this.config;
    if (!extractDir) {
      throw new Error(
        'OSM import is enabled but TARMOTO_OSM_ROAD_IMPORT_DIR is not set',
      );
    }
    this.logger.log(
      `OSM import: ${regions.length} region(s) from ${extractDir} — ` +
        `${regions.map((r) => r.code).join(', ') || '(none)'}`,
    );
    const total: OsmImportResult = { upserted: 0, carriedOver: 0, deactivated: 0 };
    for (const region of regions) {
      const r = await this.importRegion(region, extractDir);
      total.upserted += r.upserted;
      total.carriedOver += r.carriedOver;
      total.deactivated += r.deactivated;
    }
    return total;
  }

  /**
   * Import one region's `<extractDir>/<code>.osm`. Absent file → skip (no
   * authoritative snapshot). Present but 0 ways → skip WITH A WARNING (do not
   * tombstone): a folder-model region is an automated whole-country extract, so
   * an empty result signals a broken refresh, not a genuinely empty country —
   * tombstoning the region on that would be far worse than skipping it for a
   * cycle. (This intentionally overrides `reconcile`'s authoritative-empty
   * behavior, which was designed for hand-supplied single-file tiles.)
   */
  async importRegion(
    region: PoiImportRegion,
    extractDir: string,
  ): Promise<OsmImportResult> {
    const path = join(extractDir, `${region.code.toLowerCase()}.osm`);
    if (!(await this.fileExists(path))) {
      this.logger.warn(
        `OSM import (${region.code}): no extract at ${path} — skipping`,
      );
      return EMPTY_RESULT;
    }
    this.logger.log(`OSM import (${region.code}): reading ${path}`);
    const incoming = await this.bufferRows(
      assembleWays(parseOsmXml(createReadStream(path))),
    );
    if (incoming.length === 0) {
      this.logger.warn(
        `OSM import (${region.code}): extract parsed 0 ways — skipping ` +
          `(treating empty as a broken refresh; NOT tombstoning the region)`,
      );
      return EMPTY_RESULT;
    }
    return this.reconcile(incoming, bboxTuple(region.bbox));
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
```

Replace `importFrom` (lines 272-285) with a version that buffers via the shared helper and takes an explicit region:

```ts
  /** Buffer a way source into reconcilable rows. A parse/read error propagates
   *  before any write, so a failed run can't touch existing rows. */
  private async bufferRows(source: OsmWaySource): Promise<RoadSegmentRow[]> {
    const incoming: RoadSegmentRow[] = [];
    for await (const row of buildSegmentRows(source)) {
      incoming.push(row);
    }
    return incoming;
  }

  /** Import an in-memory way source against an explicit region bbox (or none).
   *  The reconcile seam used by unit tests and by {@link importRegion}. */
  async importFrom(
    source: OsmWaySource,
    region: [number, number, number, number] | null = null,
  ): Promise<OsmImportResult> {
    return this.reconcile(await this.bufferRows(source), region);
  }
```

Change `reconcile` (line 295) to take the region as a parameter instead of reading `this.config.bbox`:

```ts
  private async reconcile(
    rawIncoming: RoadSegmentRow[],
    region: [number, number, number, number] | null,
  ): Promise<OsmImportResult> {
```

Delete line 306 (`const region = this.config.bbox;`) — `region` is now the parameter. The rest of `reconcile` is unchanged (it already uses `region` for the incoming filter, `loadExistingInBbox`, the `region ? plan.stale : []` tombstone gate, and logging).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.service`
Expected: PASS.

- [ ] **Step 6: Gate — build + lint + openapi + grep**

Run: `pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend lint`
Run: `pnpm --filter @tarmoto/backend openapi:gen && git diff --exit-code packages/openapi` (byte-identical → clean)
Run: `rg -n "importFromConfiguredFile|parseBbox|TARMOTO_OSM_ROAD_IMPORT_(FILE|BBOX)|config\.bbox|config\.filePath" apps/backend/src/modules/roads/osm-import/` (expect NOTHING)
Expected: all green / empty.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/roads/osm-import/
git commit -m "feat(backend): folder-model OSM road import (importAll over regions)"
```

---

### Task 4: Wire the processor + decouple quality-conflation to whole-network

**Files:**

- Modify: `apps/backend/src/modules/jobs/processors/osm-import.processor.ts:40` (`importFromConfiguredFile` → `importAll`)
- Modify: `apps/backend/src/modules/jobs/processors/osm-import.processor.spec.ts` (mock `importAll`)
- Modify: `apps/backend/src/modules/roads/quality-conflation/quality-conflation.service.ts` (drop `osmRoadImportConfig`; whole-network)
- Modify: `apps/backend/src/modules/roads/quality-conflation/quality-conflation.service.spec.ts` (drop the `osmRoadImportConfig` provider + bbox assertions)
- Modify: `apps/backend/src/modules/roads/quality-conflation/quality-conflation.config.ts:12,19` (doc: drop `TARMOTO_OSM_ROAD_IMPORT_FILE`/`_BBOX` references)

**Interfaces:**

- Consumes: `OsmImportService.importAll()` (Task 3).
- Produces: no new exports. `QualityConflationService.buildConflation()` signature unchanged (still `Promise<WaySmoothnessAssignment[]>`), now whole-network.

- [ ] **Step 1: Update the processor test** — `apps/backend/src/modules/jobs/processors/osm-import.processor.spec.ts`

Rename every `importFromConfiguredFile` mock/assertion to `importAll` (lines 25-56). The three tests (skip-when-disabled, called-on-enabled, error-propagates) keep their shape; only the method name changes. E.g.:

```ts
const importAll = jest.fn();
// service double: { enabled: true, importAll }
expect(importAll).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Update the quality-conflation test** — `apps/backend/src/modules/roads/quality-conflation/quality-conflation.service.spec.ts`

Remove the `import type { osmRoadImportConfig }` (line 7) and the `type Config` (line 11), and remove the `osmRoadImportConfig.KEY` provider from the test module. Delete/rewrite any test asserting the region-clause SQL (`ST_MakeEnvelope`, "within region"); replace with a whole-network assertion (no bbox params passed to `repo.query`). The remaining conflation tests (assignment mapping, atomic write) are unchanged.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.processor quality-conflation.service`
Expected: FAIL — `importAll` undefined on the double / `osmRoadImportConfig` no longer injected.

- [ ] **Step 4: Wire the processor** — `apps/backend/src/modules/jobs/processors/osm-import.processor.ts`

Line 40: `const result = await this.osmImport.importFromConfiguredFile();` → `const result = await this.osmImport.importAll();`
Update the class doc comment (lines 8-13) to say it imports the configured folder of per-region extracts (not "the configured `.osm` extract"). The `enqueueQualityConflation()` chain (line 43) is unchanged — it still fires once after `importAll` succeeds.

- [ ] **Step 5: Decouple quality-conflation** — `apps/backend/src/modules/roads/quality-conflation/quality-conflation.service.ts`

Remove the `osmRoadImportConfig` import (line 9) and its constructor injection (lines 77-78) — the constructor keeps only the repo + `qualityConflationConfig`:

```ts
  constructor(
    @InjectRepository(RoadSegment)
    private readonly repo: Repository<RoadSegment>,
    @Inject(qualityConflationConfig.KEY)
    private readonly conflationConfig: ConfigType<typeof qualityConflationConfig>,
  ) {}
```

Rewrite `buildConflation()` (lines 159-210) to whole-network — drop the `bbox`/`regionClause`/`params`:

```ts
  async buildConflation(): Promise<WaySmoothnessAssignment[]> {
    // Whole live network. The import now spans multiple regions (Sub-project B),
    // so a single import bbox no longer describes the covered area; the
    // operator-provided conflation INPUT extract bounds which ways actually get
    // tagged, so pulling all scored ways is correct and harmless.
    const sql = `
      SELECT osm_way_id::text AS "osmWayId",
             SUM(quality_score * length_m)
               / NULLIF(SUM(length_m), 0) AS "representativeQuality",
             COUNT(*)::int AS "segmentCount"
      FROM road_segments
      WHERE deactivated_at IS NULL
        AND osm_way_id IS NOT NULL
        AND quality_score IS NOT NULL
      GROUP BY osm_way_id
      ORDER BY osm_way_id
    `;
    const rows: WayQualityRow[] = await this.repo.query(sql);

    const assignments: WaySmoothnessAssignment[] = [];
    for (const row of rows) {
      const smoothness = qualityScoreToSmoothness(row.representativeQuality);
      if (!smoothness) continue;
      assignments.push({
        osmWayId: row.osmWayId,
        smoothness,
        representativeQuality: row.representativeQuality,
        segmentCount: row.segmentCount,
      });
    }
    this.logger.log(
      `Quality conflation: ${assignments.length} way(s) tagged (whole network)`,
    );
    return assignments;
  }
```

Update the class doc comment's "Region-bounding" paragraph (lines 62-65) to state conflation always covers the whole live network (the region knob was removed with the folder model).

- [ ] **Step 6: Update the conflation config doc** — `apps/backend/src/modules/roads/quality-conflation/quality-conflation.config.ts`

Lines 12 + 19: remove the `TARMOTO_OSM_ROAD_IMPORT_FILE` / `TARMOTO_OSM_ROAD_IMPORT_BBOX` references. Reword the `inputFilePath` doc to say it's the extract to tag (typically one of the folder's `<code>.osm` files or a merged extract), and delete the "reuses `TARMOTO_OSM_ROAD_IMPORT_BBOX`" sentence — conflation is whole-network now.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.processor quality-conflation`
Expected: PASS.

- [ ] **Step 8: Gate — build + lint + openapi + grep**

Run: `pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend lint`
Run: `pnpm --filter @tarmoto/backend openapi:gen && git diff --exit-code packages/openapi`
Run: `rg -n "importFromConfiguredFile|osmRoadImportConfig" apps/backend/src/modules/roads/quality-conflation/ apps/backend/src/modules/jobs/` (expect NOTHING — conflation no longer imports the road config; the processor calls importAll)
Expected: green / empty.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/modules/jobs apps/backend/src/modules/roads/quality-conflation
git commit -m "feat(backend): road import processor uses importAll; conflation goes whole-network"
```

---

### Task 5: Env docs, Dockerfiles, docker-compose, runbook + architecture

**Files:**

- Modify: `apps/ingest/.env.example` (add producer keys)
- Modify: `apps/backend/.env.example` (add importer keys)
- Modify: `apps/ingest/Dockerfile` (road extract dir ARG/ENV + documented refresh command)
- Modify: `infra/docker/docker-compose.yml` (road extract volume/env, mirroring POI)
- Modify: `docs/process/runbook.md` (road-refresh scheduled-task section)
- Modify: `docs/reference/` architecture doc (folder-model road import)
- Modify: `apps/backend/src/modules/roads/osm-import/README.md` (folder model + complete_ways contract)

**Interfaces:** none (docs/config only).

This task follows the POI OSM refresh's existing entries as the template — for each POI extract key/section below, add the road analogue. No new patterns.

- [ ] **Step 1: Ingest `.env.example`** — mirror the `TARMOTO_OSM_POI_*` block (lines ~69-80) with a road block:

```bash
# --- OSM road-quality extract refresh (Sub-project B) — producer only ---
# The backend reads these extracts; only the DIR + REGIONS are shared with it.
TARMOTO_OSM_ROAD_REFRESH_ENABLED=false
# MUST differ from TARMOTO_OSM_POI_IMPORT_DIR (both write <code>.osm).
TARMOTO_OSM_ROAD_IMPORT_DIR=/data/road-extracts
TARMOTO_OSM_ROAD_IMPORT_REGIONS=
```

- [ ] **Step 2: Backend `.env.example`** — add the importer keys (the road import runs in the backend):

```bash
# --- OSM road import (folder model, Sub-project B) ---
TARMOTO_OSM_ROAD_IMPORT_ENABLED=false
# Shared volume of per-region <code>.osm extracts the ingest producer writes.
TARMOTO_OSM_ROAD_IMPORT_DIR=/data/road-extracts
TARMOTO_OSM_ROAD_IMPORT_REGIONS=
```

- [ ] **Step 3: Ingest Dockerfile** — add a road extract dir ARG/ENV next to the POI extract ones, and add a documented refresh command comment next to the POI/FSQ refresh command lines, e.g.:

```dockerfile
# Road (weekly, staggered from the POI OSM refresh):
#   node apps/ingest/dist/scripts/refresh-road-extracts.js
```

Add `ARG TARMOTO_OSM_ROAD_IMPORT_DIR=/data/road-extracts` + the matching `ENV` mirroring the POI extract dir ARG/ENV.

- [ ] **Step 4: docker-compose** — mirror the POI extract volume/env wiring for the road extract dir so both the ingest and backend services see `/data/road-extracts`.

- [ ] **Step 5: Runbook** — add a "Road-quality extract refresh (Sub-project B)" section mirroring the POI OSM refresh section: the `road:refresh` scheduled `docker exec` (weekly, staggered), the shared-dir requirement (distinct from POI), and the enablement order (set DIR+REGIONS on both apps → add the ingest refresh task + `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true` → flip `TARMOTO_OSM_ROAD_IMPORT_ENABLED=true`).

- [ ] **Step 6: Architecture reference + module README** — note that OSM road import is now a folder model (per-region `<code>.osm`, producer in ingest, importer loops regions), and rewrite the osm-import README's single-file/exact-clip description to the folder + `complete_ways` contract.

- [ ] **Step 7: Gate — grep for every retired token repo-wide**

Run: `rg -n "TARMOTO_OSM_ROAD_IMPORT_FILE|TARMOTO_OSM_ROAD_IMPORT_BBOX|TARMOTO_OSM_IMPORT_FILE|TARMOTO_OSM_IMPORT_BBOX" -g '!docs/superpowers/**'`
Expected: NOTHING (all retired).
Run: `rg -n "TARMOTO_OSM_ROAD_REFRESH_ENABLED|TARMOTO_OSM_ROAD_IMPORT_DIR|TARMOTO_OSM_ROAD_IMPORT_REGIONS" apps/ingest/.env.example apps/backend/.env.example`
Expected: present in both.
Run: `pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/ingest-service build`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/ingest/.env.example apps/backend/.env.example apps/ingest/Dockerfile infra/docker/docker-compose.yml docs apps/backend/src/modules/roads/osm-import/README.md
git commit -m "docs(cross): document the OSM road folder-model import + extract refresh"
```

---

## Notes for the executor

- **Package names:** shared package = `@tarmoto/ingest` (`packages/ingest`); ingest app = `@tarmoto/ingest-service` (`apps/ingest`) — verify the app name from `apps/ingest/package.json` before running its Jest filter. Backend = `@tarmoto/backend`.
- **`reconcile` is already tile-aware** — do NOT rewrite its body; only parameterize `region` and delete the `const region = this.config.bbox` line. Its `intersectsRegion` incoming-filter + per-bbox tombstoning already implement the folder model's per-region scoping and border-way idempotency.
- **The empty-extract guard lives in `importRegion`** (before `reconcile`), and intentionally departs from `reconcile`'s authoritative-empty tombstone. Keep both: `reconcile`'s branch stays for its direct-source callers/tests; the guard governs the folder path.
- **No `openapi` drift** is expected in any task — if `git diff packages/openapi` is non-empty after `openapi:gen`, something leaked into a DTO/contract; stop and investigate.
