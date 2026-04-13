import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class InitSchema1713000000000 implements MigrationInterface {
  name = 'InitSchema1713000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemaPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'docs',
      'database',
      'schema.sql',
    );
    const sql = readFileSync(schemaPath, 'utf-8');
    await queryRunner.query(sql);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_update_road_quality ON surface_readings;
      DROP FUNCTION IF EXISTS update_road_quality();
      DROP FUNCTION IF EXISTS expire_hazards();
      DROP FUNCTION IF EXISTS find_nearby_segments(FLOAT, FLOAT, INT);
      DROP VIEW IF EXISTS v_active_hazards;
      DROP VIEW IF EXISTS v_road_quality;
      DROP TABLE IF EXISTS fun_zone_roads CASCADE;
      DROP TABLE IF EXISTS fun_zones CASCADE;
      DROP TABLE IF EXISTS commute_routes CASCADE;
      DROP TABLE IF EXISTS trip_waypoints CASCADE;
      DROP TABLE IF EXISTS trip_days CASCADE;
      DROP TABLE IF EXISTS trip_members CASCADE;
      DROP TABLE IF EXISTS trips CASCADE;
      DROP TABLE IF EXISTS road_reviews CASCADE;
      DROP TABLE IF EXISTS hazard_reports CASCADE;
      DROP TABLE IF EXISTS ride_stats CASCADE;
      DROP TABLE IF EXISTS ride_segments CASCADE;
      DROP TABLE IF EXISTS rides CASCADE;
      DROP TABLE IF EXISTS surface_readings CASCADE;
      DROP TABLE IF EXISTS road_segments CASCADE;
      DROP TABLE IF EXISTS user_contacts CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
  }
}
