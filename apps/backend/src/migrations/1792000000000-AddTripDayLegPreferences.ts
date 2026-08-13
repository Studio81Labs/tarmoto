import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR #844 — persist per-leg road-character overrides with their day.
 *
 * `PUT /trips/:id/route` re-routes a day leg by leg when the payload
 * carries `leg_preferences` (revision 3 §C), but without storing them the
 * preferences lived only in that one request: the planner reloaded the
 * trip with every leg "inherited", and the NEXT save re-routed the
 * rider-approved custom-leg geometry with the trip-wide preference.
 *
 * One value per consecutive routing-waypoint pair (start/via/end order),
 * from the routing preference vocabulary. NULL = no overrides for the day
 * (the common case), matching the request contract where the field is
 * omitted unless some leg differs from inherit.
 */
export class AddTripDayLegPreferences1792000000000 implements MigrationInterface {
  name = 'AddTripDayLegPreferences1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_days
        ADD COLUMN IF NOT EXISTS leg_preferences jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_days
        DROP COLUMN leg_preferences
    `);
  }
}
