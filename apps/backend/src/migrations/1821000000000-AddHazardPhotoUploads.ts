import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pending-upload tracking table for hazard photos. A managed photo is uploaded
 * (`POST /hazards/photos`) BEFORE its report is created, so a cap-rejected or
 * abandoned submission strands the file. Rather than reconciling the whole
 * uploads directory against every photo-bearing hazard row on each sweep
 * (unbounded, and origin-dependent), the upload endpoint records the file here
 * and `create()` deletes the row once a report claims it — so the hourly sweep
 * reaps only rows older than the grace window via an indexed timestamp query.
 *
 * New empty table: the DDL is metadata-only (fast, no backfill), so there is
 * no long-held lock at bootstrap.
 */
export class AddHazardPhotoUploads1821000000000 implements MigrationInterface {
  name = 'AddHazardPhotoUploads1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hazard_photo_uploads (
        filename         TEXT PRIMARY KEY,
        user_id          UUID NOT NULL,
        uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Durable sweep claim marker (two-phase reclaim); NULL = pending.
        sweep_claimed_at TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hazard_photo_uploads_uploaded_at
        ON hazard_photo_uploads (uploaded_at)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hazard_photo_uploads_user_id
        ON hazard_photo_uploads (user_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_hazard_photo_uploads_user_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_hazard_photo_uploads_uploaded_at`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS hazard_photo_uploads`);
  }
}
