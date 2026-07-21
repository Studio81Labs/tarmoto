import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Timestamp persisted with each resolved commute route. Commute routing
 * excludes currently active full closures, whose membership can change when
 * a time window starts or ends without any row update. A bounded cache age
 * therefore lets the service refresh closure-aware geometry periodically
 * while retaining the routing-provider cache on the hot path.
 */
export class AddCommuteRoutingCacheUpdatedAt1815000000000 implements MigrationInterface {
  name = 'AddCommuteRoutingCacheUpdatedAt1815000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        ADD COLUMN IF NOT EXISTS routing_cache_updated_at TIMESTAMPTZ;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE commute_routes
        DROP COLUMN IF EXISTS routing_cache_updated_at;
    `);
  }
}
