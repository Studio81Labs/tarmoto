import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WeatherAlertDispatch } from '../../entities/weather-alert-dispatch.entity.js';
import { HazardsModule } from '../hazards/index.js';
import { BadgesModule } from '../badges/index.js';
import { FeaturesModule } from '../features/features.module.js';
import { AccountModule } from '../account/index.js';
import { DataExportModule } from '../account/data-export/data-export.module.js';
import { RoadsModule } from '../roads/index.js';
import { EmailModule } from '../email/index.js';
import { PushModule } from '../push/push.module.js';
import { WeatherModule } from '../weather/weather.module.js';
import { ALL_QUEUE_NAMES } from './jobs.constants.js';
import { buildJobsConfig, type JobsConfig } from './jobs.config.js';
import { JOBS_CONFIG_TOKEN } from './jobs.tokens.js';
import { JobsProducer } from './jobs.producer.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { QueueHealthService } from './queue-health.service.js';
import { JobsController } from './jobs.controller.js';
import { HazardsCleanupProcessor } from './processors/hazards-cleanup.processor.js';
import { BadgesRecheckProcessor } from './processors/badges-recheck.processor.js';
import { DigestWeeklyProcessor } from './processors/digest-weekly.processor.js';
import { DataExportQueueProcessor } from './processors/data-export.processor.js';
import { AccountDeletionSweepProcessor } from './processors/account-deletion-sweep.processor.js';
import { AccountDeletionFinalizeProcessor } from './processors/account-deletion-finalize.processor.js';
import { StoreReconciliationProcessor } from './processors/store-reconciliation.processor.js';
import { FunzoneRecomputeProcessor } from './processors/funzone-recompute.processor.js';
import { LocationRetentionSweepProcessor } from './processors/location-retention-sweep.processor.js';
import { WeatherAlertSweepProcessor } from './processors/weather-alert-sweep.processor.js';
import { ModelEvalReconcileProcessor } from './processors/model-eval-reconcile.processor.js';
import { ModelEvalAgreementProcessor } from './processors/model-eval-agreement.processor.js';
import { NapClosurePollProcessor } from './processors/nap-closure-poll.processor.js';
import { OsmImportProcessor } from './processors/osm-import.processor.js';
import { QualityConflationProcessor } from './processors/quality-conflation.processor.js';
import { ModelEvalModule } from '../model-eval/index.js';
import { NapModule } from '../nap/nap.module.js';

const JOBS_CONFIG_PROVIDER: Provider = {
  provide: JOBS_CONFIG_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): JobsConfig => buildJobsConfig(config),
};

const PROCESSOR_PROVIDERS: Provider[] = [
  HazardsCleanupProcessor,
  BadgesRecheckProcessor,
  DigestWeeklyProcessor,
  DataExportQueueProcessor,
  AccountDeletionSweepProcessor,
  AccountDeletionFinalizeProcessor,
  StoreReconciliationProcessor,
  FunzoneRecomputeProcessor,
  LocationRetentionSweepProcessor,
  WeatherAlertSweepProcessor,
  ModelEvalReconcileProcessor,
  ModelEvalAgreementProcessor,
  NapClosurePollProcessor,
  OsmImportProcessor,
  QualityConflationProcessor,
];

/**
 * Background job system (BullMQ on Redis). Owns:
 *
 *   - shared Redis connection (re-uses existing TARMOTO_REDIS_* env vars);
 *   - ten named queues (see `jobs.constants.ts`);
 *   - the `JobsScheduler` that registers recurring schedules on boot;
 *   - the `JobsProducer` that the rest of the app uses to enqueue work;
 *   - per-queue processors;
 *   - the `GET /jobs/health` endpoint.
 *
 * Local dev runs both producers and workers in-process (the default).
 * A multi-instance deploy can split them: set
 * `TARMOTO_QUEUE_WORKER_ENABLED=false` on the API container and run a
 * separate process where it's true. The producers in the API still
 * enqueue successfully because BullModule registers the queues
 * regardless of the worker toggle.
 *
 * The processors and scheduler are registered conditionally: when
 * workers are disabled, the API process registers ONLY queue clients
 * (for enqueue) and skips both processor wiring and schedule
 * reconciliation, so a split deployment runs exactly one worker.
 */
@Module({})
export class JobsModule {
  static forRoot(): DynamicModule {
    // Gate worker registration synchronously at module-construction time
    // so the API container in a split deployment does NOT instantiate
    // any `WorkerHost` providers. Reading the env directly here (rather
    // than via `useFactory`) is required because Nest providers can't
    // be conditionally included from an async factory.
    const rawToggle =
      process.env.TARMOTO_QUEUE_WORKER_ENABLED?.trim().toLowerCase();
    const workersEnabled = rawToggle !== 'false';

    const workerProviders: Provider[] = workersEnabled
      ? [JobsScheduler, ...PROCESSOR_PROVIDERS]
      : [];

    return {
      module: JobsModule,
      imports: [
        ConfigModule,
        TypeOrmModule.forFeature([WeatherAlertDispatch]),
        HazardsModule,
        BadgesModule,
        FeaturesModule,
        AccountModule,
        DataExportModule,
        RoadsModule,
        EmailModule,
        PushModule,
        WeatherModule,
        ModelEvalModule,
        NapModule,
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const built = buildJobsConfig(config);
            return { connection: built.connection };
          },
        }),
        ...ALL_QUEUE_NAMES.map((name) => BullModule.registerQueue({ name })),
      ],
      controllers: [JobsController],
      providers: [
        JOBS_CONFIG_PROVIDER,
        JobsProducer,
        QueueHealthService,
        ...workerProviders,
      ],
      exports: [JobsProducer],
    };
  }
}
