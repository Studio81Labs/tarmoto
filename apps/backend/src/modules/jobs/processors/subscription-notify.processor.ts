import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  SubscriptionNotificationService,
  type QueuedSubscriptionNotifyJob,
} from '../../account/subscription-notification.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

/**
 * Delivers subscription lifecycle notifications enqueued by `AccountService`.
 * The send runs in the WORKER (not the Stripe webhook handler), so
 * {@link SubscriptionNotificationService.deliver} can hold the per-rider lock
 * across the send without risking Stripe's ~20s timeout — closing the
 * check-then-send race — and only sends when the rider's current state still
 * matches the announced transition (dropping a superseded one). Send-transport
 * errors are swallowed (logged) inside `deliver`; anything else propagates so
 * BullMQ retries per the shared backoff policy.
 */
@Processor(QUEUE_NAMES.SUBSCRIPTION_NOTIFY)
export class SubscriptionNotifyProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionNotifyProcessor.name);

  constructor(private readonly notifications: SubscriptionNotificationService) {
    super();
  }

  async process(job: Job<QueuedSubscriptionNotifyJob>): Promise<void> {
    const data = job.data;
    if (!data?.userId || !data.kind) {
      throw new Error(
        `subscription-notify job missing userId/kind (got ${JSON.stringify(
          data,
        )})`,
      );
    }
    await this.notifications.deliver(data);
    this.logger.log(
      `[${job.id ?? 'no-id'}] delivered subscription '${data.kind}' notification for user ${data.userId}`,
    );
  }
}
