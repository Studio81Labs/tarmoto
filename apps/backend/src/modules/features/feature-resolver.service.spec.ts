import { NotFoundException } from '@nestjs/common';
import { FeatureResolver } from './feature-resolver.service.js';

function makeResolver({
  user = { id: 'u1', subscription_tier: 'free' },
  overrides = [] as Array<{ feature: string; enabled: boolean }>,
  states = [] as Array<{ feature: string; state: string }>,
} = {}) {
  const users = { findOne: jest.fn().mockResolvedValue(user) };
  const userFeatures = { find: jest.fn().mockResolvedValue(overrides) };
  const featureStates = { find: jest.fn().mockResolvedValue(states) };
  return {
    resolver: new FeatureResolver(
      users as never,
      userFeatures as never,
      featureStates as never,
    ),
    users,
    userFeatures,
    featureStates,
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

  it('resolveForLoadedUser() skips the user query', async () => {
    const { resolver, users } = makeResolver({
      states: [{ feature: 'gpx_export', state: 'force_on' }],
    });
    await expect(
      resolver.resolveForLoadedUser({ id: 'u1', subscription_tier: 'free' }),
    ).resolves.toMatchObject({ gpx_export: true });
    expect(users.findOne).not.toHaveBeenCalled();
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
});
