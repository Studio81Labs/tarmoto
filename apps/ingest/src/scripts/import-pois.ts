/**
 * CLI entry point to run an offline POI import on demand (#850 OSM, #869 FSQ).
 *
 * Usage (after `pnpm backend:build`, with `pnpm db:up` running and the source's
 * `*_IMPORT_DIR` pointing at the extract directory):
 *   node dist/scripts/import-pois.js             # OSM, every configured region
 *   node dist/scripts/import-pois.js CZ          # OSM, a single region
 *   node dist/scripts/import-pois.js fsq         # FSQ, every configured region
 *   node dist/scripts/import-pois.js fsq CZ      # FSQ, a single region
 *
 * An optional leading `osm` / `fsq` selects the source (default `osm`, so the
 * existing `<region>` form is unchanged); the next arg, if any, is the ISO
 * region code. OSM reads `<TARMOTO_OSM_POI_IMPORT_DIR>/<code>.osm`; FSQ reads
 * `<TARMOTO_FSQ_POI_IMPORT_DIR>/<code>.fsq.jsonl` — both via `PoiImportService`
 * (the FSQ instance under `FSQ_POI_IMPORT`), the same the weekly dispatcher uses.
 *
 * Unlike the cron trigger, this bypasses the source's `*_IMPORT_ENABLED` gate —
 * a manual run should import on demand without flipping the global flag. The
 * upsert is idempotent (by `(source, external_id)`) and a region with no extract
 * yet is skipped, so re-running is safe; a parse failure aborts before any write.
 */

import "reflect-metadata";
import {
  FSQ_POI_IMPORT,
  PoiImportService,
  type PoiImportResult,
} from "../poi/poi-import.service.js";
import { bootstrapScriptContext } from "./bootstrap-script-context.js";

const SOURCES = ["osm", "fsq"] as const;
type Source = (typeof SOURCES)[number];

function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

function logResult(source: Source, result: PoiImportResult): void {
  console.log(`${source} import [${result.region}]:`);
  console.log(`  fetched   : ${result.fetched}`);
  console.log(`  upserted  : ${result.upserted}`);
  console.log(`  tombstoned: ${result.tombstoned}`);
  if (result.skipped) {
    console.log("  skipped   : no extract file yet (region not provisioned)");
  }
}

async function main(): Promise<void> {
  // Boots AppModule with the BullMQ workers + scheduler disabled, so this
  // one-off import can't consume unrelated jobs on a shared Redis (see the
  // helper for the full rationale).
  const app = await bootstrapScriptContext();

  try {
    // Optional leading `osm`/`fsq` source; default `osm` keeps `<region>` working.
    const args = process.argv.slice(2).map((a) => a.trim());
    const source: Source =
      args[0] && isSource(args[0].toLowerCase())
        ? (args[0].toLowerCase() as Source)
        : "osm";
    const regionArg = (
      isSource((args[0] ?? "").toLowerCase()) ? args[1] : args[0]
    )
      ?.trim()
      .toUpperCase();

    const service =
      source === "fsq"
        ? app.get<PoiImportService>(FSQ_POI_IMPORT)
        : app.get(PoiImportService);

    if (regionArg) {
      const region = service.regions.find((r) => r.code === regionArg);
      if (!region) {
        const known = service.regions.map((r) => r.code).join(", ");
        throw new Error(
          `Unknown region code "${regionArg}". ` +
            `Configured ${source} regions: ${known || "(none)"}`,
        );
      }
      console.log(
        `Running ${source} POI import for region ${region.code} ` +
          `(manual run — ignores the enabled flag)`,
      );
      logResult(source, await service.importRegion(region));
    } else {
      console.log(
        `Running ${source} POI import for all ${service.regions.length} ` +
          `configured region(s) (manual run — ignores the enabled flag)`,
      );
      for (const result of await service.importAll()) {
        logResult(source, result);
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error("import-pois failed:", err);
  process.exit(1);
});
