import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueActiveRide1713300000000 implements MigrationInterface {
  name = 'AddUniqueActiveRide1713300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_rides_one_active_per_user
      ON rides (user_id)
      WHERE status = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_rides_one_active_per_user`,
    );
  }
}
