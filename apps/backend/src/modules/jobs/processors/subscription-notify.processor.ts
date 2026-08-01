import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  SubscriptionNotificationService,
  type SubscriptionNotifyJob,
} from '../../account/subscription-notification.service.js';
import { QUEUE_NAMES } from '../jobs.constants.js';

/**
 * Delivers subscription lifecycle notifications enqueued by `AccountService`
 * under the per-rider subscription-mutation lock. The actual send runs OUTSIDE
 * that lock (here), so a slow email/push can't push the Stripe webhook past its
 * ~20s timeout. {@link SubscriptionNotificationService.deliver} re-reads the
 * rider and DROPS the send if a newer event has advanced the rider's fence past
 * the enqueued token — so a cancellation can't be delivered after a reactivation,
 * nor a confirmation after a deletion. Send-transport errors are swallowed
 * (logged) inside `deliver`; anything else propagates so BullMQ retries per the
 * shared backoff policy.
 */
@Processor(QUEUE_NAMES.SUBSCRIPTION_NOTIFY)
export class SubscriptionNotifyProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionNotifyProcessor.name);

  constructor(private readonly notifications: SubscriptionNotificationService) {
    super();
  }

  async process(job: Job<SubscriptionNotifyJob>): Promise<void> {
    const data = job.data;
    if (!data?.userId || !data.kind || typeof data.fenceToken !== 'number') {
      throw new Error(
        `subscription-notify job missing userId/kind/fenceToken (got ${JSON.stringify(
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
