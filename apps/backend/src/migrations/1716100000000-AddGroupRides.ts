import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-26 — real-time group ride live location sharing.
 *
 * `group_rides` is the session record; `group_ride_members` carries
 * membership and the last-known position for the GET endpoint to
 * surface immediately after reconnect (the live channel is socket.io,
 * but a member who reconnects after a network blip needs known dots
 * before the next 1 Hz tick lands).
 *
 * The unique index on `code` is partial — only active rides
 * (`ended_at IS NULL`) collide — so a freshly ended session's six-char
 * code can be reused without us having to ramp the alphabet.
 */
export class AddGroupRides1716100000000 implements MigrationInterface {
  name = 'AddGroupRides1716100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE group_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(6) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_group_rides_owner ON group_rides(owner_id);
    `);

    // Partial unique index — active rides own the code; ended rides
    // release it. Lets a six-char code be reused without growing the
    // alphabet when an old ride has wound down.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_group_rides_active_code
        ON group_rides(code)
        WHERE ended_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE group_ride_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_ride_id UUID NOT NULL REFERENCES group_rides(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_lat DOUBLE PRECISION,
        last_lng DOUBLE PRECISION,
        last_speed DOUBLE PRECISION,
        last_heading DOUBLE PRECISION,
        last_position_at TIMESTAMPTZ,
        recent_path JSONB NOT NULL DEFAULT '[]'::jsonb
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_group_ride_members_member
        ON group_ride_members(group_ride_id, user_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_group_ride_members_user
        ON group_ride_members(user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS group_ride_members CASCADE;');
    await queryRunner.query('DROP TABLE IF EXISTS group_rides CASCADE;');
  }
}
