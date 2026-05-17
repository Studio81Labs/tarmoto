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
 *
 * Originally authored as `1716900000000-AddCommuteRoutingEngineVersion.ts`
 * but the timestamp collided with `1716900000000-AddBikes.ts` and only
 * the latter got registered in `data-source.ts`. The column ended up
 * on our DBs by other means (manual ALTER, or a now-removed adjacent
 * migration), but a from-scratch bootstrap would miss it and the
 * commute service would `routing_engine_version IS DISTINCT FROM
 * route.routing_engine_version` against a nonexistent column. Same
 * pattern as #555 — re-stamp at the tail, make idempotent, register.
 */
export class AddCommuteRoutingEngineVersion1718000000000 implements MigrationInterface {
  name = 'AddCommuteRoutingEngineVersion1718000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        ADD COLUMN IF NOT EXISTS routing_engine_version VARCHAR(64);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        DROP COLUMN IF EXISTS routing_engine_version;
    `);
  }
}
