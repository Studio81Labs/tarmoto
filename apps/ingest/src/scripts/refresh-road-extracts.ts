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
 * that tile's PADDED bbox (`paddedTileBbox`, `TILE_EXTRACT_PAD_DEG` — default
 * `complete_ways` keeps boundary-crossing ways whole, but a way whose nodes
 * sit just outside the tile still needs the pad to be selected at all) and
 * writes `roadTileFileName(tile, tileSpanDeg)` to `TARMOTO_OSM_ROAD_IMPORT_DIR`
 * — the shared volume the backend `road.import` cron reads. The backend still
 * reconciles to the EXACT tile bbox, so the padded overhang is dropped there,
 * never double-counted. Tiling bounds one
 * extract's road count (and, in the importer, its node map) regardless of the
 * region's overall size — a whole-country extract could otherwise OOM the
 * import worker.
 *
 * Guarantees mirror `refresh-poi-extracts`, extended across a region's whole
 * tile set: every tile is extracted to a `.part` sibling first, and the batch
 * is only published (renamed onto its final `roadTileFileName`s) after ALL of
 * the region's tiles clip cleanly — so a partial failure keeps the region's
 * ENTIRE previous snapshot, never a mix of fresh and stale tiles (see
 * `refreshRegion`). A partial failure exits non-zero, disk is bounded
 * (sequential regions), and the whole script is env-gated on
 * `TARMOTO_OSM_ROAD_REFRESH_ENABLED`.
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
  paddedTileBbox,
  roadTileFileName,
  ROAD_TAGS_FILTER_EXPRESSIONS,
  resolveRoadRefreshConfig,
  subdivideRegion,
  TILE_EXTRACT_PAD_DEG,
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
 * regions computes each region's grid exactly once. `spanDeg` is threaded
 * through separately (rather than re-derived from `tiles`) because
 * {@link roadTileFileName} needs it too — it encodes the grid identity into
 * the filename so a retuned span never collides with a stale-grid file of the
 * same row/col (see the doc comment on `roadTileFileName`).
 *
 * Each tile's `osmium extract -b` clips a PADDED bbox (`paddedTileBbox`,
 * {@link TILE_EXTRACT_PAD_DEG}) — `complete_ways` only selects a way that has
 * at least one NODE inside the clip bbox, so a way crossing the tile whose
 * nearby nodes sit just outside the exact tile would otherwise be silently
 * dropped from this tile's extract. The output filename and "which tile"
 * stay the EXACT tile (`roadTileFileName(tile, spanDeg)`); the backend
 * importer reconciles to the exact tile bbox too, so the padded overhang is
 * filtered out on that side and never double-counted — the pad only prevents
 * node-less-crossing holes.
 *
 * Publishes the region atomically-ish, in two phases:
 *  1. **Extract** — every tile is clipped to a unique sibling `.part` file;
 *     none are published yet.
 *  2. **Publish** — only once ALL tiles have clipped successfully, every
 *     `.part` is renamed onto its `roadTileFileName` in a tight loop.
 * A failure anywhere in phase 1 (the common case — one bad/oversized tile)
 * throws before any rename runs, so `finally` removes every accumulated
 * `.part` and the region's previous final tiles are left completely
 * untouched — never a mix of fresh and stale tiles from the same run. That
 * mix mattered because the importer treats each tile file as authoritative:
 * a way crossing a tile seam could be tombstoned by the fresh tile and
 * reinserted from the stale tile with a new id, corrupting segment identity.
 * The residual risk is a process crash *during* the phase-2 rename loop:
 * each `rename` is atomic per file, but the batch itself isn't transactional,
 * so a hard kill between two renames could still leave a partial publish.
 * That window is far smaller than an extract failure (now fully safe), and
 * closing it too would need a per-region manifest or directory swap — a
 * possible future hardening, not built here. Always cleans up the (multi-GB)
 * intermediates and any leftover `.part`s.
 */
export async function refreshRegion(
  region: PoiImportRegion,
  targetDir: string,
  routingDir: string | null,
  workDir: string,
  tiles: readonly RoadTile[],
  spanDeg: number,
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
    // Phase 1 — extract every output to its `.part` sibling; publish NONE yet.
    const parts: { tmpOut: string; finalOut: string }[] = [];
    // The whole-network drivable ROUTING extract (`<code>.osm`) that GraphHopper
    // imports and the quality conflation tags — from the SAME `filtered` PBF,
    // before tiling, so it's drivable-sized and nearly free. Published atomically
    // with the tiles below (all of the region's outputs, or none). Skipped when
    // no routing dir is configured.
    if (routingDir !== null) {
      const finalOut = join(routingDir, `${region.code.toLowerCase()}.osm`);
      const tmpOut = refreshTmpPath(finalOut);
      tmpPaths.push(tmpOut);
      await deps.osmium([
        "cat",
        filtered,
        "-f",
        "osm",
        "-o",
        tmpOut,
        "--overwrite",
      ]);
      parts.push({ tmpOut, finalOut });
    }
    for (const tile of tiles) {
      const finalOut = join(targetDir, roadTileFileName(tile, spanDeg));
      const tmpOut = refreshTmpPath(finalOut);
      tmpPaths.push(tmpOut);
      await deps.osmium([
        "extract",
        "-b",
        // PADDED clip (see the doc comment above) — the exact tile bbox stays
        // the filename + reconcile scope; only the osmium selection grows.
        bboxArg(paddedTileBbox(tile.bbox, TILE_EXTRACT_PAD_DEG)),
        filtered,
        // Write OSM XML explicitly — osmium can't detect the format from our `.part`
        // temp suffix, so without `-f osm` the extract fails for every tile.
        "-f",
        "osm",
        "-o",
        tmpOut,
        "--overwrite",
      ]);
      parts.push({ tmpOut, finalOut });
    }
    // Phase 2 — every tile in the region clipped cleanly; publish the whole
    // batch now. See the doc comment above for the residual mid-loop-crash
    // window this leaves.
    for (const { tmpOut, finalOut } of parts) {
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
 * logged and recorded, and the loop moves on. `refreshRegion` now publishes a
 * region's tiles atomically (all tiles or none), so a failed region's
 * previous tile extracts are left completely intact — never a mix of fresh
 * and stale tiles.
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
  if (config.routingDir !== null) {
    // The routing extract lands in its own dir (GraphHopper import + conflation
    // input) — create it if a fresh volume hasn't, and sweep any stale `.part`s.
    await mkdir(config.routingDir, { recursive: true });
    await sweepStaleTempFiles(config.routingDir, log);
  }
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
      const routingNote =
        config.routingDir !== null ? " + 1 routing extract" : "";
      log(
        `road refresh (${region.code}): download → filter once → clip ${tiles.length} tile(s)${routingNote}…`,
      );
      await refreshRegion(
        region,
        config.targetDir,
        config.routingDir,
        workDir,
        tiles,
        config.tileSpanDeg,
        deps,
      );
      summary.ok.push(region.code);
      log(
        `road refresh (${region.code}): wrote ${tiles.length} tile file(s)${routingNote}`,
      );
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
