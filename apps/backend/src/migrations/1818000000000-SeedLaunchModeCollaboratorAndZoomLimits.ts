import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch-mode seeds for the two numeric limits gated by this rollout —
 * `max_trip_collaborators` and `road_quality_max_zoom` — mirroring how
 * 1813 seeded `max_active_trips`.
 *
 * Without a global `limit_states` override these keys resolve to their
 * free-tier catalog DEFAULTS (`max_trip_collaborators = 0`,
 * `road_quality_max_zoom = 12`) the moment their enforcement ships — the
 * invite/join cap would immediately block free owners and the map overlay
 * would clamp free riders. The rollout ships DARK, so seed each a `NULL`
 * (= unlimited) global override so the resolved snapshot stays permissive
 * for everyone until monetization go-live removes these rows.
 */
export class SeedLaunchModeCollaboratorAndZoomLimits1818000000000 implements MigrationInterface {
  name = 'SeedLaunchModeCollaboratorAndZoomLimits1818000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO limit_states (feature, value, reason)
      VALUES
        ('max_trip_collaborators', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.'),
        ('road_quality_max_zoom', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.')
      ON CONFLICT (feature) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `up()` uses ON CONFLICT DO NOTHING, so it only ever inserted the specific
    // launch-mode rows (value NULL + this reason) and left any pre-existing
    // operator override untouched. Delete only what this migration could have
    // inserted — matching value + reason — so a rollback can't erase a
    // pre-existing finite/null override it never created.
    await queryRunner.query(`
      DELETE FROM limit_states
      WHERE feature IN ('max_trip_collaborators', 'road_quality_max_zoom')
        AND value IS NULL
        AND reason = 'Launch mode: unlimited for everyone until tier enforcement goes live.';
    `);
  }
}
