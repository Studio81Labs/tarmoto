import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

// The ingest service runs the always-on BullMQ worker + scheduler (wired in T5).
// It also exposes a minimal HTTP listener so the container healthcheck has an
// endpoint to hit; there is no public API surface here.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  const shutdown = (): void => void app.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void bootstrap();
