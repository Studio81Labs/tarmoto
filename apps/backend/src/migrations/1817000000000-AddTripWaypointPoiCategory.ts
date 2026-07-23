import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persist semantic planner POI provenance without storing translated labels. */
export class AddTripWaypointPoiCategory1817000000000 implements MigrationInterface {
  name = 'AddTripWaypointPoiCategory1817000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_waypoints
        ADD COLUMN IF NOT EXISTS poi_category VARCHAR(30);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_waypoints
        DROP COLUMN IF EXISTS poi_category;
    `);
  }
}
