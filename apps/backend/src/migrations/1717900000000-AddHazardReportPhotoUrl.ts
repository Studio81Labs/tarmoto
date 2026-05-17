import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-4 follow-up — adds the `photo_url` column hazard reports use to
 * surface a single attached photo (camera or library, captured at the
 * time the rider tapped Submit). Mirrors the `road_reviews.photos`
 * approach: clients upload the file via a dedicated multipart endpoint
 * which returns a public URL, then submit that URL alongside the
 * hazard create payload. Nullable — most reports come without a photo.
 *
 * Originally authored as `1716600000000-AddHazardReportPhotoUrl.ts`
 * but PRs #362 and #364 both authored migrations with that exact
 * timestamp at the same time (#363); only `AddHomeRegionIndex` got
 * registered in `data-source.ts` and this one was left orphaned in
 * the tree. Re-stamped at the tail of the chain and made idempotent
 * with `IF NOT EXISTS` so environments that manually added the column
 * (the production DB likely did, hence why it never 500'd on hazard
 * create until #555 caught the read path) don't fail the migration.
 */
export class AddHazardReportPhotoUrl1717900000000 implements MigrationInterface {
  name = 'AddHazardReportPhotoUrl1717900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hazard_reports" ADD COLUMN IF NOT EXISTS "photo_url" TEXT;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hazard_reports" DROP COLUMN IF EXISTS "photo_url";`,
    );
  }
}
