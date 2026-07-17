import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Align the operator override tables with the v1 feature-flag catalog
 * (`docs/feature-flags.md`). The flag vocabulary itself is code-defined in
 * `@tarmoto/shared`; the only DB change needed is a faithful key rename:
 *
 *   - `full_road_quality_zoom` → `road_quality_full_zoom` (renamed). The
 *     launch-mode `force_on` row (seeded in 1796) and any per-user override
 *     are moved to the new key — an UPDATE preserves each row's state /
 *     reason / updated_by, so an operator's prior override survives (and
 *     `down` renames it straight back). Without this the renamed flag would
 *     resolve WITHOUT its launch-mode force_on and free users would lose
 *     full-zoom access they have today.
 *
 * `unlimited_trip_planning` is retired (superseded by the `max_active_trips`
 * limit) but its override rows — global `feature_states` and per-user
 * `user_features` — are deliberately LEFT in place. The resolver ignores
 * keys outside the registry, so they are inert; deleting them would
 * irreversibly discard operator state (a global row an operator may have
 * flipped to `force_off`, plus per-user grant/revoke decisions) that a
 * rollback could not faithfully restore. A later deliberate cleanup can
 * remove them once no rollback is in play.
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
    `);
  }
}
