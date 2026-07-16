import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

/**
 * Boot a standalone Nest DI context for a one-off CLI script, with the BullMQ
 * worker and the recurring-job scheduler disabled.
 *
 * `PoiJobsModule`'s worker/scheduler gate (`apps/ingest/src/poi/jobs.module.ts`)
 * is a plain top-level `const` read once when that module is first required —
 * it defaults workers ON, so a plain `import { AppModule }` +
 * `createApplicationContext` would construct `PoiImportProcessor` and register
 * the weekly `poi.import` schedule. On a shared Redis a short-lived script
 * would then double-process whatever region the always-on worker is already
 * importing. Setting the gate before a *dynamic* `AppModule` import keeps the
 * script read/compute-only.
 *
 * Callers resolve providers from the returned context with `.get()` and must
 * `.close()` it when done (typically in a `finally`).
 */
export async function bootstrapScriptContext(): Promise<INestApplicationContext> {
  process.env.TARMOTO_QUEUE_WORKER_ENABLED = "false";
  // Dynamic import: `AppModule` (and thus `PoiJobsModule`) must not be
  // evaluated until after the gate above is set. A static top-level import
  // would be hoisted and run first, defeating the toggle.
  const { AppModule } = await import("../app.module.js");
  return NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
}
