import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from './jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from './jobs.config.js';

export interface DataExportJobData {
  request_id: string;
  user_id: string;
}

export interface AccountDeletionFinalizeJobData {
  user_id: string;
}

export interface PushNotificationJobData {
  user_id: string;
  device_token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
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
 * Typed producer for every queue the backend publishes to. Centralised
 * so:
 *   - call sites import a single service and never see `bullmq`;
 *   - `jobId` (idempotency) and retry policy stay in one place,
 *     avoiding the very-easy-to-forget "did we set jobId?" trap that
 *     causes duplicate work across retries;
 *   - a future move to a different queue runner (e.g. SQS for AWS
 *     deploys) only needs to swap this service.
 */
@Injectable()
export class JobsProducer {
  constructor(
    @InjectQueue(QUEUE_NAMES.DATA_EXPORT)
    private readonly dataExport: Queue<DataExportJobData>,
    @InjectQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE)
    private readonly accountDeletionFinalize: Queue<AccountDeletionFinalizeJobData>,
    @InjectQueue(QUEUE_NAMES.PUSH_NOTIFICATION)
    private readonly pushNotification: Queue<PushNotificationJobData>,
    @InjectQueue(QUEUE_NAMES.BADGES_RECHECK)
    private readonly badgesRecheck: Queue<BadgesRecheckUserJobData>,
    @InjectQueue(QUEUE_NAMES.DIGEST_WEEKLY)
    private readonly digestWeekly: Queue<DigestWeeklyComposeJobData>,
  ) {}

  /**
   * Enqueue a GDPR data export. Idempotent on `request_id` so retried
   * HTTP calls don't double-process.
   */
  async enqueueDataExport(data: DataExportJobData): Promise<void> {
    await this.dataExport.add(JOB_NAMES.DATA_EXPORT_PROCESS, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `data-export:${data.request_id}`,
    });
  }

  /**
   * Enqueue a per-user account-deletion finalize. Idempotent on
   * `user_id` — the daily sweep can re-enqueue on each tick safely
   * because BullMQ deduplicates by jobId until the job finishes (or
   * is cleaned up by `removeOnComplete`).
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
   * Enqueue a single push-notification dispatch. No jobId is set —
   * push messages are inherently per-event and callers commonly
   * publish multiple messages per user (e.g. one per group ride
   * member). Callers that DO need dedupe should pass their own jobId
   * via the lower-level queue.
   */
  async enqueuePushNotification(data: PushNotificationJobData): Promise<void> {
    await this.pushNotification.add(
      JOB_NAMES.PUSH_NOTIFICATION_SEND,
      data,
      DEFAULT_JOB_OPTIONS,
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
