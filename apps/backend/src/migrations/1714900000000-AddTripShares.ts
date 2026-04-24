import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-35 — shareable trip invite links (first slice).
 *
 * Creates `trip_shares` so the companion trip planner can generate a
 * read-only public link for a trip snapshot. The rest of the collaboration
 * feature (real-time cursors, suggestions, voting, activity log) is tracked
 * separately and will land in follow-up migrations.
 */
export class AddTripShares1714900000000 implements MigrationInterface {
  name = 'AddTripShares1714900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trip_shares (
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
      CREATE UNIQUE INDEX idx_trip_shares_token
        ON trip_shares(share_token);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trip_shares_owner
        ON trip_shares(owner_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trip_shares CASCADE;');
  }
}
