import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-64 (issue #478) — finish the bike management contract.
 *
 *   - `bikes.icon`  — short slug for the rider-picked icon (mobile / web
 *      pick from a fixed set; we don't constrain the value here so new
 *      icons can ship without a migration).
 *   - `bikes.notes` — free-form notes (gearing changes, mods, service
 *      reminders).
 *   - `rides.bike_id` — bike used for the ride. Nullable because legacy
 *     rides predate this feature and `ON DELETE SET NULL` keeps history
 *     intact when a rider deletes a bike from their garage.
 */
export class AddBikeNotesIconAndRideBikeId1717100000000 implements MigrationInterface {
  name = 'AddBikeNotesIconAndRideBikeId1717100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE bikes
        ADD COLUMN IF NOT EXISTS icon VARCHAR(32),
        ADD COLUMN IF NOT EXISTS notes TEXT
    `);

    await queryRunner.query(`
      ALTER TABLE rides
        ADD COLUMN IF NOT EXISTS bike_id UUID REFERENCES bikes(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_rides_bike ON rides(bike_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_rides_bike`);
    await queryRunner.query(`ALTER TABLE rides DROP COLUMN IF EXISTS bike_id`);
    await queryRunner.query(`
      ALTER TABLE bikes
        DROP COLUMN IF EXISTS notes,
        DROP COLUMN IF EXISTS icon
    `);
  }
}
