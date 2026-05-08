import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  RECURRING_PATTERNS,
} from './jobs.constants.js';
import { JOBS_CONFIG_TOKEN, type JobsConfig } from './jobs.tokens.js';

interface RecurringJobSpec {
  queue: Queue;
  name: string;
  pattern: string;
  description: string;
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
