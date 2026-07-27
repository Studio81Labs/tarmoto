import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch-mode seeds for the two toggles gated by SP1 of the feature-flag
 * enforcement rollout — `advanced_ride_stats` and `collaborative_trips` —
 * mirroring how migration 1795 seeded `gpx_export` / `commuter_mode` /
 * `group_rides`.
 *
 * Both are Pro-tier toggles with a free-tier default of `false`. The moment
 * their enforcement ships, a genuinely-free rider would resolve them off and
 * lose advanced ride stats + shared trip planning. The rollout ships DARK, so
 * seed each a global `force_on` override so the resolved snapshot stays
 * permissive for everyone until monetization go-live removes these rows (the
 * same operator action that clears the other 7 launch seeds).
 *
 * `max_group_ride_members` (also enforced by SP1) is NOT seeded: it resolves to
 * premium `null` (unlimited) and only premium can join a group ride, so it is
 * inert without an override.
 */
export class SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000 implements MigrationInterface {
  name = 'SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO feature_states (feature, state, reason)
      VALUES
        ('advanced_ride_stats', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('collaborative_trips', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
      ON CONFLICT (feature) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `up()` uses ON CONFLICT DO NOTHING, so it only ever inserted the specific
    // launch-mode rows (state force_on + this reason) and left any pre-existing
    // operator override untouched. Delete only what this migration could have
    // inserted — matching state + reason — so a rollback can't erase a
    // pre-existing override it never created.
    await queryRunner.query(`
      DELETE FROM feature_states
      WHERE feature IN ('advanced_ride_stats', 'collaborative_trips')
        AND state = 'force_on'
        AND reason = 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.';
    `);
  }
}
