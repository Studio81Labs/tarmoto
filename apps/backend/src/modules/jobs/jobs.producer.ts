import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from './jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from './jobs.config.js';

/**
 * Delay between consecutive per-region POI import jobs (#850). A continent-scale
 * run fans out ~17 country imports; spacing them 10 minutes apart keeps a single
 * heavy country from starving the worker pool and spreads the DB write load
 * across a few hours instead of one thundering batch. The Nth region's job is
 * delayed `N * POI_IMPORT_STAGGER_MS`.
 */
export const POI_IMPORT_STAGGER_MS = 10 * 60_000;

export interface DataExportJobData {
  request_id: string;
  user_id: string;
}

/** Child-job payload for a single region's offline POI import (#850). */
export interface PoiImportRegionJobData {
  /** Upper-case ISO 3166-1 alpha-2 code of the region to import. */
  code: string;
  /**
   * Bulk source to import this region from (`osm` / `fsq`, #869) — routes the
   * job back to the matching importer. Optional on the wire so a region job
   * enqueued before this field existed still runs (the worker defaults it to
   * `osm`, the only source at the time).
   */
  source?: string;
}

export interface AccountDeletionFinalizeJobData {
  user_id: string;
}

export interface BadgesRecheckUserJobData {
  user_id: string;
}

export interface DigestWeeklyComposeJobData {
  user_id: string;
  /** ISO timestamp of the local Sunday 08:00 the digest is being sent for. */
  for_local_window: string;
}

/**
 * Internal helper for `JobsModule` processors that enqueue child jobs
 * into other queues (the dispatcher → per-user fan-out pattern).
 * Centralises the `jobId` (idempotency) and retry policy so a typo at
 * any one call site can't cause duplicate work or unbounded retries.
 *
 * Scope: in-module use only. Cross-module producers (e.g.
 * `DataExportController` enqueueing a GDPR export) inject the queue
 * directly via `@InjectQueue` to avoid a circular dependency between
 * the feature module and `JobsModule` (which already imports the
 * feature module to give its processor access to that feature's
 * service). The DEFAULT_JOB_OPTIONS constant is exported for those
 * call sites to use the same retry policy without duplicating it.
 *
 * Job data shapes (the `*JobData` interfaces above) ARE shared with
 * those external call sites — they describe the queue's wire contract,
 * not the producer's. Don't move them into a private file.
 */
@Injectable()
export class JobsProducer {
  constructor(
    @InjectQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE)
    private readonly accountDeletionFinalize: Queue<AccountDeletionFinalizeJobData>,
    @InjectQueue(QUEUE_NAMES.BADGES_RECHECK)
    private readonly badgesRecheck: Queue<BadgesRecheckUserJobData>,
    @InjectQueue(QUEUE_NAMES.DIGEST_WEEKLY)
    private readonly digestWeekly: Queue<DigestWeeklyComposeJobData>,
    @InjectQueue(QUEUE_NAMES.QUALITY_CONFLATION)
    private readonly qualityConflation: Queue,
    @InjectQueue(QUEUE_NAMES.POI_IMPORT)
    private readonly poiImport: Queue<PoiImportRegionJobData>,
  ) {}

  /**
   * Enqueue a single region's offline POI import (#850) as a staggered child of
   * the weekly dispatcher. `staggerIndex` is the region's position in the fan-out
   * (0-based); the job is delayed `staggerIndex * POI_IMPORT_STAGGER_MS` so a
   * continent-scale run spreads across hours rather than firing every country at
   * once.
   *
   * The jobId `import-region:<dispatchId>:<source>:<code>` is scoped to the
   * dispatch OCCURRENCE (`dispatchId` = the weekly dispatcher job's id — stable
   * across its retries, fresh each week) AND the source, so a dispatch that
   * retries after enqueuing some regions re-enqueues them idempotently (BullMQ
   * ignores a duplicate jobId) instead of doubling the heavy imports, while the
   * same country from two sources (OSM + FSQ) stays two distinct jobs. Next
   * week's dispatch — a new occurrence — still enqueues a fresh run.
   * `attempts: 3` (a heavy region import is retried a few times, then waits for
   * next week).
   */
  async enqueuePoiImportRegion(
    source: string,
    code: string,
    staggerIndex: number,
    dispatchId: string,
  ): Promise<void> {
    await this.poiImport.add(
      JOB_NAMES.POI_IMPORT_REGION,
      { source, code },
      {
        ...DEFAULT_JOB_OPTIONS,
        // BullMQ reserves `:` as its Redis-key delimiter and scheduler `job.id`s
        // contain colons (`repeat:<hash>:<ts>`), so strip them from the jobId.
        jobId:
          `${JOB_NAMES.POI_IMPORT_REGION}:${dispatchId}:${source}:${code}`.replace(
            /:/g,
            '_',
          ),
        attempts: 3,
        delay: staggerIndex * POI_IMPORT_STAGGER_MS,
      },
    );
  }

  /**
   * Enqueue a road-quality conflation run (#779). Enqueued by the OSM import
   * processor as a **success-continuation**, so it never runs on a partial or
   * failed import snapshot — an independent cron could fire the 02:00 job while
   * the 01:00 import was still running or had failed, baking stale/mismatched
   * `smoothness` into the derived extract. No jobId: each successful import
   * enqueues a fresh run (imports are weekly, so there's nothing to dedupe). The
   * conflation processor itself no-ops when the job is disabled.
   */
  async enqueueQualityConflation(): Promise<void> {
    await this.qualityConflation.add(
      JOB_NAMES.QUALITY_CONFLATION_RUN,
      {},
      { ...DEFAULT_JOB_OPTIONS },
    );
  }

  /**
   * Enqueue a per-user account-deletion finalize. Idempotent on
   * `user_id` — the daily sweep can re-enqueue on each tick safely
   * because BullMQ deduplicates by jobId. Failed jobs evict via the
   * 24h `age` cap on `removeOnFail` (see `DEFAULT_JOB_OPTIONS`), so
   * a finalize that exhausts its retry chain doesn't permanently
   * strand the user — the next daily sweep re-enqueues fresh.
   */
  async enqueueAccountDeletionFinalize(
    data: AccountDeletionFinalizeJobData,
  ): Promise<void> {
    await this.accountDeletionFinalize.add(
      JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER,
      data,
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `account-deletion-finalize:${data.user_id}`,
      },
    );
  }

  /**
   * Enqueue a badge recheck for a single user. Idempotent on user_id
   * — duplicate enqueues from concurrent activity sources collapse
   * into one job for the next worker pass.
   */
  async enqueueBadgesRecheckUser(
    data: BadgesRecheckUserJobData,
  ): Promise<void> {
    await this.badgesRecheck.add(JOB_NAMES.BADGES_RECHECK_USER, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `badges-recheck:${data.user_id}`,
    });
  }

  /**
   * Enqueue a per-user weekly-digest compose job. Idempotent on
   * `user_id + for_local_window` so the hourly dispatcher can't
   * accidentally double-send if it runs twice for the same local
   * Sunday window.
   */
  async enqueueDigestWeeklyCompose(
    data: DigestWeeklyComposeJobData,
  ): Promise<void> {
    await this.digestWeekly.add(JOB_NAMES.DIGEST_WEEKLY_COMPOSE, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `digest-weekly:${data.user_id}:${data.for_local_window}`,
    });
  }
}
