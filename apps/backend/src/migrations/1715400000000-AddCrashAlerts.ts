import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-12 — append-only audit + idempotency store for crash-alert
 * dispatch. The `id` column doubles as the idempotency key: the
 * safety service refuses to dispatch twice for the same alert UUID
 * by inserting first and short-circuiting on the unique-violation.
 *
 * `contact_results` keeps the per-recipient delivery outcome
 * (channel, provider message id, error) so retries and incident
 * triage do not have to join against a separate dispatch log.
 */
export class AddCrashAlerts1715400000000 implements MigrationInterface {
  name = 'AddCrashAlerts1715400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crash_alerts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ride_id UUID,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        speed_at_impact DOUBLE PRECISION,
        severity VARCHAR(16) NOT NULL DEFAULT 'medium',
        locale VARCHAR(16),
        contacts_notified INTEGER NOT NULL DEFAULT 0,
        contacts_total INTEGER NOT NULL DEFAULT 0,
        contact_results JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_crash_alerts_user
        ON crash_alerts(user_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS crash_alerts CASCADE;');
  }
}
