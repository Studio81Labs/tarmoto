import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import {
  ALL_QUEUE_NAMES,
  QUEUE_NAMES,
  type QueueName,
} from './jobs.constants.js';

export interface QueueHealthEntry {
  queue: QueueName;
  /** Job counts grouped by BullMQ status. */
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  };
  /** Most recent failure summary (null if no failures retained). */
  lastFailure: {
    job_id: string;
    name: string;
    failed_at: string;
    attempts_made: number;
    failed_reason: string | null;
  } | null;
}

export interface QueueHealthSnapshot {
  generated_at: string;
  workers_enabled: boolean;
  queues: QueueHealthEntry[];
}

/**
 * Thin read-side aggregator for the queue health endpoint. All work
 * is read-only — this service never enqueues, retries, or removes
 * jobs. It exists so the controller stays trivial and so unit tests
 * can drive a single mock instead of injecting every queue.
 *
 * Per-queue failures are reported as the single most recent failure
 * because that's the actionable signal for on-call: when an
 * exponential-backoff retry chain finally exhausts, the operator
 * needs the latest stack/error, not the full failure log.
 */
@Injectable()
export class QueueHealthService {
  private readonly logger = new Logger(QueueHealthService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.HAZARDS_CLEANUP)
    private readonly hazardsCleanup: Queue,
    @InjectQueue(QUEUE_NAMES.BADGES_RECHECK)
    private readonly badgesRecheck: Queue,
    @InjectQueue(QUEUE_NAMES.DIGEST_WEEKLY)
    private readonly digestWeekly: Queue,
    @InjectQueue(QUEUE_NAMES.DATA_EXPORT)
    private readonly dataExport: Queue,
    @InjectQueue(QUEUE_NAMES.ACCOUNT_DELETION_SWEEP)
    private readonly accountDeletionSweep: Queue,
    @InjectQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE)
    private readonly accountDeletionFinalize: Queue,
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
    @InjectQueue(QUEUE_NAMES.QUALITY_CONFLATION)
    private readonly qualityConflation: Queue,
    @InjectQueue(QUEUE_NAMES.STORE_RECONCILIATION_RETRY)
    private readonly storeReconciliationRetry: Queue,
    @InjectQueue(QUEUE_NAMES.SUBSCRIPTION_NOTIFY)
    private readonly subscriptionNotify: Queue,
  ) {}

  private byName(): Record<QueueName, Queue> {
    return {
      [QUEUE_NAMES.HAZARDS_CLEANUP]: this.hazardsCleanup,
      [QUEUE_NAMES.BADGES_RECHECK]: this.badgesRecheck,
      [QUEUE_NAMES.DIGEST_WEEKLY]: this.digestWeekly,
      [QUEUE_NAMES.DATA_EXPORT]: this.dataExport,
      [QUEUE_NAMES.ACCOUNT_DELETION_SWEEP]: this.accountDeletionSweep,
      [QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE]: this.accountDeletionFinalize,
      [QUEUE_NAMES.FUNZONE_RECOMPUTE]: this.funzoneRecompute,
      [QUEUE_NAMES.LOCATION_RETENTION_SWEEP]: this.locationRetentionSweep,
      [QUEUE_NAMES.WEATHER_ALERT_SWEEP]: this.weatherAlertSweep,
      [QUEUE_NAMES.MODEL_EVAL_RECONCILE]: this.modelEvalReconcile,
      [QUEUE_NAMES.MODEL_EVAL_AGREEMENT]: this.modelEvalAgreement,
      [QUEUE_NAMES.NAP_CLOSURE_POLL]: this.napClosurePoll,
      [QUEUE_NAMES.ROAD_IMPORT]: this.roadImport,
      [QUEUE_NAMES.QUALITY_CONFLATION]: this.qualityConflation,
      [QUEUE_NAMES.STORE_RECONCILIATION_RETRY]: this.storeReconciliationRetry,
      [QUEUE_NAMES.SUBSCRIPTION_NOTIFY]: this.subscriptionNotify,
    };
  }

  async snapshot(workersEnabled: boolean): Promise<QueueHealthSnapshot> {
    const queues = this.byName();
    const entries = await Promise.all(
      ALL_QUEUE_NAMES.map((name) => this.entryFor(name, queues[name])),
    );
    return {
      generated_at: new Date().toISOString(),
      workers_enabled: workersEnabled,
      queues: entries,
    };
  }

  private async entryFor(
    name: QueueName,
    queue: Queue,
  ): Promise<QueueHealthEntry> {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      const [latestFailure] = await queue.getFailed(0, 0);
      return {
        queue: name,
        counts: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        },
        lastFailure: latestFailure ? this.summarize(latestFailure) : null,
      };
    } catch (err) {
      // A single queue's Redis read failure must not 500 the whole
      // health endpoint — on-call needs to see which queues are
      // healthy AND which are degraded. Surface the queue with empty
      // counters and a synthetic failure entry so the dashboard
      // shows the outage explicitly.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Health snapshot failed for queue ${name}: ${message}`);
      return {
        queue: name,
        counts: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 },
        lastFailure: {
          job_id: 'health-probe',
          name: 'health-probe',
          failed_at: new Date().toISOString(),
          attempts_made: 0,
          failed_reason: `getJobCounts failed: ${message}`,
        },
      };
    }
  }

  private summarize(job: Job): QueueHealthEntry['lastFailure'] {
    const finishedOn = job.finishedOn ?? job.processedOn ?? Date.now();
    return {
      job_id: this.redactJobId(String(job.id ?? 'unknown')),
      name: job.name,
      failed_at: new Date(finishedOn).toISOString(),
      attempts_made: job.attemptsMade,
      failed_reason: this.scrubFailureReason(job.failedReason ?? null),
    };
  }

  /**
   * Strip the entity portion of a manually-set jobId before exposing
   * it on the public health endpoint. Producers use the convention
   * `<queue-prefix>:<entity-id>[:<extra>]` (e.g.
   * `account-deletion-finalize:<user_uuid>`,
   * `digest-weekly:<user_uuid>:2026-W18`). The raw user UUID must
   * NEVER reach the unauthenticated `GET /jobs/health` response —
   * especially for the account-deletion queue, where the bare
   * presence of a user id signals "this account is being purged
   * under GDPR right now."
   *
   * Auto-generated BullMQ job ids (no colon, e.g. `12345`) pass
   * through unchanged — they're internal counters, not user data.
   */
  private redactJobId(rawId: string): string {
    const colonIdx = rawId.indexOf(':');
    if (colonIdx === -1) {
      return rawId;
    }
    return `${rawId.slice(0, colonIdx)}:***`;
  }

  /**
   * Scrub PII from a raw `error.message` before exposing it on the
   * unauthenticated `GET /jobs/health` response. BullMQ stores the
   * exception's message verbatim, so an upstream error like
   * `Stripe 503: subscription sub_abc123 for customer cus_xyz789`
   * or a TypeORM error mentioning a user UUID would otherwise leak
   * directly to anyone polling the endpoint.
   *
   * The scrub is intentionally narrow — replacing only well-known
   * identifier shapes — so the surviving message still carries the
   * triage signal on-call needs (HTTP status, error class, root
   * cause). Truncation also caps the upper bound to 240 chars so
   * a stack-trace-as-message can't ferry deep call-site detail
   * through this surface.
   *
   * Patterns scrubbed:
   *   - UUIDs (any version)            → `<uuid>`
   *   - Stripe ids (`cus_`, `sub_`,    → `<prefix>_***`
   *     `pi_`, `in_`, `seti_`,
   *     `ch_`, `cs_`, `price_`,
   *     `prod_`, `inv_`, `re_`)
   *   - Email addresses                 → `<email>`
   *   - Bare bearer tokens (40+ char    → `<token>`
   *     hex/base64 chunks)
   */
  private scrubFailureReason(raw: string | null): string | null {
    if (!raw) return raw;
    const MAX_LEN = 240;
    let out = raw.length > MAX_LEN ? `${raw.slice(0, MAX_LEN)}…` : raw;
    out = out.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<uuid>',
    );
    out = out.replace(
      /\b(cus|sub|pi|in|seti|ch|cs|price|prod|inv|re|tok|src|pm|sk|pk|whsec|rk)_[A-Za-z0-9]{6,}\b/g,
      '$1_***',
    );
    out = out.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '<email>',
    );
    // Long opaque tokens (40+ hex/base64-url chars). Heuristic — runs
    // last so it can't clobber the more specific patterns above.
    out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<token>');
    return out;
  }
}
