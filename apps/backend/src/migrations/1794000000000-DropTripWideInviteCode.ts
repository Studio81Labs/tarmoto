import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the trip-wide invite code. Every join path now uses a
 * revocable credential: the group share link (revoke/regenerate) or a
 * PERSONAL invite code on `trip_invites` (revoked per invite). The
 * static per-trip code could never be rotated, was visible to every
 * member (including viewers), and silently survived "Revoke &
 * regenerate" — undermining the revocation story. Pre-launch, so no
 * data or client back-compat to preserve.
 */
export class DropTripWideInviteCode1794000000000 implements MigrationInterface {
  name = 'DropTripWideInviteCode1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trips DROP COLUMN IF EXISTS invite_code
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill distinct placeholder codes so the unique index can be
    // recreated; real codes were never derivable from other data.
    await queryRunner.query(`
      ALTER TABLE trips ADD COLUMN invite_code VARCHAR(12)
    `);
    await queryRunner.query(`
      UPDATE trips SET invite_code = UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 12))
    `);
    await queryRunner.query(`
      ALTER TABLE trips ALTER COLUMN invite_code SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_trips_invite_code ON trips(invite_code)
    `);
  }
}
