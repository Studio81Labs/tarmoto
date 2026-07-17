// Must be the first import so Sentry can instrument the runtime before other
// modules load. No-op until TARMOTO_SENTRY_DSN is set (see instrument.ts).
//
// instrument.ts's own first line is `import "dotenv/config"`, so this also
// preserves the dotenv-before-worker-gate ordering a dedicated preload used
// to provide here: jobs.module's TARMOTO_QUEUE_WORKER_ENABLED gate is read at
// module-evaluation time — as AppModule is imported below, EARLIER than
// ConfigModule.forRoot() would load the file — so dotenv must already have
// run by then for a .env-supplied toggle to be visible to that gate. No-ops
// in the container (no .env; real env vars are set).
import "./instrument.js";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

// The ingest service runs the always-on BullMQ worker + scheduler (wired in T5).
// It also exposes a minimal HTTP listener so the container healthcheck has an
// endpoint to hit; there is no public API surface here.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Validate the internal API's POST body (the only routes with a body). A
  // no-op on /healthz. `whitelist` strips unknown fields; `transform`
  // instantiates the DTO class.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Default 3005, NOT the backend's 3000: the root `pnpm dev` runs this service
  // and the backend on the same host, so a shared default port makes one exit
  // with EADDRINUSE (and the local worker never stays up). In the container this
  // is overridden by `ENV PORT` (apps/ingest runs alone there).
  await app.listen(process.env.PORT ?? 3005);
  const shutdown = (): void => void app.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void bootstrap();
