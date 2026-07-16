import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

// The ingest service runs the always-on BullMQ worker + scheduler (wired in T5).
// It also exposes a minimal HTTP listener so the container healthcheck has an
// endpoint to hit; there is no public API surface here.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
