import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-rider NOTIFICATION GENERATION — a monotonic counter that increments once
 * per subscription lifecycle transition that enqueues a notification
 * (confirmation/cancellation email, billing-failed push).
 *
 * The durable notification queue (`subscription.notify`) delivers OUT of the
 * per-rider lock, so a notification can be superseded before it is sent. Gating
 * on the coarse current STATE alone can't tell an ABA transition apart: if Pro
 * activation A queues a confirmation, the rider cancels, then re-activates Pro
 * before A drains, A's job still matches the (active, pro) state and would be
 * delivered with A's stale renewal date — plus the re-activation's own job — a
 * duplicate. The `subscription_lock_fence` can't serve as the discriminator: it
 * is bumped by EVERY webhook (including same-state redeliveries), so it would
 * wrongly drop a still-valid notification.
 *
 * This counter increments ONLY when a real transition enqueues a notification
 * (in `AccountService`, under the per-rider lock). Each job carries the
 * generation it was created for; the consumer delivers only when the row's
 * current generation still equals it (AND the announced state still holds), so an
 * ABA re-activation gets a distinct generation and the stale earlier job is
 * dropped, while a benign same-state redelivery (no enqueue → no increment) keeps
 * matching.
 *
 * `NOT NULL DEFAULT 0` — riders with no transitions sit at 0 (no jobs reference
 * them); the IAP/notification feature ships dark, so no backfill is needed.
 */
export class AddSubscriptionNotifyGeneration1828000000000 implements MigrationInterface {
  name = 'AddSubscriptionNotifyGeneration1828000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         ADD COLUMN subscription_notify_generation BIGINT NOT NULL DEFAULT 0;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS subscription_notify_generation;`,
    );
  }
}
