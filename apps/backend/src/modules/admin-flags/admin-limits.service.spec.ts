import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LIMIT_FEATURE_KEYS } from '@tarmoto/shared';
import { AdminLimitsService } from './admin-limits.service.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const USER = {
  id: 'u1',
  email: 'rider@example.com',
  display_name: 'Rider',
  subscription_tier: 'free',
};

function makeQueryBuilder(rawMany: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'addSelect', 'groupBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
  return qb;
}

function makeService({
  states = [] as unknown[],
  overrideCounts = [] as unknown[],
  userOverrides = [] as unknown[],
  user = USER,
} = {}) {
  const qb = makeQueryBuilder(overrideCounts);
  const limitStates = {
    find: jest.fn().mockResolvedValue(states),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((v: object) => ({
      created_at: NOW,
      updated_at: NOW,
      reason: null,
      updated_by: null,
      ...v,
    })),
    save: jest
      .fn()
      .mockImplementation((v: object) =>
        Promise.resolve({ updated_at: NOW, ...v }),
      ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const userLimits = {
    find: jest.fn().mockResolvedValue(userOverrides),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((v: object) => ({
      created_at: NOW,
      updated_at: NOW,
      ...v,
    })),
    save: jest
      .fn()
      .mockImplementation((v: object) =>
        Promise.resolve({ updated_at: NOW, ...v }),
      ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const users = { findOne: jest.fn().mockResolvedValue(user) };
  return {
    svc: new AdminLimitsService(
      limitStates as never,
      userLimits as never,
      users as never,
    ),
    limitStates,
    userLimits,
    users,
  };
}

describe('AdminLimitsService', () => {
  it('listLimits() returns every registry key with defaults and no override', async () => {
    const { svc } = makeService();
    const { limits } = await svc.listLimits();
    expect(limits.map((l) => l.feature).sort()).toEqual(
      [...LIMIT_FEATURE_KEYS].sort(),
    );
    const maxTrips = limits.find((l) => l.feature === 'max_active_trips')!;
    expect(maxTrips).toMatchObject({
      default_value: 1,
      tier_values: { free: 1, pro: null, premium: null },
      global_active: false,
      global_value: null,
      overridden_user_count: 0,
    });
  });

  it('listLimits() folds in the global override row and override counts', async () => {
    const { svc } = makeService({
      states: [
        {
          feature: 'max_active_trips',
          value: null,
          reason: 'launch mode',
          updated_by: 'a1',
          updated_at: NOW,
        },
      ],
      overrideCounts: [{ feature: 'max_active_trips', count: '3' }],
    });
    const { limits } = await svc.listLimits();
    const maxTrips = limits.find((l) => l.feature === 'max_active_trips')!;
    expect(maxTrips).toMatchObject({
      global_active: true,
      global_value: null,
      global_reason: 'launch mode',
      global_updated_by: 'a1',
      global_updated_at: NOW.toISOString(),
      overridden_user_count: 3,
    });
  });

  it('setGlobalValue() upserts a numeric value and stamps the admin actor', async () => {
    const { svc, limitStates } = makeService();
    await svc.setGlobalValue(
      'max_active_trips',
      { value: 3, reason: 'promo' },
      'admin-1',
    );
    expect(limitStates.save).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'max_active_trips',
        value: 3,
        reason: 'promo',
        updated_by: 'admin-1',
      }),
    );
  });

  it('setGlobalValue() upserts a null (unlimited) value', async () => {
    const { svc, limitStates } = makeService();
    await svc.setGlobalValue(
      'max_active_trips',
      { value: null, reason: 'launch mode' },
      'admin-1',
    );
    expect(limitStates.save).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'max_active_trips',
        value: null,
        reason: 'launch mode',
        updated_by: 'admin-1',
      }),
    );
  });

  it('setGlobalValue() rejects unknown limit keys', async () => {
    const { svc } = makeService();
    await expect(
      svc.setGlobalValue('nope', { value: 3, reason: 'x' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setGlobalValue() rejects toggle keys — not a limit', async () => {
    const { svc } = makeService();
    await expect(
      svc.setGlobalValue('gpx_export', { value: 3, reason: 'x' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clearGlobalValue() deletes by feature and is idempotent', async () => {
    const { svc, limitStates } = makeService();
    await svc.clearGlobalValue('max_active_trips');
    expect(limitStates.delete).toHaveBeenCalledWith({
      feature: 'max_active_trips',
    });
  });

  it('clearGlobalValue() rejects toggle keys — not a limit', async () => {
    const { svc } = makeService();
    await expect(svc.clearGlobalValue('gpx_export')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getUserLimits() previews the EFFECTIVE tier, grant included (#1132)', async () => {
    // Same as the flags preview: a grant-only pro rider is unlimited on trips,
    // and showing them the free cap here contradicts enforcement.
    const { svc } = makeService({
      user: { ...USER, subscription_tier: 'free', grant_tier: 'pro' },
    });
    const res = await svc.getUserLimits('u1');
    const byKey = Object.fromEntries(res.limits.map((l) => [l.feature, l]));
    expect(byKey.max_active_trips).toMatchObject({ resolved: null });
  });

  it('getUserLimits() resolves the free-tier registry value with no overrides', async () => {
    const { svc } = makeService();
    const res = await svc.getUserLimits('u1');
    expect(res.user_id).toBe('u1');
    const maxTrips = res.limits.find((l) => l.feature === 'max_active_trips')!;
    expect(maxTrips).toMatchObject({
      resolved: 1,
      override_active: false,
      override_value: null,
    });
  });

  it('getUserLimits() resolves null when a global null (unlimited) override is active', async () => {
    // The launch-mode seed row: global_active but value: null must still
    // resolve to unlimited, not silently fall back to the tier default —
    // this is the Map.has/Map.get presence subtlety.
    const { svc } = makeService({
      states: [{ feature: 'max_active_trips', value: null }],
    });
    const res = await svc.getUserLimits('u1');
    const maxTrips = res.limits.find((l) => l.feature === 'max_active_trips')!;
    expect(maxTrips).toMatchObject({ resolved: null });
  });

  it('getUserLimits() reports an active null (unlimited) per-user override', async () => {
    // Same Map.has/Map.get subtlety on the override side: Map.get alone
    // would return undefined for this row too, indistinguishable from "no
    // override row" — override_active must come from Map.has.
    const { svc } = makeService({
      userOverrides: [{ feature: 'max_active_trips', value: null }],
    });
    const res = await svc.getUserLimits('u1');
    const maxTrips = res.limits.find((l) => l.feature === 'max_active_trips')!;
    expect(maxTrips).toMatchObject({
      resolved: null,
      override_active: true,
      override_value: null,
    });
  });

  it('getUserLimits() 404s for a missing user', async () => {
    const { svc } = makeService({ user: null });
    await expect(svc.getUserLimits('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('setOverride() upserts the user_limits row and returns refreshed limits', async () => {
    const { svc, userLimits } = makeService();
    const res = await svc.setOverride('u1', 'max_active_trips', { value: 5 });
    expect(userLimits.save).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        feature: 'max_active_trips',
        value: 5,
      }),
    );
    expect(res.user_id).toBe('u1');
  });

  it('setOverride() rejects unknown limits before touching the user', async () => {
    const { svc, users } = makeService();
    await expect(
      svc.setOverride('u1', 'nope', { value: 3 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('removeOverride() deletes the row and is idempotent', async () => {
    const { svc, userLimits } = makeService();
    await svc.removeOverride('u1', 'max_active_trips');
    expect(userLimits.delete).toHaveBeenCalledWith({
      user_id: 'u1',
      feature: 'max_active_trips',
    });
  });
});
