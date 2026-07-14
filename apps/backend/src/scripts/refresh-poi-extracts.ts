/**
 * Automated OSM extract refresh (#976) — the "fetch" half of the offline POI
 * pipeline. Runs in a scheduled osmium+node container (see
 * `apps/backend/Dockerfile.poi-refresh`), SEPARATE from the backend runtime so
 * osmium + multi-GB PBF handling never bloat the app image. For each configured
 * region it downloads the Geofabrik country PBF, `osmium tags-filter`s it to the
 * §7 POI tag set, `osmium extract -b`s it to the region's `DEFAULT_REGIONS`
 * bbox, and ATOMICALLY writes `<code>.osm` to `TARMOTO_POI_IMPORT_DIR` — the same
 * shared volume the weekly import cron reads, so the store then mirrors CURRENT
 * data instead of re-importing a static file.
 *
 * Guarantees:
 *  - **Atomic, keep-last-good:** the extract is built at a sibling `.part` file
 *    and only renamed onto `<code>.osm` after ALL steps succeed. A failure at
 *    any step (download/filter/clip) leaves the previous good extract untouched
 *    — never a truncated file — and the run continues to the next region.
 *  - **Observable:** a partial failure exits non-zero (a scheduled run must not
 *    report green when a region didn't refresh); every region's outcome is
 *    logged.
 *  - **Bounded disk:** regions are processed sequentially and each region's
 *    multi-GB intermediates are removed before the next, so peak disk is one
 *    country's PBF + its filtered copy, not all 17 at once.
 *  - **Env-gated:** a no-op unless `TARMOTO_POI_REFRESH_ENABLED=true`.
 *
 * FSQ (OS Places) is out of scope — a token-gated DuckDB/Iceberg pull, tracked
 * separately.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import type { PoiImportRegion } from '../modules/poi/poi-import.config.js';
import {
  bboxArg,
  geofabrikUrl,
  POI_TAGS_FILTER_EXPRESSIONS,
  resolvePoiRefreshConfig,
  type PoiRefreshConfig,
} from '../modules/poi/poi-refresh.config.js';

const execFileAsync = promisify(execFile);

/**
 * Suffix for the refresh's atomic temp files — **distinct** from the admin
 * upload's plain `.part` (`storeExtract`) so the startup sweep can remove OUR
 * orphans (from a killed/restarted run) without ever touching an in-progress
 * upload's temp on the same shared volume (#976 review).
 */
const REFRESH_TMP_SUFFIX = '.refresh.part';

/**
 * A refresh temp older than this is treated as an orphan from a killed run and
 * reclaimed; a younger one is left alone because it may be a **concurrent** run
 * still writing it — removing that would make its `rename` fail and report the
 * region stale even though osmium succeeded (#976 review). Runs are weekly and
 * an extract write takes seconds–minutes, so this cleanly separates the two.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Injectable I/O seams so the orchestration is unit-testable without a network
 *  or a real `osmium` binary. */
export interface RefreshDeps {
  /** Download `url` to `dest`, streaming (multi-GB PBFs must never buffer). */
  download: (url: string, dest: string) => Promise<void>;
  /** Run `osmium` with array args (no shell); reject on non-zero exit. */
  osmium: (args: readonly string[]) => Promise<void>;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    throw new Error(
      `download failed (${res.status} ${res.statusText}) for ${url}`,
    );
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function runOsmium(args: readonly string[]): Promise<void> {
  // osmium writes to its `-o` file, so stdout/stderr stay small; the generous
  // maxBuffer only guards against verbose progress on a huge input.
  await execFileAsync('osmium', [...args], { maxBuffer: 64 * 1024 * 1024 });
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
  const filtered = join(workDir, `${region.code}-poi.osm.pbf`);
  const finalOut = join(targetDir, `${region.code.toLowerCase()}.osm`);
  // Unique per run so a re-run (or a crashed prior run) can't collide, and the
  // live `<code>.osm` is only ever touched by the final atomic rename. The
  // `.refresh.part` marker lets `sweepStaleTempFiles` reclaim an orphan from a
  // killed run without touching an admin upload's plain `.part`.
  const tmpOut = `${finalOut}.${process.pid}.${randomBytes(6).toString('hex')}${REFRESH_TMP_SUFFIX}`;

  try {
    await deps.download(url, pbf);
    await deps.osmium([
      'tags-filter',
      pbf,
      ...POI_TAGS_FILTER_EXPRESSIONS,
      '-o',
      filtered,
      '--overwrite',
    ]);
    await deps.osmium([
      'extract',
      '-b',
      bboxArg(region.bbox),
      filtered,
      // Write OSM XML explicitly. osmium otherwise autodetects the output format
      // from the filename suffix, and our atomic temp name ends in `.part` (not
      // `.osm`) — which osmium can't detect ("Could not detect file format"), so
      // without this the extract fails for every region (#976 review).
      '-f',
      'osm',
      '-o',
      tmpOut,
      '--overwrite',
    ]);
    await rename(tmpOut, finalOut);
  } finally {
    await Promise.all([
      rm(pbf, { force: true }),
      rm(filtered, { force: true }),
      // Present only if we threw before the rename above.
      rm(tmpOut, { force: true }),
    ]);
  }
}

export interface RefreshSummary {
  ok: string[];
  failed: { code: string; error: string }[];
}

/**
 * Reclaim stale refresh temp files (`*.refresh.part`) orphaned by a killed or
 * restarted run — with a fresh random name each run they would otherwise
 * accumulate on the persistent shared volume and eventually fill it (#976
 * review). Guards on TWO things so it only ever removes a genuine orphan:
 *  - suffix — only OUR `.refresh.part`, never an in-progress admin upload's
 *    plain `.part` (`storeExtract`) on the same volume;
 *  - age — only files not touched for `STALE_TEMP_AGE_MS`, so a **concurrent**
 *    refresh's still-being-written temp is never removed out from under it.
 * Best-effort per file (a raced-away or unstattable entry is skipped).
 */
async function sweepStaleTempFiles(
  dir: string,
  log: (msg: string) => void,
): Promise<void> {
  const now = Date.now();
  const candidates = (await readdir(dir)).filter((name) =>
    name.endsWith(REFRESH_TMP_SUFFIX),
  );
  let swept = 0;
  for (const name of candidates) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < STALE_TEMP_AGE_MS) continue; // recent — leave it
      await rm(path, { force: true });
      swept += 1;
    } catch {
      // Vanished (a concurrent run cleaned it) or unstattable — skip.
    }
  }
  if (swept > 0) {
    log(`POI refresh: swept ${swept} stale temp file(s) from ${dir}`);
  }
}

/**
 * Refresh every region in `config`, isolating failures: one region's
 * download/filter error is logged and recorded, and the loop moves on (its live
 * extract stays as-is). Returns the per-region outcome for the caller to surface.
 */
export async function refreshAll(
  config: PoiRefreshConfig,
  workDir: string,
  deps: RefreshDeps,
  log: (msg: string) => void = console.log,
): Promise<RefreshSummary> {
  if (config.targetDir === null) {
    throw new Error(
      'TARMOTO_POI_IMPORT_DIR is not set — nowhere to write refreshed extracts',
    );
  }
  // Reclaim orphans from a previously killed run before writing new temps.
  await sweepStaleTempFiles(config.targetDir, log);
  const summary: RefreshSummary = { ok: [], failed: [] };
  log(
    `POI refresh: ${config.regions.length} region(s) — ` +
      `${config.regions.map((r) => r.code).join(', ') || '(none)'}`,
  );
  for (const region of config.regions) {
    try {
      log(`POI refresh (${region.code}): download → filter → clip…`);
      await refreshRegion(region, config.targetDir, workDir, deps);
      summary.ok.push(region.code);
      log(
        `POI refresh (${region.code}): wrote ${region.code.toLowerCase()}.osm`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.failed.push({ code: region.code, error });
      log(
        `POI refresh (${region.code}): FAILED — ${error} ` +
          `(kept the previous extract)`,
      );
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const config = resolvePoiRefreshConfig();
  if (!config.enabled) {
    console.log(
      'POI refresh: TARMOTO_POI_REFRESH_ENABLED is not true — skipping.',
    );
    return;
  }
  const workDir = join(tmpdir(), `poi-refresh-${process.pid}`);
  await mkdir(workDir, { recursive: true });
  try {
    const { ok, failed } = await refreshAll(config, workDir, {
      download: downloadToFile,
      osmium: runOsmium,
    });
    console.log(`POI refresh done: ${ok.length} ok, ${failed.length} failed.`);
    if (failed.length > 0) {
      // A partial failure must not report green — the scheduler should alert.
      process.exitCode = 1;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Run as a CLI only (not when imported by the spec).
if (process.argv[1]?.endsWith('refresh-poi-extracts.js')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
