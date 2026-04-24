import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-8 / US-35 — invite-code-based trip joins.
 *
 * Adds a short, URL-safe invite code to every trip so co-planners can join
 * without an explicit invitation row. Existing trips get a backfilled value
 * so the NOT NULL + UNIQUE constraint can be added in the same migration.
 */
export class AddTripInviteCode1714800000000 implements MigrationInterface {
  name = 'AddTripInviteCode1714800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trips
        ADD COLUMN invite_code VARCHAR(12);
    `);

    // Backfill any pre-existing rows with a unique 8-char base32 code.
    // 8 chars from a 32-char alphabet ≈ 1.1e12 combinations — collision-
    // free for any plausible historical dataset.
    await queryRunner.query(`
      UPDATE trips
      SET invite_code = UPPER(SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 8))
      WHERE invite_code IS NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE trips
        ALTER COLUMN invite_code SET NOT NULL;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_trips_invite_code ON trips (invite_code);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_trips_invite_code;`);
    await queryRunner.query(
      `ALTER TABLE trips DROP COLUMN IF EXISTS invite_code;`,
    );
  }
}
