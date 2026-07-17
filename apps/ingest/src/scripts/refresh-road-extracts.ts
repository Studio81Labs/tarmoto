/**
 * Automated OSM road-extract refresh (#781, Sub-project B; sub-region tiling
 * follow-up) — the "fetch" half of the offline road-quality pipeline, the road
 * analogue of `refresh-poi-extracts`. Runs via a scheduled Coolify `docker exec`
 * into the already-running `apps/ingest` container, SEPARATE from the backend
 * runtime so osmium + multi-GB PBF handling never bloat the app image. For each
 * configured region it downloads the Geofabrik country PBF and `osmium
 * tags-filter`s it to the drivable-highway set (`ROAD_TAGS_FILTER_EXPRESSIONS`)
 * ONCE, then for each tile of `subdivideRegion(region, tileSpanDeg)`
 * (`TARMOTO_OSM_ROAD_TILE_SPAN_DEG`) `osmium extract -b`s the filtered PBF to
 * that tile's bbox (default `complete_ways` — boundary-crossing ways stay
 * whole) and ATOMICALLY writes `roadTileFileName(tile)` to
 * `TARMOTO_OSM_ROAD_IMPORT_DIR` — the shared volume the backend `road.import`
 * cron reads. Tiling bounds one extract's road count (and, in the importer, its
 * node map) regardless of the region's overall size — a whole-country extract
 * could otherwise OOM the import worker.
 *
 * Guarantees mirror `refresh-poi-extracts`: atomic keep-last-good (`.part` then
 * rename, now per tile), a partial failure exits non-zero, bounded disk
 * (sequential regions), env-gated on `TARMOTO_OSM_ROAD_REFRESH_ENABLED`.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PoiImportRegion, RoadTile } from "@tarmoto/ingest";
import {
  bboxArg,
  geofabrikUrl,
  roadTileFileName,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  resolveRoadRefreshConfig,
  subdivideRegion,
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
 * Refresh one region end-to-end: download once, `osmium tags-filter` the PBF to
 * the drivable-highway set ONCE, then reuse that filtered PBF to `osmium
 * extract -b` ONE bounded output per tile in `tiles` — bounding both this
 * step's and (Part 2) the importer's per-extract memory regardless of the
 * region's overall size. `tiles` is the caller's `subdivideRegion(region,
 * spanDeg)` result — computed by the caller (not here) so a caller looping
 * regions computes each region's grid exactly once. Each tile is built at a
 * unique sibling `.part` file and only renamed onto its `roadTileFileName`
 * after that tile's clip succeeds, so a failure never truncates an already-live
 * tile extract (tiles written before a later tile's failure keep their fresh
 * copy; the failed tile and any not yet reached keep their previous one).
 * Always cleans up the (multi-GB) intermediates and any leftover `.part`s.
 */
export async function refreshRegion(
  region: PoiImportRegion,
  targetDir: string,
  workDir: string,
  tiles: readonly RoadTile[],
  deps: RefreshDeps,
): Promise<void> {
  const url = geofabrikUrl(region.code);
  if (url === null) {
    throw new Error(`no Geofabrik slug configured for ${region.code}`);
  }
  const pbf = join(workDir, `${region.code}-latest.osm.pbf`);
  const filtered = join(workDir, `${region.code}-road.osm.pbf`);
  const tmpPaths: string[] = [];

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
    for (const tile of tiles) {
      const finalOut = join(targetDir, roadTileFileName(tile));
      const tmpOut = refreshTmpPath(finalOut);
      tmpPaths.push(tmpOut);
      await deps.osmium([
        "extract",
        "-b",
        bboxArg(tile.bbox),
        filtered,
        // Write OSM XML explicitly — osmium can't detect the format from our `.part`
        // temp suffix, so without `-f osm` the extract fails for every tile.
        "-f",
        "osm",
        "-o",
        tmpOut,
        "--overwrite",
      ]);
      await rename(tmpOut, finalOut);
    }
  } finally {
    await Promise.all([
      rm(pbf, { force: true }),
      rm(filtered, { force: true }),
      ...tmpPaths.map((p) => rm(p, { force: true })),
    ]);
  }
}

/**
 * Refresh every region in `config`, isolating failures: one region's error is
 * logged and recorded, and the loop moves on (its live tile extracts stay
 * as-is — a partially-refreshed region may mix fresh and previous tiles if a
 * later tile in its loop failed).
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
      `${config.regions.map((r) => r.code).join(", ") || "(none)"} ` +
      `(tile span ${config.tileSpanDeg}°)`,
  );
  for (const region of config.regions) {
    // Computed ONCE per region and reused for both the tile-count logging and
    // the actual refresh below (not recomputed inside refreshRegion).
    const tiles = subdivideRegion(region, config.tileSpanDeg);
    try {
      log(
        `road refresh (${region.code}): download → filter once → clip ${tiles.length} tile(s)…`,
      );
      await refreshRegion(region, config.targetDir, workDir, tiles, deps);
      summary.ok.push(region.code);
      log(`road refresh (${region.code}): wrote ${tiles.length} tile file(s)`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.failed.push({ code: region.code, error });
      log(
        `road refresh (${region.code}): FAILED — ${error} (kept previous tile extracts)`,
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
