import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPasswordHash1713100000000 implements MigrationInterface {
  name = 'AddPasswordHash1713100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT '';
    `);
    // Remove the default after adding the column (it's only there for existing rows)
    await queryRunner.query(`
      ALTER TABLE users ALTER COLUMN password_hash DROP DEFAULT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN password_hash`);
  }
}
