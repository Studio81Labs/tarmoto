import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Align the operator override tables with the v1 feature-flag catalog
 * (`docs/feature-flags.md`). The flag vocabulary itself is code-defined in
 * `@tarmoto/shared`; this migration only fixes the two override rows whose
 * KEYS changed, so stale rows don't linger:
 *
 *   - `full_road_quality_zoom` → `road_quality_full_zoom` (renamed). The
 *     launch-mode `force_on` row (seeded in 1796) and any per-user override
 *     are moved to the new key so the feature stays open pre-monetization.
 *   - `unlimited_trip_planning` is retired (superseded by the
 *     `max_active_trips` limit). Only its global `feature_states` row is
 *     dropped (a single known launch-mode seed value, restored by `down`);
 *     any per-user `user_features` rows are LEFT in place — the resolver
 *     already ignores keys outside the registry, and deleting them would
 *     irreversibly discard operator grant/revoke decisions on a rollback.
 *
 * The many NEW catalog keys (added flags/limits) need no migration: they are
 * pure registry vocabulary with no override rows and no enforcement yet.
 */
export class AlignFeatureFlagCatalog1814000000000 implements MigrationInterface {
  name = 'AlignFeatureFlagCatalog1814000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE feature_states
        SET feature = 'road_quality_full_zoom'
        WHERE feature = 'full_road_quality_zoom';
      UPDATE user_features
        SET feature = 'road_quality_full_zoom'
        WHERE feature = 'full_road_quality_zoom';

      -- Drop only the global launch-mode row for the retired flag; leave any
      -- per-user override rows (inert — the resolver ignores unknown keys —
      -- and preserved so a rollback can't lose operator decisions).
      DELETE FROM feature_states WHERE feature = 'unlimited_trip_planning';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE feature_states
        SET feature = 'full_road_quality_zoom'
        WHERE feature = 'road_quality_full_zoom';
      UPDATE user_features
        SET feature = 'full_road_quality_zoom'
        WHERE feature = 'road_quality_full_zoom';

      INSERT INTO feature_states (feature, state, reason)
      VALUES ('unlimited_trip_planning', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
      ON CONFLICT DO NOTHING;
    `);
  }
}
