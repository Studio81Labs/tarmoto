import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixIsEmergencyDefault1713200000000 implements MigrationInterface {
  name = 'FixIsEmergencyDefault1713200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_contacts ALTER COLUMN is_emergency SET DEFAULT TRUE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_contacts ALTER COLUMN is_emergency SET DEFAULT FALSE`,
    );
  }
}
