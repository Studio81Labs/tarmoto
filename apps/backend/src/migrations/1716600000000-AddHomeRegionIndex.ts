import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functional index on the trimmed/lower-cased `home_region` so the regional
 * leaderboard endpoint (#340) can apply its case-insensitive equality filter
 * without a full users scan once the rider count grows past a few thousand.
 *
 * Mirrors the comparison used by the leaderboards service:
 *   `LOWER(TRIM(home_region)) = LOWER(TRIM(:region))`
 *
 * Partial index (`WHERE home_region IS NOT NULL`) keeps the index small —
 * riders without a region don't need to participate in the lookup.
 */
export class AddHomeRegionIndex1716600000000 implements MigrationInterface {
  name = 'AddHomeRegionIndex1716600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_home_region_normalized
        ON users (LOWER(TRIM(home_region)))
        WHERE home_region IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_users_home_region_normalized;',
    );
  }
}
