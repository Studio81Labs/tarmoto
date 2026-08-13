import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-8 — collaborative trip planning (remaining scope).
 *
 * Adds the three tables the trip-collab controller needs so co-planners
 * can suggest segments, vote on them, and chat inside a trip. Sized
 * deliberately: no per-row perms rows, no soft-deletes, no threading —
 * membership checks + owner-wins deletes are handled in the service
 * layer to keep the schema small.
 */
export class AddTripCollaboration1715000000000 implements MigrationInterface {
  name = 'AddTripCollaboration1715000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trip_suggestions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        trip_day_id UUID REFERENCES trip_days(id) ON DELETE CASCADE,
        suggested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        road_segment_id UUID REFERENCES road_segments(id) ON DELETE SET NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        location GEOMETRY(Point, 4326),
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT trip_suggestions_status_chk
          CHECK (status IN ('open', 'accepted', 'rejected'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_trip_suggestions_trip
        ON trip_suggestions(trip_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_trip_suggestions_day
        ON trip_suggestions(trip_day_id)
        WHERE trip_day_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_trip_suggestions_trip_status
        ON trip_suggestions(trip_id, status);
    `);

    await queryRunner.query(`
      CREATE TABLE trip_suggestion_votes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        suggestion_id UUID NOT NULL REFERENCES trip_suggestions(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote VARCHAR(4) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT trip_suggestion_votes_vote_chk
          CHECK (vote IN ('up', 'down'))
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_trip_suggestion_votes_member
        ON trip_suggestion_votes(suggestion_id, user_id);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trip_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Descending on `created_at` so the "load newest page" query — the
    // dominant read pattern for chat — walks the index in forward
    // direction instead of performing a backwards scan.
    await queryRunner.query(`
      CREATE INDEX idx_trip_messages_trip_created
        ON trip_messages(trip_id, created_at DESC, id DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trip_messages CASCADE;');
    await queryRunner.query(
      'DROP TABLE IF EXISTS trip_suggestion_votes CASCADE;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS trip_suggestions CASCADE;');
  }
}
