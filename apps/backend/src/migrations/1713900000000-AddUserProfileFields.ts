import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-59 — richer profile fields.
 *
 * `avatar_url` stores a URL to the user's profile photo (provider-hosted
 * for now; a dedicated upload flow will come with file-storage infra).
 * `bio` is a short free-text blurb shown on public rider profiles.
 * `home_region` is a human-readable region name (e.g. "Beskydy, CZ")
 * separate from the existing `home_location` Point — we keep both so the
 * map can center on a precise location while the UI can show a label
 * even when no coordinates are set.
 */
export class AddUserProfileFields1713900000000 implements MigrationInterface {
  name = 'AddUserProfileFields1713900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500)`,
    );
    await queryRunner.query(`ALTER TABLE users ADD COLUMN bio VARCHAR(500)`);
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN home_region VARCHAR(120)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS home_region`,
    );
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS bio`);
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS avatar_url`,
    );
  }
}
