import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-53 — length-weighted curviness aggregate on rides so the community
 * feed can filter and sort by how twisty the ride actually was.
 *
 * `road_segments.curviness_score` is backend-owned; per-ride aggregation
 * therefore lives here rather than on the mobile upload. The column is
 * nullable because a ride can be created before any segments have been
 * snapped to the road network, and the sort paths use `NULLS LAST` so
 * those rides sink instead of dominating either extreme.
 *
 * The index is `DESC NULLS LAST` to match the `curviest` sort direction
 * on `GET /rides/community`; Postgres can still scan it backwards for
 * the (currently unused) `straightest` direction if one lands later.
 *
 * Backfill uses length-weighted averaging (not plain `AVG`) so that a
 * long twisty stretch dominates a short straight connector in the same
 * ride, matching the intuition the sort is supposed to surface. Rides
 * whose segments all have `length_m = 0` (degenerate) land as NULL.
 */
export class AddRideAvgCurviness1714400000000 implements MigrationInterface {
  name = 'AddRideAvgCurviness1714400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS avg_curviness FLOAT;

      CREATE INDEX idx_rides_avg_curviness
        ON rides (avg_curviness DESC NULLS LAST);

      UPDATE rides r
      SET avg_curviness = sub.weighted_avg
      FROM (
        SELECT
          rseg.ride_id,
          CASE
            WHEN SUM(rs.length_m) > 0
              THEN SUM(rs.curviness_score * rs.length_m) / SUM(rs.length_m)
            ELSE NULL
          END AS weighted_avg
        FROM ride_segments rseg
        JOIN road_segments rs ON rs.id = rseg.road_segment_id
        GROUP BY rseg.ride_id
      ) AS sub
      WHERE r.id = sub.ride_id;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_rides_avg_curviness;
      ALTER TABLE rides DROP COLUMN IF EXISTS avg_curviness;
    `);
  }
}
