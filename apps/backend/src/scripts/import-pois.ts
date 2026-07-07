/**
 * CLI entry point to run the offline POI import on demand (#847).
 *
 * Usage (after `pnpm backend:build`, with `pnpm db:up` running):
 *   node dist/scripts/import-pois.js
 *   TARMOTO_POI_IMPORT_BBOX=14.2,50.0,14.7,50.2 node dist/scripts/import-pois.js
 *
 * Mirrors POIs for the configured bbox (default: the CZ / Beskydy launch box,
 * override with TARMOTO_POI_IMPORT_BBOX) into the `pois` table via the same
 * `PoiImportService` the weekly BullMQ cron uses.
 *
 * Unlike the cron trigger, this bypasses the `TARMOTO_POI_IMPORT_ENABLED`
 * gate — a manual run should import on demand without flipping the global
 * flag. The fetch+upsert is idempotent (upsert by `(source, external_id)`),
 * so re-running is safe; a fetch failure aborts before any write.
 */

import 'reflect-metadata';
import { PoiImportService } from '../modules/poi/poi-import.service.js';
import { bootstrapScriptContext } from './bootstrap-script-context.js';

async function main(): Promise<void> {
  // Boots AppModule with the BullMQ workers + scheduler disabled, so this
  // one-off import can't consume unrelated jobs on a shared Redis (see the
  // helper for the full rationale).
  const app = await bootstrapScriptContext();

  try {
    const service = app.get(PoiImportService);
    const { minLng, minLat, maxLng, maxLat } = service.bbox;
    console.log(
      `Running POI import for bbox=${minLng},${minLat},${maxLng},${maxLat} ` +
        `(manual run — ignores TARMOTO_POI_IMPORT_ENABLED)`,
    );
    const result = await service.import();
    console.log('POI import complete:');
    console.log(`  fetched : ${result.fetched}`);
    console.log(`  upserted: ${result.upserted}`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('import-pois failed:', err);
  process.exit(1);
});
