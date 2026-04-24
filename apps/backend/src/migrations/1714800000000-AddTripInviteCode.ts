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

    // Backfill any pre-existing rows from the same alphabet the runtime
    // allocator uses (Crockford-style base32 minus 0/O/1/I/L/U). A
    // pl/pgsql block lets us draw a fresh per-row code and retry on
    // collision against the rows already backfilled in this same loop.
    // In production this is a no-op — the trips table is empty until
    // this PR — but dev/CI seed data goes through the same path the
    // runtime would take, so the documented "easy to dictate" property
    // holds for backfilled codes too.
    await queryRunner.query(`
      DO $migration$
      DECLARE
        alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
        alphabet_len CONSTANT INT := length(alphabet);
        code_len CONSTANT INT := 8;
        target_id UUID;
        candidate TEXT;
        attempts INT;
      BEGIN
        FOR target_id IN SELECT id FROM trips WHERE invite_code IS NULL LOOP
          attempts := 0;
          LOOP
            candidate := '';
            FOR i IN 1..code_len LOOP
              candidate := candidate
                || substr(alphabet, 1 + floor(random() * alphabet_len)::int, 1);
            END LOOP;
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM trips WHERE invite_code = candidate
            );
            attempts := attempts + 1;
            IF attempts > 10 THEN
              RAISE EXCEPTION
                'AddTripInviteCode: failed to allocate a unique invite_code after 10 attempts for trip %',
                target_id;
            END IF;
          END LOOP;
          UPDATE trips SET invite_code = candidate WHERE id = target_id;
        END LOOP;
      END
      $migration$;
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
