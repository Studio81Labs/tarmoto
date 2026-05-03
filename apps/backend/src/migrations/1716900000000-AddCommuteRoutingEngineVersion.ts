import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #361 — track which routing-engine version produced the cached
 * `route_geom` / `distance_km` / `avg_duration` on each saved commute
 * route. Without this, a routing-provider swap (OSRM → GraphHopper, or
 * a self-hosted upgrade with new exclusion semantics) would keep
 * serving stale geometry indefinitely because `needsCacheFill` only
 * checks for null. The column is nullable so legacy rows already
 * resolved against the previous engine fall through to a re-fill on
 * first read.
 */
export class AddCommuteRoutingEngineVersion1716900000000 implements MigrationInterface {
  name = 'AddCommuteRoutingEngineVersion1716900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        ADD COLUMN routing_engine_version VARCHAR(64);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        DROP COLUMN IF EXISTS routing_engine_version;
    `);
  }
}
