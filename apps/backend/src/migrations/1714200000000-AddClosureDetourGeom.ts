import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-40 — construction-zone detours.
 *
 * Adds the optional `detour_geom` LineString to `road_closures`. Only
 * roadworks closures carry a detour; the service enforces that invariant
 * on write. Indexed with GIST so future "detours near me" queries stay
 * cheap without a second table.
 */
export class AddClosureDetourGeom1714200000000 implements MigrationInterface {
  name = 'AddClosureDetourGeom1714200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_closures
        ADD COLUMN detour_geom GEOMETRY(LineString, 4326);

      CREATE INDEX idx_road_closures_detour_geom
        ON road_closures USING GIST (detour_geom);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_road_closures_detour_geom;
      ALTER TABLE road_closures DROP COLUMN IF EXISTS detour_geom;
    `);
  }
}
