import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The embeddable shared-ride widget (and its outbound-click tracking) was
 * retired with the dark theme; the counter has no remaining producer.
 */
export class DropSharedRideEmbedClickCount1812000000000 implements MigrationInterface {
  name = 'DropSharedRideEmbedClickCount1812000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared_rides
      DROP COLUMN IF EXISTS embed_click_count;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared_rides
      ADD COLUMN embed_click_count INT NOT NULL DEFAULT 0;
    `);
  }
}
