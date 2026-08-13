import { NotFoundException } from '@nestjs/common';
import { FeatureResolver } from './feature-resolver.service.js';
import { ENTITLEMENT_SELECT } from '../account/entitlement.js';

function makeResolver({
  user = { id: 'u1', subscription_tier: 'free' },
  overrides = [] as Array<{ feature: string; enabled: boolean }>,
  states = [] as Array<{ feature: string; state: string }>,
  userLimits = [] as Array<{ feature: string; value: number | null }>,
  limitStates = [] as Array<{ feature: string; value: number | null }>,
} = {}) {
  const users = { findOne: jest.fn().mockResolvedValue(user) };
  const userFeatures = { find: jest.fn().mockResolvedValue(overrides) };
  const featureStates = { find: jest.fn().mockResolvedValue(states) };
  const userLimitsRepo = { find: jest.fn().mockResolvedValue(userLimits) };
  const limitStatesRepo = { find: jest.fn().mockResolvedValue(limitStates) };
  return {
    resolver: new FeatureResolver(
      users as never,
      userFeatures as never,
      featureStates as never,
      userLimitsRepo as never,
      limitStatesRepo as never,
    ),
    users,
    userFeatures,
    featureStates,
    userLimits: userLimitsRepo,
    limitStates: limitStatesRepo,
  };
}

describe('FeatureResolver', () => {
  it('resolveForUser() resolves free-tier grants only for a free user', async () => {
    const { resolver } = makeResolver();
    await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
      basic_navigation: true,
      hazard_alerts: true,
      gpx_export: false,
      offline_maps: false,
      group_rides: false,
    });
  });

  it('resolveForUser() grants pro-tier (mid) features', async () => {
    const { resolver } = makeResolver({
      user: { id: 'u1', subscription_tier: 'pro' },
    });
    await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
      gpx_export: true,
      commuter_mode: true,
      offline_maps: true,
      group_rides: false, // premium-only (top tier)
      advanced_analytics: false,
    });
  });

  it('resolveForUser() applies per-user overrides and global states', async () => {
    const { resolver } = makeResolver({
      user: { id: 'u1', subscription_tier: 'premium' },
      overrides: [{ feature: 'gpx_export', enabled: false }],
      states: [{ feature: 'group_rides', state: 'force_off' }],
    });
    await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
      gpx_export: false, // per-user revoke beats the premium tier grant
      commuter_mode: true, // tier grant
      group_rides: false, // kill switch beats the premium tier grant
    });
  });

  describe('the store rollup reaches enforcement (#1191)', () => {
    const storeOnlyPayer = {
      id: 'u1',
      // Stripe-owned column stays free for a store purchase: this is exactly the
      // rider who resolves as Free if the rollup is missed.
      subscription_tier: 'free',
      grant_tier: null,
      store_subscription_tier: 'pro',
      store_subscription_tier_expires_at: new Date(Date.now() + 86_400_000),
    };

    it('SELECTS both rollup columns, in both entry points', () => {
      // The columns are `select: false`, so omitting either produces a
      // valid-looking user that silently resolves a paying store subscriber as
      // Free. Asserting the select is the only way to catch that: every other
      // assertion still passes.
      for (const select of [
        // resolveForUser and resolveLimitsForUser share ENTITLEMENT_SELECT, so
        // this pins the definition they both use.
        ENTITLEMENT_SELECT,
      ]) {
        expect(select).toMatchObject({
          subscription_tier: true,
          grant_tier: true,
          store_subscription_tier: true,
          store_subscription_tier_expires_at: true,
        });
      }
    });

    it('resolveForUser() grants paid FEATURES from a live store rollup', async () => {
      const { resolver, users } = makeResolver({ user: storeOnlyPayer });
      await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
        advanced_ride_stats: true,
      });
      expect(users.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ select: ENTITLEMENT_SELECT }),
      );
    });

    it('resolveLimitsForUser() grants paid LIMITS from a live store rollup', async () => {
      const { resolver, users } = makeResolver({ user: storeOnlyPayer });
      const limits = await resolver.resolveLimitsForUser('u1');
      // The free cap is finite; a paid tier lifts it. Asserting "not the free
      // value" rather than a specific number keeps this from breaking every
      // time the registry is retuned.
      expect(limits.max_active_trips).not.toBe(
        (await makeResolver().resolver.resolveLimitsForUser('u1'))
          .max_active_trips,
      );
      expect(users.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ select: ENTITLEMENT_SELECT }),
      );
    });

    it('does NOT grant once the rollup has lapsed', async () => {
      const { resolver } = makeResolver({
        user: {
          ...storeOnlyPayer,
          store_subscription_tier_expires_at: new Date(Date.now() - 1),
        },
      });
      await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
        advanced_ride_stats: false,
      });
    });
  });

  it('resolveForUser() throws NotFound for a missing user', async () => {
    const { resolver } = makeResolver({ user: null as never });
    await expect(resolver.resolveForUser('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getGlobalStates() drops rows with unknown states', async () => {
    const { resolver } = makeResolver({
      states: [
        { feature: 'gpx_export', state: 'force_on' },
        { feature: 'group_rides', state: 'corrupted' },
      ],
    });
    await expect(resolver.getGlobalStates()).resolves.toEqual({
      gpx_export: 'force_on',
    });
  });

  it('getGlobalLimitOverrides() keeps a seeded launch-mode null and valid integers, drops negative/non-integer values', async () => {
    const { resolver } = makeResolver({
      limitStates: [
        { feature: 'max_active_trips', value: null }, // seeded launch-mode row
        { feature: 'group_ride_size', value: 10 }, // valid positive integer
        { feature: 'bad_negative', value: -1 }, // dropped: negative
        { feature: 'bad_fraction', value: 1.5 }, // dropped: non-integer
      ],
    });
    await expect(resolver.getGlobalLimitOverrides()).resolves.toEqual({
      max_active_trips: null,
      group_ride_size: 10,
    });
  });

  it('resolveLimitsForUser() resolves the free-tier registry value with no overrides', async () => {
    const { resolver } = makeResolver({
      user: { id: 'u1', subscription_tier: 'free' },
    });
    await expect(resolver.resolveLimitsForUser('u1')).resolves.toMatchObject({
      max_active_trips: 1,
    });
  });

  it('resolveLimitsForUser() folds tier + user override + global override (free user, override 5, global 2 -> 2)', async () => {
    const { resolver } = makeResolver({
      user: { id: 'u1', subscription_tier: 'free' },
      userLimits: [{ feature: 'max_active_trips', value: 5 }],
      limitStates: [{ feature: 'max_active_trips', value: 2 }],
    });
    await expect(resolver.resolveLimitsForUser('u1')).resolves.toMatchObject({
      max_active_trips: 2,
    });
  });

  it('resolveLimitsForUser() throws NotFound for a missing user', async () => {
    const { resolver } = makeResolver({ user: null as never });
    await expect(
      resolver.resolveLimitsForUser('missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolveEntitlementsForLoadedUser() resolves both snapshots without a user query', async () => {
    const { resolver, users } = makeResolver({
      states: [{ feature: 'gpx_export', state: 'force_on' }],
      limitStates: [{ feature: 'max_active_trips', value: 2 }],
    });
    await expect(
      resolver.resolveEntitlementsForLoadedUser({
        id: 'u1',
        subscription_tier: 'free',
        grant_tier: null,
      }),
    ).resolves.toMatchObject({
      features: { gpx_export: true },
      limits: { max_active_trips: 2 },
    });
    expect(users.findOne).not.toHaveBeenCalled();
  });

  describe('grant entitlement (#1132)', () => {
    // Entitlement is `max(grant, subscription)`. Today both columns hold the
    // same value for a granted rider, so these are no-ops on real data — but
    // they are what keeps a founder entitled once subscription writers stop
    // maintaining `subscription_tier`, which is the whole point of the split.

    it('entitles a GRANT-ONLY rider from the grant side', async () => {
      // The shape after step 3: the subscription side is `free` because nothing
      // is billed, and the grant is the only entitlement. Reading
      // `subscription_tier` directly would give this rider free features.
      const { resolver } = makeResolver({
        user: { id: 'u1', subscription_tier: 'free', grant_tier: 'pro' },
      });
      await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
        gpx_export: true,
      });
    });

    it('lets a PAID tier exceed a lower grant', async () => {
      const { resolver } = makeResolver({
        user: { id: 'u1', subscription_tier: 'premium', grant_tier: 'pro' },
      });
      await expect(resolver.resolveForUser('u1')).resolves.toMatchObject({
        group_rides: true,
      });
    });

    it('applies the grant to LIMITS as well as features', async () => {
      // Limits resolve from the tier too, and a reader that moved only the
      // feature side would leave a granted rider on free-tier caps.
      const { resolver } = makeResolver({
        user: { id: 'u1', subscription_tier: 'free', grant_tier: 'pro' },
      });
      await expect(resolver.resolveLimitsForUser('u1')).resolves.toMatchObject({
        max_active_trips: null,
      });
    });

    it('entitles a grant-only LOADED user — both snapshots', async () => {
      // `resolveEntitlementsForLoadedUser` contains its OWN two tier reads and is
      // the path `/users/me` and every auth response take. The other grant tests
      // exercise `resolveForUser`/`resolveLimitsForUser`, so reverting either
      // line here would leave clients on free snapshots with all of them green.
      const { resolver } = makeResolver();
      await expect(
        resolver.resolveEntitlementsForLoadedUser({
          id: 'u1',
          subscription_tier: 'free',
          grant_tier: 'pro',
        }),
      ).resolves.toMatchObject({
        features: { gpx_export: true },
        limits: { max_active_trips: null },
      });
    });

    it('SELECTS the grant column on EVERY query — an unselected grant silently entitles nothing', async () => {
      // Both entry points have their own `select`, and the mock returns the full
      // user whichever one is asked for — so a behaviour test cannot see a
      // missing projection. Against TypeORM the column would come back
      // undefined and a grant-only rider would get free features or free caps
      // with every other test green. Assert each projection separately.
      const { resolver, users } = makeResolver();
      await resolver.resolveForUser('u1');
      await resolver.resolveLimitsForUser('u1');

      const selects = (
        users.findOne.mock.calls as Array<
          [{ select?: Record<string, boolean> }]
        >
      ).map(([arg]) => arg?.select);
      expect(selects).toHaveLength(2);
      for (const select of selects) {
        expect(select?.grant_tier).toBe(true);
        expect(select?.subscription_tier).toBe(true);
      }
    });
  });

  it('getSystemSwitches resolves force_off to disabled and everything else on', async () => {
    const { resolver } = makeResolver({
      states: [{ feature: 'sys_weather_provider', state: 'force_off' }],
    });
    const switches = await resolver.getSystemSwitches();
    expect(switches.sys_weather_provider).toBe(false);
    expect(switches.sys_mapillary_previews).toBe(true);
  });

  it('isSystemSwitchEnabled is true by default and false only on force_off', async () => {
    const { resolver } = makeResolver({
      states: [{ feature: 'sys_weather_provider', state: 'force_off' }],
    });
    expect(await resolver.isSystemSwitchEnabled('sys_weather_provider')).toBe(
      false,
    );
    expect(await resolver.isSystemSwitchEnabled('sys_mapillary_previews')).toBe(
      true,
    );
  });
});
