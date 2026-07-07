import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * Boot a standalone Nest DI context for a one-off CLI script, with the BullMQ
 * workers and the recurring-job scheduler disabled.
 *
 * `JobsModule.forRoot()` reads `TARMOTO_QUEUE_WORKER_ENABLED` at module-eval
 * time and defaults workers ON, so a plain `import { AppModule }` +
 * `createApplicationContext` would start every queue processor and register
 * the recurring schedules. On a shared Redis a short-lived script would then
 * consume unrelated jobs (account deletion, data export) and refresh those
 * schedules before the process exits. Setting the gate before a *dynamic*
 * `AppModule` import keeps the script read/compute-only.
 *
 * Callers resolve providers from the returned context with `.get()` and must
 * `.close()` it when done (typically in a `finally`).
 */
export async function bootstrapScriptContext(): Promise<INestApplicationContext> {
  process.env.TARMOTO_QUEUE_WORKER_ENABLED = 'false';
  // Dynamic import: `AppModule` (and thus `JobsModule.forRoot()`) must not be
  // evaluated until after the gate above is set. A static top-level import
  // would be hoisted and run first, defeating the toggle.
  const { AppModule } = await import('../app.module.js');
  return NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
}
