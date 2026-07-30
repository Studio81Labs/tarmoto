import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index the per-user rolling-24h count that backs the
 * `hazard_reports_per_day` anti-abuse cap.
 *
 * `HazardsService.create` now counts a caller's reports in the last 24h
 * (`WHERE user_id = $1 AND created_at >= $2`) before accepting a new one.
 * Expired reports are deliberately retained (deactivated, not deleted), so
 * `hazard_reports` only grows — without a matching index this count is a
 * full-table scan executed on every accepted submission and degrades as
 * crowd-sourced history accumulates.
 *
 * A composite `(user_id, created_at)` btree lets the count be an index range
 * scan. Mirrors the entity's `idx_hazard_reports_user_created`.
 */
export class AddHazardReportsUserCreatedIndex1820000000000 implements MigrationInterface {
  name = 'AddHazardReportsUserCreatedIndex1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hazard_reports_user_created
        ON hazard_reports (user_id, created_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_hazard_reports_user_created;`,
    );
  }
}
