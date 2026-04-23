import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-60 / #82 — persist Stripe billing linkage on user accounts.
 *
 * Stores Stripe customer + subscription ids plus the last known subscription
 * state so the companion account page can render live plan details and webhook
 * events can reconcile state without ad-hoc JSON blobs.
 */
export class AddStripeBillingToUsers1714600000000 implements MigrationInterface {
  name = 'AddStripeBillingToUsers1714600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN stripe_customer_id VARCHAR(255),
      ADD COLUMN stripe_subscription_id VARCHAR(255),
      ADD COLUMN subscription_tier VARCHAR(20) NOT NULL DEFAULT 'free',
      ADD COLUMN subscription_status VARCHAR(20) NOT NULL DEFAULT 'canceled',
      ADD COLUMN subscription_cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN subscription_current_period_end TIMESTAMPTZ,
      ADD COLUMN billing_trial_used_at TIMESTAMPTZ;

      CREATE UNIQUE INDEX idx_users_stripe_customer_id
        ON users (stripe_customer_id)
        WHERE stripe_customer_id IS NOT NULL;

      CREATE UNIQUE INDEX idx_users_stripe_subscription_id
        ON users (stripe_subscription_id)
        WHERE stripe_subscription_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_users_stripe_subscription_id;
      DROP INDEX IF EXISTS idx_users_stripe_customer_id;

      ALTER TABLE users
      DROP COLUMN IF EXISTS billing_trial_used_at,
      DROP COLUMN IF EXISTS subscription_current_period_end,
      DROP COLUMN IF EXISTS subscription_cancel_at_period_end,
      DROP COLUMN IF EXISTS subscription_status,
      DROP COLUMN IF EXISTS subscription_tier,
      DROP COLUMN IF EXISTS stripe_subscription_id,
      DROP COLUMN IF EXISTS stripe_customer_id;
    `);
  }
}
