/**
 * Automated FSQ (Foursquare OS Places) extract refresh (#976) — the DuckDB
 * "fetch" half of the offline POI pipeline, the sibling of
 * `refresh-poi-extracts` (osmium). Runs in the SAME scheduled `apps/ingest`
 * container (see the runbook; the retired standalone
 * `apps/backend/Dockerfile.poi-refresh` one-shot container's osmium/duckdb role
 * is folded into this image). For each configured region it runs a
 * DuckDB script that attaches Foursquare's OS Places Iceberg catalog with the
 * operator's token, filters to the region's country + `DEFAULT_REGIONS` bbox +
 * POI categories, and ATOMICALLY writes `<code>.fsq.jsonl` to
 * `TARMOTO_FSQ_POI_IMPORT_DIR` — the same shared volume the import cron reads, so the
 * store mirrors the CURRENT monthly OS Places drop instead of a static file.
 *
 * Guarantees mirror the OSM refresh (see that file):
 *  - **Atomic, keep-last-good:** DuckDB COPYs to a sibling `.refresh.part` file
 *    that is only renamed onto `<code>.fsq.jsonl` after DuckDB exits 0; any
 *    failure leaves the previous good extract untouched, and the run continues.
 *  - **Observable:** a partial failure exits non-zero; every region is logged.
 *  - **Env-gated:** a no-op unless `TARMOTO_FSQ_POI_REFRESH_ENABLED=true`.
 *
 * Credential boundary: the FSQ token (`TARMOTO_FSQ_POI_TOKEN`) lives ONLY in this
 * container and is fed to DuckDB on STDIN (never argv), so it never reaches the
 * backend/worker — they read only the credential-free `.fsq.jsonl` files. FSQ's
 * refresh cadence is monthly (the token + the OS Places drop are), so it runs on
 * its own schedule, separate from the weekly OSM one.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { PoiImportRegion } from "@tarmoto/ingest";
import {
  buildFsqExtractSql,
  resolveFsqRefreshConfig,
  type FsqRefreshConfig,
} from "@tarmoto/ingest";
import {
  describeExecError,
  refreshTmpPath,
  sweepStaleTempFiles,
  type RefreshSummary,
} from "./refresh-common.js";

/** Injectable seam so the orchestration is unit-testable without a real `duckdb`
 *  binary or the remote catalog. */
export interface FsqRefreshDeps {
  /** Run a DuckDB script (SQL text). The COPY inside it writes the extract file;
   *  reject on a non-zero exit. */
  duckdb: (sql: string) => Promise<void>;
}

/**
 * Run `duckdb` with `sql` piped to STDIN — never argv, because the SQL embeds
 * the FSQ token, which must not leak into the process arg list. Rejects with a
 * diagnosable message (exit code / OOM signal / duckdb stderr) on failure.
 */
function runDuckdb(sql: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `-init /dev/null` skips any user `.duckdbrc`; reading SQL from a pipe is
    // inherently non-interactive. No database file → a transient in-memory
    // session, all the COPY needs.
    const child = spawn("duckdb", ["-init", "/dev/null"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const { stdin, stderr: stderrStream } = child;
    if (!stdin || !stderrStream) {
      reject(new Error("duckdb: failed to open stdin/stderr pipes"));
      return;
    }
    let stderr = "";
    stderrStream.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      // Failed to spawn (e.g. duckdb not on PATH).
      reject(
        new Error(`duckdb failed to start: ${err.message}`, { cause: err }),
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          describeExecError("duckdb", {
            code: code ?? undefined,
            signal,
            stderr,
          }),
        ),
      );
    });
    // If duckdb dies before draining stdin, the write end errors (EPIPE); the
    // `close`/`error` handlers already carry the real reason, so ignore it here.
    stdin.on("error", () => undefined);
    stdin.end(sql);
  });
}

/**
 * Refresh one region end-to-end. DuckDB COPYs to a unique sibling `.refresh.part`
 * file (the SQL's `TO` target) and it is only renamed onto `<code>.fsq.jsonl`
 * after DuckDB exits 0, so a failure never truncates the live extract. Always
 * cleans up any leftover `.part`.
 */
export async function refreshRegion(
  region: PoiImportRegion,
  targetDir: string,
  workDir: string,
  token: string,
  deps: FsqRefreshDeps,
): Promise<void> {
  const finalOut = join(targetDir, `${region.code.toLowerCase()}.fsq.jsonl`);
  const tmpOut = refreshTmpPath(finalOut);
  const sql = buildFsqExtractSql({
    token,
    region,
    outPath: tmpOut,
    tempDir: workDir,
  });
  try {
    await deps.duckdb(sql);
    await rename(tmpOut, finalOut);
  } finally {
    // Present only if we threw before the rename above (or DuckDB wrote a
    // partial file before erroring).
    await rm(tmpOut, { force: true });
  }
}

/**
 * Refresh every region in `config`, isolating failures: one region's query error
 * is logged and recorded, and the loop moves on (its live extract stays as-is).
 * Returns the per-region outcome for the caller to surface.
 */
export async function refreshAll(
  config: FsqRefreshConfig,
  workDir: string,
  deps: FsqRefreshDeps,
  log: (msg: string) => void = console.log,
): Promise<RefreshSummary> {
  if (config.targetDir === null) {
    throw new Error(
      "TARMOTO_FSQ_POI_IMPORT_DIR is not set — nowhere to write refreshed extracts",
    );
  }
  if (config.token === null) {
    throw new Error(
      "TARMOTO_FSQ_POI_TOKEN is not set — cannot authenticate to the OS Places catalog",
    );
  }
  // Reclaim orphans from a previously killed run before writing new temps.
  await sweepStaleTempFiles(config.targetDir, log);
  const summary: RefreshSummary = { ok: [], failed: [] };
  log(
    `FSQ refresh: ${config.regions.length} region(s) — ` +
      `${config.regions.map((r) => r.code).join(", ") || "(none)"}`,
  );
  for (const region of config.regions) {
    try {
      log(`FSQ refresh (${region.code}): querying OS Places…`);
      await refreshRegion(
        region,
        config.targetDir,
        workDir,
        config.token,
        deps,
      );
      summary.ok.push(region.code);
      log(
        `FSQ refresh (${region.code}): wrote ${region.code.toLowerCase()}.fsq.jsonl`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.failed.push({ code: region.code, error });
      log(
        `FSQ refresh (${region.code}): FAILED — ${error} ` +
          `(kept the previous extract)`,
      );
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const config = resolveFsqRefreshConfig();
  if (!config.enabled) {
    console.log(
      "FSQ refresh: TARMOTO_FSQ_POI_REFRESH_ENABLED is not true — skipping.",
    );
    return;
  }
  const workDir = join(tmpdir(), `fsq-refresh-${process.pid}`);
  await mkdir(workDir, { recursive: true });
  try {
    const { ok, failed } = await refreshAll(config, workDir, {
      duckdb: runDuckdb,
    });
    console.log(`FSQ refresh done: ${ok.length} ok, ${failed.length} failed.`);
    if (failed.length > 0) {
      // A partial failure must not report green — the scheduler should alert.
      process.exitCode = 1;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Run as a CLI only (not when imported by the spec).
if (process.argv[1]?.endsWith("refresh-fsq-extracts.js")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
