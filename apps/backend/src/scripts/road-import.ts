/**
 * CLI entry point to run the OSM → `road_segments` import on demand (#781, the
 * folder model / Sub-project B) — the manual companion to the weekly
 * `road.import` cron, mirroring `apps/ingest`'s `poi:import`.
 *
 * Usage (after `pnpm backend:build`, with the Tarmoto DB reachable and
 * `TARMOTO_OSM_ROAD_IMPORT_DIR` pointing at the per-tile extracts the ingest
 * `road:refresh` producer wrote to the shared volume):
 *   node dist/scripts/road-import.js          # every configured region
 *   node dist/scripts/road-import.js CZ       # a single region
 *
 * The optional arg is the ISO region code. Both forms read
 * `<TARMOTO_OSM_ROAD_IMPORT_DIR>/<code>-r<row>c<col>-s<span>.osm` per tile via
 * `OsmImportService` — the SAME service (and grid/scoping) the weekly cron uses.
 *
 * Unlike the cron trigger, this bypasses the `TARMOTO_OSM_ROAD_IMPORT_ENABLED`
 * gate: a manual run should import on demand without flipping the global flag
 * (the extract dir + regions are read from config regardless of `enabled`). The
 * upsert is idempotent (`ON CONFLICT (osm_way_id, segment_index)`) and a
 * region/tile with no extract yet is skipped, so re-running is safe — but a bad
 * snapshot (a partially-present region, or tiles present with zero in-scope
 * drivable roads) still aborts loudly before any partial write, exactly as the
 * scheduled import does.
 *
 * NOTE: this runs the import DIRECTLY (not via the BullMQ queue), so it does NOT
 * chain the road-quality → GraphHopper conflation the processor enqueues on a
 * scheduled success. Run the conflation separately if the derived extract needs
 * rebuilding after a manual import.
 */

import 'reflect-metadata';
import {
  OsmImportService,
  type OsmImportResult,
} from '../modules/roads/osm-import/osm-import.service.js';
import { bootstrapScriptContext } from './bootstrap-script-context.js';

function logResult(scope: string, result: OsmImportResult): void {
  console.log(`OSM road import [${scope}]:`);
  console.log(`  upserted   : ${result.upserted}`);
  console.log(`  carriedOver: ${result.carriedOver}`);
  console.log(`  deactivated: ${result.deactivated}`);
}

async function main(): Promise<void> {
  // Boots AppModule with the BullMQ workers + scheduler disabled, so this
  // one-off import can't consume unrelated jobs on a shared Redis (see the
  // helper for the full rationale).
  const app = await bootstrapScriptContext();

  try {
    const service = app.get(OsmImportService);
    const regionArg = process.argv[2]?.trim().toUpperCase();

    if (regionArg) {
      const region = service.regions.find((r) => r.code === regionArg);
      if (!region) {
        const known = service.regions.map((r) => r.code).join(', ');
        throw new Error(
          `Unknown region code "${regionArg}". ` +
            `Configured road regions: ${known || '(none)'}`,
        );
      }
      const { extractDir } = service;
      if (!extractDir) {
        throw new Error(
          'TARMOTO_OSM_ROAD_IMPORT_DIR is not set — nothing to import from.',
        );
      }
      console.log(
        `Running OSM road import for region ${region.code} ` +
          `(manual run — ignores the enabled flag)`,
      );
      const { result, tilesPresent } = await service.importRegion(
        region,
        extractDir,
      );
      // Fail loud, mirroring importAll's empty-dir guard: a deliberate
      // single-region manual run that finds ZERO tiles for the requested region
      // (empty/mis-mounted extractDir, an unrefreshed region, or a
      // TARMOTO_OSM_ROAD_TILE_SPAN_DEG that disagrees with the producer's grid —
      // so every derived filename is "absent") imported nothing. importRegion
      // reports that as tilesPresent: 0 without throwing (so importAll can apply
      // its cross-region guard); on this direct single-region path there is no
      // such umbrella, so throw here — a non-zero exit an operator / ops
      // automation can see, not a silent success.
      if (tilesPresent === 0) {
        throw new Error(
          `No tile extracts found for ${region.code} in ${extractDir} — nothing imported. ` +
            `Check the shared volume mount, that the refresh has produced ${region.code}'s ` +
            `tiles, and that TARMOTO_OSM_ROAD_TILE_SPAN_DEG matches the producer.`,
        );
      }
      logResult(region.code, result);
    } else {
      console.log(
        `Running OSM road import for all ${service.regions.length} ` +
          `configured region(s) (manual run — ignores the enabled flag)`,
      );
      logResult('all', await service.importAll());
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('road-import failed:', err);
  process.exit(1);
});
