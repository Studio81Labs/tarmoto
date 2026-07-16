/**
 * Shared machinery for the offline extract-refresh scripts (#976). The OSM
 * (osmium, `refresh-poi-extracts`) and FSQ (duckdb, `refresh-fsq-extracts`)
 * extractors both write per-region files ATOMICALLY to a shared import volume,
 * so they share the atomic-temp naming, the startup orphan sweep, and the
 * exec-error surfacing.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Per-region outcome of a refresh run (shared by the OSM and FSQ extractors):
 * which regions wrote a fresh extract and which failed (keeping their previous
 * one). A non-empty `failed` makes the run exit non-zero so a scheduled task
 * doesn't report green when a region didn't refresh.
 */
export interface RefreshSummary {
  ok: string[];
  failed: { code: string; error: string }[];
}

/**
 * Suffix for a refresh's atomic temp files — **distinct** from the admin
 * upload's plain `.part` (`storeExtract`) so the startup sweep removes OUR
 * orphans (from a killed/restarted run) without ever touching an in-progress
 * upload's temp on the same shared volume (#976 review).
 */
export const REFRESH_TMP_SUFFIX = ".refresh.part";

/**
 * A refresh temp older than this is treated as an orphan from a killed run and
 * reclaimed; a younger one is left alone because it may be a **concurrent** run
 * still writing it — removing that would make its `rename` fail and report the
 * region stale even though the tool succeeded (#976 review). Runs are weekly /
 * monthly and a write takes seconds–minutes, so this cleanly separates the two.
 */
export const STALE_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * A unique sibling temp path for `finalOut` — the live file is only ever touched
 * by the final atomic rename, and the `.refresh.part` marker lets the sweep
 * reclaim an orphan from a killed run without touching an admin upload's plain
 * `.part`.
 */
export function refreshTmpPath(finalOut: string): string {
  return `${finalOut}.${process.pid}.${randomBytes(6).toString("hex")}${REFRESH_TMP_SUFFIX}`;
}

/**
 * Turn node's opaque `execFile` rejection ("Command failed: <tool> …") into a
 * diagnosable message: a `signal` names an OOM kill (`SIGKILL`) vs the tool's own
 * error exit, and `stderr` carries the tool's actual complaint (#976 ops).
 */
export function describeExecError(label: string, err: unknown): string {
  const e = err as {
    code?: number;
    signal?: NodeJS.Signals | null;
    stderr?: string | Buffer;
  };
  const how = e.signal
    ? `killed by ${e.signal}${e.signal === "SIGKILL" ? " (out of memory?)" : ""}`
    : `exit ${e.code ?? "?"}`;
  const stderr = String(e.stderr ?? "").trim();
  return `${label} ${how}${stderr ? `: ${stderr.slice(-2000)}` : ""}`;
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
export async function sweepStaleTempFiles(
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
    log(`refresh: swept ${swept} stale temp file(s) from ${dir}`);
  }
}
