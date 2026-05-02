import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #333 — scheduled severe-weather push sweep.
 *
 * Adds a per-(user, kind) ledger so the BullMQ sweep can debounce
 * duplicate `weather_alert` pushes within a single storm. The sweep
 * runs every ~15 minutes; a storm typically lasts well over that, so
 * without this table a rider would be paged repeatedly for the same
 * cell.
 *
 * Composite (user_id, kind, dispatched_at) index serves the only
 * query the processor issues: "did we already send this kind to this
 * user inside the cooldown window?". `dispatched_at DESC` keeps the
 * most recent row at the leading edge of the index for a cheap
 * `ORDER BY dispatched_at DESC LIMIT 1` lookup.
 */
export class AddWeatherAlertDispatches1716700000000 implements MigrationInterface {
  name = 'AddWeatherAlertDispatches1716700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE weather_alert_dispatches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind VARCHAR(16) NOT NULL,
        dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_weather_alert_dispatches_user_kind_time
        ON weather_alert_dispatches(user_id, kind, dispatched_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS weather_alert_dispatches CASCADE;',
    );
  }
}
