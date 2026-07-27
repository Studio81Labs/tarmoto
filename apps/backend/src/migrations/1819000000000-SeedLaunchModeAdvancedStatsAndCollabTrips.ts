import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch-mode seeds for the toggles + limit gated by SP1 of the feature-flag
 * enforcement rollout — `advanced_ride_stats`, `collaborative_trips`, and
 * `max_group_ride_members` — mirroring how migration 1795 seeded `gpx_export`
 * / `commuter_mode` / `group_rides`, and how 1818 seeded its limit overrides.
 *
 * `advanced_ride_stats` and `collaborative_trips` are Pro-tier toggles with a
 * free-tier default of `false`. The moment their enforcement ships, a
 * genuinely-free rider would resolve them off and lose advanced ride stats +
 * shared trip planning. The rollout ships DARK, so seed each a global
 * `force_on` override so the resolved snapshot stays permissive for everyone
 * until monetization go-live removes these rows (the same operator action
 * that clears the other 7 launch seeds).
 *
 * `max_group_ride_members` (also enforced by SP1) resolves to `0` for
 * free/pro (registry `{free:0, pro:0, premium:null}`), and `group_rides`
 * itself is already seeded `force_on` by migration 1795 — so a non-premium
 * rider CAN reach `GroupRidesService.join` today, where the owner already
 * counts as member #1 and `isWithinLimit(0, ≥1)` always fails. Without a
 * limit override this blocks the very first non-premium join the moment this
 * migration runs, which is not dark. Seed it the same `NULL` (= unlimited)
 * global override 1818 uses for its two limits, so it stays permissive too.
 */
export class SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000 implements MigrationInterface {
  name = 'SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000';

  // A marker unique to THIS migration, embedded in every reason it writes. It
  // cannot appear on a row that predates this migration, so `down()` can match
  // on it to delete ONLY rows `up()` created — even in the `ON CONFLICT DO
  // NOTHING` case where a pre-existing operator override for the same feature
  // (any reason/state) is left in place and must survive a rollback.
  private static readonly SEED_MARKER = '[seed:1819]';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { SEED_MARKER } =
      SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000;
    await queryRunner.query(`
      INSERT INTO feature_states (feature, state, reason)
      VALUES
        ('advanced_ride_stats', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live. ${SEED_MARKER}'),
        ('collaborative_trips', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live. ${SEED_MARKER}')
      ON CONFLICT (feature) DO NOTHING;
    `);
    await queryRunner.query(`
      INSERT INTO limit_states (feature, value, reason)
      VALUES
        ('max_group_ride_members', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live. ${SEED_MARKER}')
      ON CONFLICT (feature) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { SEED_MARKER } =
      SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000;
    // `up()` uses ON CONFLICT DO NOTHING, so on a feature that already had an
    // operator override it inserted nothing. Match on this migration's unique
    // SEED_MARKER (not just feature+state) so a rollback deletes ONLY the rows
    // this migration actually wrote and can never erase a pre-existing override
    // that happened to share the launch-mode state or reason text.
    await queryRunner.query(`
      DELETE FROM feature_states
      WHERE feature IN ('advanced_ride_stats', 'collaborative_trips')
        AND state = 'force_on'
        AND reason LIKE '%${SEED_MARKER}';
    `);
    await queryRunner.query(`
      DELETE FROM limit_states
      WHERE feature = 'max_group_ride_members'
        AND value IS NULL
        AND reason LIKE '%${SEED_MARKER}';
    `);
  }
}
