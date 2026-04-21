import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-55 — helpful / not-helpful voting on road reviews.
 *
 * One vote row per (user, review) pair. The unique constraint lets the
 * POST endpoint treat a repeat cast as an update: ON CONFLICT (user_id,
 * road_review_id) DO UPDATE SET is_helpful = EXCLUDED.is_helpful. When a
 * user or review is deleted, their vote rows go with them.
 */
export class AddRoadReviewVotes1714000000000 implements MigrationInterface {
  name = 'AddRoadReviewVotes1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE road_review_votes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        road_review_id UUID NOT NULL REFERENCES road_reviews(id) ON DELETE CASCADE,
        is_helpful BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idx_road_review_votes_unique UNIQUE (user_id, road_review_id)
      );

      CREATE INDEX idx_road_review_votes_review ON road_review_votes (road_review_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS road_review_votes CASCADE`);
  }
}
