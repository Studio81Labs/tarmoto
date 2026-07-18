/**
 * CLI entry point to run the road-quality → GraphHopper conflation on demand
 * (#779, ADR-0005) — the manual companion to the `quality.conflation` queue,
 * mirroring the `road:import` command.
 *
 * Usage (after `pnpm backend:build`, with the Tarmoto DB reachable and
 * TARMOTO_QUALITY_CONFLATION_INPUT_FILE / _OUTPUT_FILE pointing at the
 * whole-network `.osm` extract to tag and a derived output path GraphHopper
 * re-imports):
 *   node dist/scripts/quality-conflation.js
 *
 * It joins the live, scored `road_segments` back to their OSM ways, injects a
 * `smoothness` tag into the input extract, writes the derived output, then fires
 * the re-import webhook (TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_*) so GraphHopper
 * rebuilds its graph — the SAME `QualityConflationService` + re-import hook the
 * import processor chains on a successful road import.
 *
 * Unlike the chained cron path, this bypasses the TARMOTO_QUALITY_CONFLATION_ENABLED
 * gate — a manual run should conflate on demand without flipping the global flag
 * (the input/output paths are read from config regardless). It is idempotent
 * (re-running yields the same artifact until the underlying scores change), the
 * output is written atomically (temp sibling + rename), and it throws with a
 * clear error if the input/output paths are unset or the input is unreadable —
 * so a mis-configured run fails loudly instead of producing nothing. The webhook
 * is a no-op when unconfigured (the derived extract is still written; re-import
 * GraphHopper manually) and throws on a non-2xx/unreachable receiver.
 */

import 'reflect-metadata';
import { QualityConflationService } from '../modules/roads/quality-conflation/quality-conflation.service.js';
import { GraphHopperReimportService } from '../modules/roads/quality-conflation/graphhopper-reimport.service.js';
import { bootstrapScriptContext } from './bootstrap-script-context.js';

async function main(): Promise<void> {
  // Boots AppModule with the BullMQ workers + scheduler disabled, so this
  // one-off job can't consume unrelated jobs on a shared Redis (see the helper
  // for the full rationale).
  const app = await bootstrapScriptContext();

  try {
    const conflation = app.get(QualityConflationService);
    const reimport = app.get(GraphHopperReimportService);

    console.log(
      'Running road-quality → GraphHopper conflation ' +
        '(manual run — ignores the enabled flag)',
    );
    const { waysTagged, assignments } = await conflation.runConflation();
    console.log('Quality conflation complete:');
    console.log(`  ways scored (assignments): ${assignments}`);
    console.log(`  ways tagged in output    : ${waysTagged}`);

    // Mirror the processor: fire the re-import hook after a successful
    // conflation so GraphHopper rebuilds from the fresh extract. No-op (not an
    // error) when unconfigured — the derived file is written either way.
    if (reimport.configured) {
      const { triggered } = await reimport.trigger();
      console.log(
        `  GraphHopper re-import     : ${triggered ? 'webhook fired' : 'skipped'}`,
      );
    } else {
      console.log(
        '  GraphHopper re-import     : no webhook configured — re-import GraphHopper manually',
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('quality-conflation failed:', err);
  process.exit(1);
});
