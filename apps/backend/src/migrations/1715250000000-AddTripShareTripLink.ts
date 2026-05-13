import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #526 — let shared trip links bridge into live collaboration.
 *
 * Legacy shares remain snapshot-only (`trip_id IS NULL`). New shares minted
 * from persisted trips carry the server trip id so authenticated recipients can
 * accept the share token into membership without exposing the invite code.
 */
export class AddTripShareTripLink1715250000000 implements MigrationInterface {
  name = 'AddTripShareTripLink1715250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_shares
        ADD COLUMN trip_id UUID NULL
          REFERENCES trips(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trip_shares_trip
        ON trip_shares(trip_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_trip_shares_trip;');
    await queryRunner.query(`
      ALTER TABLE trip_shares
        DROP COLUMN IF EXISTS trip_id;
    `);
  }
}
