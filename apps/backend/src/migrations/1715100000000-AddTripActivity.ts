import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-35 AC6 — activity log on top of the suggestions + voting surface
 * shipped by `AddTripCollaboration1715000000000`.
 *
 * `trip_activity` is an append-only audit feed keyed by trip. The
 * `action` column is a stable snake_case discriminator ("member_joined",
 * "suggestion_created", "suggestion_voted", etc.) and `payload` carries
 * action-specific structured detail as JSONB so the companion can render
 * a single unified timeline without having to join against every
 * feature's table.
 */
export class AddTripActivity1715100000000 implements MigrationInterface {
  name = 'AddTripActivity1715100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trip_activity (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trip_activity_trip
        ON trip_activity(trip_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trip_activity CASCADE;');
  }
}
