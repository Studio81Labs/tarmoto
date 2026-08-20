import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clear the launch-mode global overrides — tier enforcement goes live (#1104).
 *
 * ## Product decision (2026-08-20, operator, on #1104)
 *
 * Billing is now configured on staging + production. The operator decided:
 *
 *   1. The `launch_tier` gift (`app_settings`, migration 1796) STAYS ON. New
 *      signups keep getting Pro at registration until an operator flips it
 *      off in `/admin/system-settings/launch-tier` — and that gift is a
 *      LIFETIME promise: a rider who received it keeps it after the gift is
 *      later disabled for new signups. This migration does not touch
 *      `app_settings` at all.
 *   2. The nine seeded global overrides below are cleared. Flags and limits
 *      return to registry defaults, resolved per-tier. No standing seeded
 *      overrides remain; anything situational going forward is set ad hoc
 *      through the admin feature-flag/limit UI.
 *
 * ## The nine rows this migration deletes
 *
 * `feature_states` (`force_on`):
 *   - `gpx_export`, `commuter_mode`, `group_rides`         — seeded 1795
 *   - `advanced_ride_stats`, `collaborative_trips`         — seeded 1819
 *
 * `limit_states` (`value = NULL`, i.e. unlimited):
 *   - `max_active_trips`                                   — seeded 1813
 *   - `max_trip_collaborators`, `road_quality_max_zoom`    — seeded 1818
 *   - `max_group_ride_members`                             — seeded 1819
 *
 * That is every launch seed that still resolves through the registry today.
 * It is deliberately NOT ten: `advanced_analytics` was considered for a
 * launch seed (see the #1104 thread) but shipped live with no seed instead
 * (#1167/#1218/#1219), so there is nothing to clear for it here.
 *
 * ## What this migration deliberately does NOT touch
 *
 * `full_road_quality_zoom` (seeded `force_on` by 1796) and
 * `unlimited_trip_planning` (seeded `force_on` by 1796) are both RETIRED —
 * superseded by the `road_quality_max_zoom` limit and the `max_active_trips`
 * limit respectively (see `packages/shared/src/feature-flags.ts` and
 * migration 1814). Their override rows are inert orphans the resolver
 * already ignores (it only reads keys inside `FEATURE_DEFINITIONS`), and
 * migration 1814's own comment establishes the precedent: leave inert rows
 * in place rather than deleting operator-adjacent state a rollback could
 * not restore. Removing them is unrelated cleanup, out of this issue's
 * scope.
 *
 * Also untouched: `sys_*` system switches (no launch seed; default-on
 * vocabulary, unrelated to tiers) and every per-user override in
 * `user_features` / `user_limits`.
 *
 * ## Per-feature effect on an earlybird (a rider holding the `founder`
 * grant, i.e. `grant_tier = 'pro'`)
 *
 * `resolveEntitledTier` grants the earlybird's persisted Pro tier
 * regardless of these global rows (see `entitlement.ts`), so clearing the
 * overrides does not narrow anything the tier itself already covers:
 *
 *   - `gpx_export`, `commuter_mode`, `advanced_ride_stats`,
 *     `collaborative_trips`, `max_active_trips`, `road_quality_max_zoom` —
 *     all Pro-tier grants (or Pro-tier `null`/unlimited limits). NO CHANGE.
 *   - `max_trip_collaborators` — Pro tier is `5`, not unlimited. An
 *     earlybird's collaborator cap moves from "unlimited" (launch override)
 *     to `5` (their real Pro entitlement) — a narrowing, but the tier value
 *     they are promised, not a loss of the tier itself.
 *   - `group_rides` — PREMIUM-ONLY. An earlybird holds Pro, not Premium, so
 *     this DROPS from accessible to blocked. Consistent with "lifetime Pro",
 *     not "lifetime everything": Premium-only capabilities were never part
 *     of the Pro gift.
 *   - `max_group_ride_members` — Pro tier is `0`; moot once `group_rides`
 *     itself blocks a Pro rider from the join endpoint first.
 *
 * A rider granted `premium` (operator-selected `launch_tier`) sees no
 * change on any of the nine.
 *
 * ## Idempotency, rollback, and operator-override safety
 *
 * `up()` deletes by exact seeded shape — `feature` AND `state`/`value` AND
 * `reason` AND `updated_by IS NULL` — not by `feature` alone. An operator
 * could have already touched one of these nine keys through the admin UI
 * before this migration runs (`AdminFlagsService.setGlobalState` /
 * `AdminLimitsService.setGlobalValue` update the SAME row in place and
 * always stamp `updated_by` with the admin's id) — an incident `force_off`
 * on `group_rides`, say, or a deliberately finite `max_trip_collaborators`.
 * Matching on the launch seed's exact reason text (plus the 1819 rows'
 * `[seed:1819]` marker) and `updated_by IS NULL` means a row like that is
 * indistinguishable from noise to this DELETE and survives untouched —
 * `down()` could not have recovered it either, since it only knows how to
 * re-insert the original launch-mode shape. This is the same reasoning
 * migrations 1818/1819 already apply in their own `down()`; the group_rides
 * clear also triggers the live-socket eviction sweep in
 * `EventsGateway.onApplicationBootstrap` (#1104 review) since a raw SQL
 * migration can't reach in-memory Socket.IO room state itself.
 *
 * Safe to re-run — deletes 0 rows with no error once the seeds (or an
 * operator override that happens to share the launch-mode shape) are gone.
 * `down()` re-inserts exactly the rows the four seeding migrations (1795,
 * 1813, 1818, 1819) originally wrote, verbatim reasons included, with
 * `ON CONFLICT DO NOTHING` matching their own idiom — so a rollback
 * restores dark-launch behaviour exactly.
 */
export class ClearLaunchModeOverrides1839000000000 implements MigrationInterface {
  name = 'ClearLaunchModeOverrides1839000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM feature_states
      WHERE updated_by IS NULL
        AND (
          (
            feature IN ('gpx_export', 'commuter_mode', 'group_rides')
            AND state = 'force_on'
            AND reason = 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'
          )
          OR (
            feature IN ('advanced_ride_stats', 'collaborative_trips')
            AND state = 'force_on'
            AND reason = 'Launch mode: keep pre-entitlement access open until tier enforcement goes live. [seed:1819]'
          )
        );
    `);
    await queryRunner.query(`
      DELETE FROM limit_states
      WHERE updated_by IS NULL
        AND value IS NULL
        AND (
          (
            feature IN ('max_active_trips', 'max_trip_collaborators', 'road_quality_max_zoom')
            AND reason = 'Launch mode: unlimited for everyone until tier enforcement goes live.'
          )
          OR (
            feature = 'max_group_ride_members'
            AND reason = 'Launch mode: unlimited for everyone until tier enforcement goes live. [seed:1819]'
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO feature_states (feature, state, reason)
      VALUES
        ('gpx_export', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('commuter_mode', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('group_rides', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
        ('advanced_ride_stats', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live. [seed:1819]'),
        ('collaborative_trips', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live. [seed:1819]')
      ON CONFLICT (feature) DO NOTHING;
    `);
    await queryRunner.query(`
      INSERT INTO limit_states (feature, value, reason)
      VALUES
        ('max_active_trips', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.'),
        ('max_trip_collaborators', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.'),
        ('road_quality_max_zoom', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.'),
        ('max_group_ride_members', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live. [seed:1819]')
      ON CONFLICT (feature) DO NOTHING;
    `);
  }
}
