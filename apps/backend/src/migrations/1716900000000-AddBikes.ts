import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBikes1716900000000 implements MigrationInterface {
  name = 'AddBikes1716900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE bikes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        make VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        year SMALLINT,
        is_active BOOLEAN NOT NULL DEFAULT false,
        photo_url VARCHAR(2048),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_bikes_user ON bikes(user_id)
    `);
    // Enforce at most one active bike per user.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_bikes_user_active ON bikes(user_id)
      WHERE is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS bikes`);
  }
}
