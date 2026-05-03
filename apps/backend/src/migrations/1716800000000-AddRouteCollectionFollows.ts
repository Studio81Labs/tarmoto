import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-56 follow/save — viewer-facing follow relationship for route collections.
 *
 * The unique (`user_id`, `collection_id`) constraint makes the follow
 * idempotent: duplicate POSTs collapse to the same row, so the service can
 * read-then-no-op without racing against another tab or retry. Both FKs
 * cascade-delete on user/collection removal so account deletion (US-62) and
 * collection deletion clean up follow rows without an application-level
 * sweep.
 */
export class AddRouteCollectionFollows1716800000000 implements MigrationInterface {
  name = 'AddRouteCollectionFollows1716800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE route_collection_follows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        collection_id UUID NOT NULL REFERENCES route_collections(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_route_collection_follows_user_collection
          UNIQUE (user_id, collection_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collection_follows_user
        ON route_collection_follows(user_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_route_collection_follows_collection
        ON route_collection_follows(collection_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS route_collection_follows CASCADE;',
    );
  }
}
