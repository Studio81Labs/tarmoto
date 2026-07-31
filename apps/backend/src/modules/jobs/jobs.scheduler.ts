import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  RECURRING_PATTERNS,
} from './jobs.constants.js';
import { DIGEST_DISPATCH_PRIORITY } from './jobs.config.js';
import { JOBS_CONFIG_TOKEN, type JobsConfig } from './jobs.tokens.js';

interface RecurringJobSpec {
  queue: Queue;
  name: string;
  pattern: string;
  description: string;
  /** BullMQ priority for the produced jobs (1 = highest). Omit for default. */
  priority?: number;
}

/**
 * Registers BullMQ repeatable jobs on application bootstrap. Using
 * BullMQ's native repeatables (instead of `@Cron` decorators that
 * call `queue.add()`) keeps the schedule definition inside Redis,
 * which means:
 *
 *   - a process restart does not double-fire jobs;
 *   - a misconfigured worker pool can't lose schedule state;
 *   - the BullMQ dashboard surfaces the schedule alongside the
 *     queue counts.
 *
 * Schedules are reconciled on every boot: any repeatable job whose
 * cron pattern changed in `jobs.constants.ts` is removed and
 * re-registered. This is the only correct way to "edit" a BullMQ
 * repeatable — the library otherwise silently keeps the old pattern
 * because the repeatable key includes the pattern.
 *
 * Schedules are only registered when `workersEnabled = true`. The
 * API container in a split deployment skips the registration so
 * exactly one process owns the schedule (the worker container).
 */
@Injectable()
export class JobsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.HAZARDS_CLEANUP)
    private readonly hazardsCleanup: Queue,
    @InjectQueue(QUEUE_NAMES.BADGES_RECHECK)
    private readonly badgesRecheck: Queue,
    @InjectQueue(QUEUE_NAMES.DIGEST_WEEKLY)
    private readonly digestWeekly: Queue,
    @InjectQueue(QUEUE_NAMES.ACCOUNT_DELETION_SWEEP)
    private readonly accountDeletionSweep: Queue,
    @InjectQueue(QUEUE_NAMES.FUNZONE_RECOMPUTE)
    private readonly funzoneRecompute: Queue,
    @InjectQueue(QUEUE_NAMES.LOCATION_RETENTION_SWEEP)
    private readonly locationRetentionSweep: Queue,
    @InjectQueue(QUEUE_NAMES.WEATHER_ALERT_SWEEP)
    private readonly weatherAlertSweep: Queue,
    @InjectQueue(QUEUE_NAMES.MODEL_EVAL_RECONCILE)
    private readonly modelEvalReconcile: Queue,
    @InjectQueue(QUEUE_NAMES.MODEL_EVAL_AGREEMENT)
    private readonly modelEvalAgreement: Queue,
    @InjectQueue(QUEUE_NAMES.NAP_CLOSURE_POLL)
    private readonly napClosurePoll: Queue,
    @InjectQueue(QUEUE_NAMES.ROAD_IMPORT)
    private readonly roadImport: Queue,
    @InjectQueue(QUEUE_NAMES.STORE_RECONCILIATION_RETRY)
    private readonly storeReconciliationRetry: Queue,
    @Inject(JOBS_CONFIG_TOKEN)
    private readonly config: JobsConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.workersEnabled) {
      this.logger.log(
        'Workers disabled (TARMOTO_QUEUE_WORKER_ENABLED=false); skipping schedule registration',
      );
      return;
    }

    const specs = this.specs();
    for (const spec of specs) {
      try {
        await this.reconcile(spec);
      } catch (err) {
        // Don't bail boot if one schedule fails to register — the
        // others still function and the operator gets a clear log
        // pointing at the broken queue. Without this catch, a
        // transient Redis hiccup at boot could prevent the API from
        // starting.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to register recurring schedule for ${spec.queue.name}: ${msg}`,
        );
      }
    }

    await this.removeRetiredSchedulers();
  }

  /**
   * Remove repeatables whose job or queue was renamed. BullMQ keys a
   * scheduler by `${queue}.${name}`, so a rename registers a NEW key and
   * leaves the old one firing forever — its job then reaches a processor
   * that no longer knows the name, or lands in a queue nothing consumes
   * anymore. The POI import's own #850 `run`→`dispatch` rename cleanup
   * moved to apps/ingest's `PoiImportScheduler` along with the `poi.import`
   * queue itself (Task 5, POI-ingestion extraction), so it isn't handled
   * here.
   *
   * This IS the next one: the `osm.import`→`road.import` queue rename (the
   * import source/domain naming pass) leaves an `osm.import.run` scheduler
   * upserted in Redis in any environment that already booted the prior code
   * (e.g. staging ran #781). `osm.import` is no longer a queue this scheduler
   * (or Nest) injects, so the cleanup below binds an ad-hoc `Queue` to the
   * bare retired name via `retiredQueueFor` instead of `@InjectQueue`.
   */
  private async removeRetiredSchedulers(): Promise<void> {
    const retired: Array<{ queueName: string; schedulerId: string }> = [
      // #781's OSM road-graph import queue, renamed `osm.import` ->
      // `road.import` in this PR. Bare string literals on purpose: do NOT
      // reintroduce `osm.import` into QUEUE_NAMES/JOB_NAMES or register it
      // as a NestJS queue — this is a one-time cleanup of a queue this app
      // no longer owns, not a queue this app still runs.
      { queueName: 'osm.import', schedulerId: 'osm.import.run' },
    ];
    for (const { queueName, schedulerId } of retired) {
      // Build + use + tear down the ad-hoc queue all inside try/finally: this
      // runs UNGUARDED in onApplicationBootstrap, and the surrounding scheduler
      // deliberately keeps boot resilient to Redis hiccups — a throw from the
      // ad-hoc `Queue` construction or its `close()` must not bail startup.
      let queue: Queue | undefined;
      try {
        queue = this.retiredQueueFor(queueName);
        const removed = await queue.removeJobScheduler(schedulerId);
        if (removed) {
          this.logger.log(`Removed retired scheduler ${schedulerId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to remove retired scheduler ${schedulerId}: ${msg}`,
        );
      } finally {
        try {
          await queue?.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Failed to close retired queue ${queueName}: ${msg}`,
          );
        }
      }
    }
  }

  /**
   * Builds an ad-hoc BullMQ `Queue` bound to a retired queue name this
   * scheduler no longer injects, purely so `removeJobScheduler` can reach its
   * old repeatable key. Reuses the connection options an already-injected
   * queue was constructed with (`Queue.opts.connection`) rather than opening
   * a fresh pool from scratch — the caller closes the returned queue right
   * after use so the ad-hoc connection can't leak past this one call.
   *
   * Its own method (rather than inlined in `removeRetiredSchedulers`) so
   * specs can stub it out and assert against a mock instead of exercising a
   * live Redis connection.
   */
  protected retiredQueueFor(name: string): Queue {
    return new Queue(name, { connection: this.roadImport.opts.connection });
  }

  private specs(): RecurringJobSpec[] {
    return [
      {
        queue: this.hazardsCleanup,
        name: JOB_NAMES.HAZARDS_CLEANUP_RUN,
        pattern: RECURRING_PATTERNS.HOURLY,
        description: 'hourly hazard expiry sweep',
      },
      {
        queue: this.badgesRecheck,
        name: JOB_NAMES.BADGES_RECHECK_DISPATCH,
        pattern: RECURRING_PATTERNS.DAILY_0230,
        description: 'nightly badge recheck dispatcher',
      },
      {
        queue: this.digestWeekly,
        name: JOB_NAMES.DIGEST_WEEKLY_DISPATCH,
        pattern: RECURRING_PATTERNS.HOURLY,
        description: 'hourly weekly-digest timezone dispatcher',
        // Outrank the compose (email-send) jobs that share this queue so a large
        // fan-out can't delay the next dispatch past the catch-up horizon.
        priority: DIGEST_DISPATCH_PRIORITY,
      },
      {
        queue: this.accountDeletionSweep,
        name: JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN,
        pattern: RECURRING_PATTERNS.DAILY_0330,
        description: 'daily account-deletion sweep',
      },
      {
        queue: this.funzoneRecompute,
        name: JOB_NAMES.FUNZONE_RECOMPUTE_RUN,
        pattern: RECURRING_PATTERNS.WEEKLY_MON_0400,
        description: 'weekly fun-zone clustering recompute',
      },
      {
        queue: this.locationRetentionSweep,
        name: JOB_NAMES.LOCATION_RETENTION_SWEEP_RUN,
        pattern: RECURRING_PATTERNS.DAILY_0400,
        description: 'daily privacy retention sweep (#279)',
      },
      {
        queue: this.weatherAlertSweep,
        name: JOB_NAMES.WEATHER_ALERT_SWEEP_RUN,
        pattern: RECURRING_PATTERNS.EVERY_15_MINUTES,
        description: 'severe-weather push sweep for active riders (#333)',
      },
      {
        queue: this.modelEvalReconcile,
        name: JOB_NAMES.MODEL_EVAL_RECONCILE_RUN,
        pattern: RECURRING_PATTERNS.HOURLY,
        description: 'hourly model-eval reconciliation (#496)',
      },
      {
        queue: this.modelEvalAgreement,
        name: JOB_NAMES.MODEL_EVAL_AGREEMENT_RUN,
        pattern: RECURRING_PATTERNS.WEEKLY_MON_0500,
        description: 'weekly model-eval cross-device/bike agreement (#496)',
      },
      {
        queue: this.napClosurePoll,
        name: JOB_NAMES.NAP_CLOSURE_POLL_RUN,
        pattern: RECURRING_PATTERNS.EVERY_3_MINUTES,
        description: 'NAP (NDIC) closure poll → road_closures (#743)',
      },
      {
        queue: this.roadImport,
        name: JOB_NAMES.ROAD_IMPORT_RUN,
        pattern: RECURRING_PATTERNS.WEEKLY_SUN_0100,
        description: 'weekly OSM road-graph import → road_segments (#781)',
      },
      {
        queue: this.storeReconciliationRetry,
        name: JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN,
        pattern: RECURRING_PATTERNS.HOURLY,
        description:
          'hourly store-billing reconciliation retry + inbox retention prune',
      },
      // Note: the road-quality conflation (#779) is NOT scheduled here — it is a
      // success-continuation enqueued by the OSM import processor, so it can
      // never race a long-running or failed import the way a fixed-time cron
      // would.
    ];
  }

  private async reconcile(spec: RecurringJobSpec): Promise<void> {
    // Reconciliation strategy: list the existing repeatables for the
    // queue+job-name, drop any whose pattern doesn't match the
    // current spec, then add the desired one. BullMQ's `upsertJobScheduler`
    // (v5+) handles the "create or update" path atomically.
    await spec.queue.upsertJobScheduler(
      this.schedulerKey(spec),
      { pattern: spec.pattern },
      {
        name: spec.name,
        opts: {
          // No jobId — repeat key is enough to dedupe
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 1000 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        },
      },
    );
    this.logger.log(
      `Registered recurring job ${spec.queue.name}.${spec.name} (${spec.pattern}) — ${spec.description}`,
    );
  }

  private schedulerKey(spec: RecurringJobSpec): string {
    // Stable key per (queue, job name) so reboots reconcile the same
    // schedule rather than accumulating one entry per boot.
    return `${spec.queue.name}.${spec.name}`;
  }
}
