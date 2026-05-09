import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-37 — persist trip folders backend-side.
 *
 * Adds `trip_folders` (per-user folder rows with manual ordering) and a
 * nullable `folder_id` column on `trips` with an `ON DELETE SET NULL`
 * FK so deleting a folder leaves its trips alive (they just become
 * unfiled). The companion previously stored folder rows in localStorage
 * only — see `apps/companion/src/lib/trip-folders.ts` and US-37 in
 * `docs/specs/tarmoto-product-spec.md`.
 *
 * Forward-only. No backfill is needed: every existing trip starts with
 * `folder_id = NULL`, which is the same "unfiled" state the client UI
 * already assumes for a missing folderId.
 */
export class AddTripFolders1717700000000 implements MigrationInterface {
  name = 'AddTripFolders1717700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trip_folders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        color VARCHAR(20),
        position INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trip_folders_user_position
        ON trip_folders(user_id, position);
    `);

    await queryRunner.query(`
      ALTER TABLE trips
        ADD COLUMN folder_id UUID
          REFERENCES trip_folders(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trips_folder
        ON trips(folder_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_trips_folder;');
    await queryRunner.query(
      'ALTER TABLE trips DROP COLUMN IF EXISTS folder_id;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS trip_folders CASCADE;');
  }
}
