import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-9 — per-vertex elevation samples for road preview charts.
 *
 * Stores the elevation (meters above sea level) at every vertex of a
 * `road_segments.geom` LineString as a parallel `float[]` so the mobile
 * RoadPreview elevation chart can render an actual profile rather than
 * just min/max numbers. Nullable because the ingest pipeline backfills
 * lazily — segments without a profile keep returning min/max only.
 */
export class AddRoadSegmentElevationProfile1713700000000 implements MigrationInterface {
  name = 'AddRoadSegmentElevationProfile1713700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE road_segments
        ADD COLUMN elevation_profile DOUBLE PRECISION[]`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE road_segments DROP COLUMN IF EXISTS elevation_profile`,
    );
  }
}
