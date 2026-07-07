/**
 * CLI entry point to run the offline POI import on demand (#850).
 *
 * Usage (after `pnpm backend:build`, with `pnpm db:up` running and
 * `TARMOTO_POI_IMPORT_DIR` pointing at the extract directory):
 *   node dist/scripts/import-pois.js            # every configured region
 *   node dist/scripts/import-pois.js CZ         # a single region by ISO code
 *
 * Imports per-country Geofabrik `.osm` extracts (`<TARMOTO_POI_IMPORT_DIR>/<code>.osm`,
 * lower-case) into the `pois` table via the same `PoiImportService` the weekly
 * BullMQ dispatcher fans out to. With no argument it runs every region in
 * `service.regions` (the `TARMOTO_POI_IMPORT_REGIONS` list, defaulting to the
 * full coverage set); with a country code it runs just that region and errors
 * on a code outside the configured list.
 *
 * Unlike the cron trigger, this bypasses the `TARMOTO_POI_IMPORT_ENABLED`
 * gate — a manual run should import on demand without flipping the global
 * flag. The upsert is idempotent (by `(source, external_id)`) and a region
 * with no extract yet is skipped, so re-running is safe; a parse failure aborts
 * that region before any write.
 */

import 'reflect-metadata';
import {
  PoiImportService,
  type PoiImportResult,
} from '../modules/poi/poi-import.service.js';
import { bootstrapScriptContext } from './bootstrap-script-context.js';

function logResult(result: PoiImportResult): void {
  console.log(`POI import [${result.region}]:`);
  console.log(`  fetched   : ${result.fetched}`);
  console.log(`  upserted  : ${result.upserted}`);
  console.log(`  tombstoned: ${result.tombstoned}`);
  if (result.skipped) {
    console.log('  skipped   : no extract file yet (region not provisioned)');
  }
}

async function main(): Promise<void> {
  // Boots AppModule with the BullMQ workers + scheduler disabled, so this
  // one-off import can't consume unrelated jobs on a shared Redis (see the
  // helper for the full rationale).
  const app = await bootstrapScriptContext();

  try {
    const service = app.get(PoiImportService);
    const requestedCode = process.argv[2]?.trim().toUpperCase();

    if (requestedCode) {
      const region = service.regions.find((r) => r.code === requestedCode);
      if (!region) {
        const known = service.regions.map((r) => r.code).join(', ');
        throw new Error(
          `Unknown region code "${requestedCode}". ` +
            `Configured regions: ${known || '(none)'}`,
        );
      }
      console.log(
        `Running POI import for region ${region.code} ` +
          `(manual run — ignores TARMOTO_POI_IMPORT_ENABLED)`,
      );
      logResult(await service.importRegion(region));
    } else {
      console.log(
        `Running POI import for all ${service.regions.length} configured ` +
          `region(s) (manual run — ignores TARMOTO_POI_IMPORT_ENABLED)`,
      );
      for (const result of await service.importAll()) {
        logResult(result);
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('import-pois failed:', err);
  process.exit(1);
});
