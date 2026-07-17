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
