import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-7 — extend `trip_days` with the per-day metrics produced by the
 * multi-day trip auto-generation endpoint.
 *
 * `elevation_loss` is split out from `elevation_gain` so the per-day card
 * can render the descent total without re-summing the elevation profile
 * at request time.
 *
 * `curviness_score` and `scenic_score` are the two halves of the
 * "scenic/curvy mix" metric the AC calls out — keeping them as separate
 * columns lets the UI surface them independently and lets the generator
 * weight them differently for each option preset (best-fit / scenic /
 * fastest) without having to re-derive them on read.
 *
 * All three columns are nullable so the existing rows produced by the
 * collab/messaging migrations stay valid; the auto-generator backfills
 * them whenever it runs.
 */
export class AddTripDayGenerationColumns1715300000000 implements MigrationInterface {
  name = 'AddTripDayGenerationColumns1715300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_days
        ADD COLUMN IF NOT EXISTS elevation_loss FLOAT,
        ADD COLUMN IF NOT EXISTS curviness_score FLOAT,
        ADD COLUMN IF NOT EXISTS scenic_score FLOAT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trip_days
        DROP COLUMN IF EXISTS scenic_score,
        DROP COLUMN IF EXISTS curviness_score,
        DROP COLUMN IF EXISTS elevation_loss;
    `);
  }
}
