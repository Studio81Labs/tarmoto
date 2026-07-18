import { NotFoundException } from '@nestjs/common';
import { FeatureResolver } from './feature-resolver.service.js';

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
      }),
    ).resolves.toMatchObject({
      features: { gpx_export: true },
      limits: { max_active_trips: 2 },
    });
    expect(users.findOne).not.toHaveBeenCalled();
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
