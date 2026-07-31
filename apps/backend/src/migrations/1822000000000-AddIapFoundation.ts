import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IAP P0 foundation — native in-app-purchase support alongside Stripe.
 *
 * Adds provider + store-identity columns to `users` (nullable; each store id
 * is UNIQUE where present so a given Apple/Google purchase can only ever
 * link to one account), a transactional inbox
 * (`processed_store_notifications`) for idempotent Apple/Google webhook
 * processing with lease-based locking and dead-lettering, and a durable
 * work-item table (`store_billing_reconciliations`) for cases that need
 * manual or async follow-up (rejected ineligible trials, cross-provider
 * exclusivity conflicts, failed cancellations on account deletion).
 */
export class AddIapFoundation1822000000000 implements MigrationInterface {
  name = 'AddIapFoundation1822000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- users: provider + store ids (nullable; UNIQUE partial) ---
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN subscription_provider VARCHAR(16)
          CONSTRAINT users_subscription_provider_check
          CHECK (subscription_provider IN ('stripe','apple','google')),
        ADD COLUMN apple_original_transaction_id VARCHAR(255),
        ADD COLUMN google_purchase_token VARCHAR(1024);
    `);
    await queryRunner.query(`
      UPDATE users SET subscription_provider = 'stripe'
      WHERE stripe_subscription_id IS NOT NULL;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_apple_original_transaction_id
         ON users (apple_original_transaction_id)
         WHERE apple_original_transaction_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_users_google_purchase_token
         ON users (google_purchase_token)
         WHERE google_purchase_token IS NOT NULL;`,
    );

    // --- processed_store_notifications (transactional inbox) ---
    await queryRunner.query(`
      CREATE TABLE processed_store_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider VARCHAR(16) NOT NULL
          CONSTRAINT psn_provider_check CHECK (provider IN ('apple','google')),
        notification_id VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CONSTRAINT psn_status_check
          CHECK (status IN ('pending','completed','dead_letter')),
        event_type VARCHAR(64),
        payload JSONB,
        locked_by VARCHAR(128),
        lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 10,
        failure_class VARCHAR(16)
          CONSTRAINT psn_failure_class_check
          CHECK (failure_class IN ('transient','permanent')),
        dead_letter_reason VARCHAR(32)
          CONSTRAINT psn_dl_reason_check
          CHECK (dead_letter_reason IN ('permanent_reject','corrupt_context')),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        dead_lettered_at TIMESTAMPTZ,
        CONSTRAINT uq_psn_provider_notification
          UNIQUE (provider, notification_id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_psn_status_lease
         ON processed_store_notifications (status, lease_expires_at);`,
    );

    // --- store_billing_reconciliations (durable work items) ---
    await queryRunner.query(`
      CREATE TABLE store_billing_reconciliations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider VARCHAR(16) NOT NULL
          CONSTRAINT sbr_provider_check
          CHECK (provider IN ('stripe','apple','google')),
        apple_original_transaction_id VARCHAR(255),
        google_purchase_token VARCHAR(1024),
        stripe_subscription_id VARCHAR(255),
        reason VARCHAR(48) NOT NULL
          CONSTRAINT sbr_reason_check CHECK (reason IN
            ('ineligible_trial_rejected','exclusivity_conflict','deletion_cancel_failed')),
        status VARCHAR(16) NOT NULL DEFAULT 'open'
          CONSTRAINT sbr_status_check CHECK (status IN ('open','resolved')),
        resolution VARCHAR(32)
          CONSTRAINT sbr_resolution_check CHECK (resolution IN
            ('rider_canceled','refunded','expired','server_canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_sbr_status_reason
         ON store_billing_reconciliations (status, reason);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_sbr_user ON store_billing_reconciliations (user_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS store_billing_reconciliations;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS processed_store_notifications;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_google_purchase_token;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_users_apple_original_transaction_id;`,
    );
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS google_purchase_token,
        DROP COLUMN IF EXISTS apple_original_transaction_id,
        DROP COLUMN IF EXISTS subscription_provider;
    `);
  }
}
