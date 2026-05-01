import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../jobs.constants.js';
import type { PushNotificationJobData } from '../jobs.producer.js';

export interface PushNotificationResult {
  status: 'queued-for-provider' | 'noop';
  message?: string;
}

/**
 * Stub processor — no FCM/APNS provider is wired yet (a separate push
 * issue lands the actual provider). The queue exists today so:
 *
 *   - call sites can already enqueue `push.send` jobs for events like
 *     hazard alerts and group-ride updates;
 *   - the retry/backoff and health endpoint surface real data once
 *     the provider lands;
 *   - swapping the stub for an FCM/APNS dispatcher is a one-file
 *     change with no producer-side migration.
 *
 * Until the provider lands the processor logs the would-be dispatch
 * and returns `noop`. It does NOT throw so existing producers don't
 * see retry storms in the meantime.
 */
@Processor(QUEUE_NAMES.PUSH_NOTIFICATION, {
  concurrency: 8,
})
export class PushNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(PushNotificationProcessor.name);

  // eslint-disable-next-line @typescript-eslint/require-await -- stub; real provider lands later
  async process(
    job: Job<PushNotificationJobData>,
  ): Promise<PushNotificationResult> {
    const { user_id, device_token, title } = job.data;
    this.logger.log(
      `[${job.id ?? 'no-id'}] push stub — would send "${title}" ` +
        `to user=${user_id} token=${this.redactToken(device_token)}. ` +
        `No provider configured.`,
    );
    return {
      status: 'noop',
      message: 'No push provider configured',
    };
  }

  /** Redact all but the last 4 chars so logs don't echo full device tokens. */
  private redactToken(token: string): string {
    if (!token || token.length <= 4) return '****';
    return `${'*'.repeat(token.length - 4)}${token.slice(-4)}`;
  }
}
