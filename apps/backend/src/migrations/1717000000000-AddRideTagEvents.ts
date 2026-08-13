import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Research issue #7 — store rider-asserted surface labels captured
 * during an active ride.
 *
 *   - `ride_tag_events` keeps the raw taps verbatim (audit / re-label).
 *   - `surface_readings.rider_surface_label` / `.rider_quality_label`
 *     hold the per-window join produced by `SensorService.processUpload`
 *     so research queries can train against rider ground truth without
 *     re-running the join.
 */
export class AddRideTagEvents1717000000000 implements MigrationInterface {
  name = 'AddRideTagEvents1717000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ride_tag_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        t BIGINT NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        label VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ride_tag_events_ride_t ON ride_tag_events(ride_id, t)
    `);
    // Powers two user-scoped paths that would otherwise full-scan once
    // the table grows:
    //   - daily retention sweep (`user_id = ANY($1) AND t < $2`)
    //   - GDPR data export (`user_id = $1`)
    // Composite `(user_id, t)` covers both — the export ignores `t` and
    // PG'll just use the leading `user_id` prefix, while the sweep uses
    // the full key.
    await queryRunner.query(`
      CREATE INDEX idx_ride_tag_events_user_t ON ride_tag_events(user_id, t)
    `);
    await queryRunner.query(`
      ALTER TABLE surface_readings
        ADD COLUMN IF NOT EXISTS rider_surface_label VARCHAR(32),
        ADD COLUMN IF NOT EXISTS rider_quality_label VARCHAR(20)
    `);
    // Partial index — most surface_readings rows will have NULL rider
    // labels (rides without active tagging), so a partial index on the
    // labelled subset keeps the index small while still accelerating
    // research queries that filter by `rider_surface_label IS NOT NULL`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_surface_readings_rider_label
        ON surface_readings(rider_surface_label)
        WHERE rider_surface_label IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_surface_readings_rider_label`,
    );
    await queryRunner.query(`
      ALTER TABLE surface_readings
        DROP COLUMN IF EXISTS rider_surface_label,
        DROP COLUMN IF EXISTS rider_quality_label
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_tag_events`);
  }
}
