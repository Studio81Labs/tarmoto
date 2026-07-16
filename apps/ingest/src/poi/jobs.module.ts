import { Module, type Provider } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { POI_IMPORT_QUEUE } from "@tarmoto/ingest";
import { PoiModule } from "./poi.module.js";
import { PoiImportProcessor } from "./poi-import.processor.js";
import { PoiImportScheduler } from "./poi-import.scheduler.js";
import { PoiImportProducer } from "./poi-import.producer.js";

/**
 * Gate worker/scheduler registration at module-evaluation time (mirrors the
 * backend's `JobsModule.forRoot()`) so the moved `import-pois` /
 * `load-region-boundaries` CLIs — which boot via `bootstrapScriptContext`
 * (sets `TARMOTO_QUEUE_WORKER_ENABLED=false` BEFORE dynamically importing
 * `AppModule`, so this module is only evaluated after the env var is set) —
 * resolve `PoiImportService` and import directly, without an always-on
 * worker double-processing the same region.
 *
 * Reading the env directly here (rather than via an async `useFactory`) is
 * required because Nest providers can't be conditionally included from an
 * async factory. For the same reason `apps/ingest/src/main.ts` preloads
 * `dotenv/config` BEFORE importing `AppModule`, so a `TARMOTO_QUEUE_WORKER_ENABLED`
 * supplied via `apps/ingest/.env` is already in `process.env` by the time this
 * module-eval read runs (`ConfigModule.forRoot()` loads the file too late for it).
 */
const rawToggle =
  process.env.TARMOTO_QUEUE_WORKER_ENABLED?.trim().toLowerCase();
const workersEnabled = rawToggle !== "false";

const WORKER_PROVIDERS: Provider[] = workersEnabled
  ? [PoiImportProcessor, PoiImportScheduler]
  : [];

/**
 * BullMQ root for apps/ingest (T5) — the `poi.import` queue only (apps/ingest
 * owns no other queue). The queue CLIENT + Redis connection are always
 * registered (a CLI script or a future producer can enqueue even with the
 * worker disabled, mirroring the backend's producer-always-registers
 * pattern); the WORKER (`PoiImportProcessor`) and the recurring-schedule
 * registration (`PoiImportScheduler`) are gated on
 * `TARMOTO_QUEUE_WORKER_ENABLED`, exactly like the backend's split-deployment
 * toggle.
 */
@Module({
  imports: [
    ConfigModule,
    PoiModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("TARMOTO_REDIS_HOST") ?? "localhost",
          // Default 6379, Redis's standard port: this is the DEPLOYMENT
          // value, matching the backend's own default so a producer (the
          // backend, enqueuing `poi.import` jobs) and this consumer agree on
          // where Redis is when only `TARMOTO_REDIS_HOST` is set. Local dev
          // overrides this to 6380 via `apps/ingest/.env` (created by
          // `pnpm bootstrap` from `apps/ingest/.env.example`, mirroring the
          // backend's own `.env` convention), because this repo's
          // `infra/docker/docker-compose.yml` deliberately maps the dev Redis
          // container to host port 6380 (to avoid clashing with a
          // system-local Redis).
          port: Number.parseInt(
            config.get<string>("TARMOTO_REDIS_PORT") ?? "6379",
            10,
          ),
          username: config.get<string>("TARMOTO_REDIS_USERNAME") || undefined,
          password: config.get<string>("TARMOTO_REDIS_PASSWORD") || undefined,
          // BullMQ requires this to be null on the connection to keep pulling
          // jobs from the queue (it polls via blocking commands).
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: POI_IMPORT_QUEUE }),
  ],
  providers: [PoiImportProducer, ...WORKER_PROVIDERS],
  exports: [PoiImportProducer],
})
export class PoiJobsModule {}
