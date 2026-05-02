import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-4 follow-up — adds the `photo_url` column hazard reports use to
 * surface a single attached photo (camera or library, captured at the
 * time the rider tapped Submit). Mirrors the `road_reviews.photos`
 * approach: clients upload the file via a dedicated multipart endpoint
 * which returns a public URL, then submit that URL alongside the
 * hazard create payload. Nullable — most reports come without a photo.
 */
export class AddHazardReportPhotoUrl1716600000000 implements MigrationInterface {
  name = 'AddHazardReportPhotoUrl1716600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hazard_reports" ADD COLUMN "photo_url" TEXT;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hazard_reports" DROP COLUMN IF EXISTS "photo_url";`,
    );
  }
}
