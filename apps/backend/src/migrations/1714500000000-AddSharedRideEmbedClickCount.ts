import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-58 — route embed analytics.
 *
 * Adds an outbound click counter so embeddable route widgets can report how
 * many readers clicked through to the full Tarmoto ride page.
 */
export class AddSharedRideEmbedClickCount1714500000000 implements MigrationInterface {
  name = 'AddSharedRideEmbedClickCount1714500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared_rides
      ADD COLUMN embed_click_count INT NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared_rides
      DROP COLUMN IF EXISTS embed_click_count;
    `);
  }
}
