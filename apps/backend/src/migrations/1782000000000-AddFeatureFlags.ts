import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFeatureFlags1782000000000 implements MigrationInterface {
  name = 'AddFeatureFlags1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE feature_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(128) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        description VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_feature_flags_key ON feature_flags (key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS feature_flags CASCADE;`);
  }
}
