import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-50 — shareable read-only personal road map.
 *
 * Mirrors `trip_shares` (US-35) so the companion road-map page can
 * generate a public link that renders the rider's exploration snapshot
 * without authentication.
 */
export class AddMapShares1716000000000 implements MigrationInterface {
  name = 'AddMapShares1716000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE map_shares (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        share_token VARCHAR(32) NOT NULL,
        title VARCHAR(200) NOT NULL,
        snapshot JSONB NOT NULL,
        view_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_map_shares_token
        ON map_shares(share_token);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_map_shares_owner
        ON map_shares(owner_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS map_shares CASCADE;');
  }
}
