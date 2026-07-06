import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FEATURE_KEYS } from '@tarmoto/shared';
import { AdminFlagsService } from './admin-flags.service.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const USER = {
  id: 'u1',
  email: 'rider@example.com',
  display_name: 'Rider',
  subscription_tier: 'free',
};

function makeQueryBuilder(rawMany: unknown[] = [], manyAndCount?: unknown) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'groupBy',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
  qb.getManyAndCount = jest.fn().mockResolvedValue(manyAndCount ?? [[], 0]);
  return qb;
}

function makeService({
  states = [] as unknown[],
  overrideCounts = [] as unknown[],
  userOverrides = [] as unknown[],
  user = USER,
  overriddenRows = [[], 0] as unknown,
} = {}) {
  // One shared stub covers both query-builder call sites: listFlags()
  // consumes getRawMany (override counts) and listOverriddenUsers()
  // consumes getManyAndCount (joined rows).
  const qb = makeQueryBuilder(overrideCounts, overriddenRows);
  const featureStates = {
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
  const userFeatures = {
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
    svc: new AdminFlagsService(
      featureStates as never,
      userFeatures as never,
      users as never,
    ),
    featureStates,
    userFeatures,
    users,
  };
}

describe('AdminFlagsService', () => {
  it('listFlags() returns every registry key with defaults and no override', async () => {
    const { svc } = makeService();
    const { flags } = await svc.listFlags();
    expect(flags.map((f) => f.feature).sort()).toEqual(
      [...FEATURE_KEYS].sort(),
    );
    const gpx = flags.find((f) => f.feature === 'gpx_export')!;
    expect(gpx).toMatchObject({
      default_value: false,
      tiers: ['pro', 'premium'],
      global_state: null,
      overridden_user_count: 0,
    });
  });

  it('listFlags() folds in global states and override counts', async () => {
    const { svc } = makeService({
      states: [
        {
          feature: 'group_rides',
          state: 'force_on',
          reason: 'launch',
          updated_by: 'a1',
          updated_at: NOW,
        },
      ],
      overrideCounts: [{ feature: 'group_rides', count: '3' }],
    });
    const { flags } = await svc.listFlags();
    const groupRides = flags.find((f) => f.feature === 'group_rides')!;
    expect(groupRides).toMatchObject({
      global_state: 'force_on',
      global_reason: 'launch',
      global_updated_by: 'a1',
      overridden_user_count: 3,
    });
  });

  it('setGlobalState() upserts and stamps the admin actor', async () => {
    const { svc, featureStates } = makeService();
    await svc.setGlobalState(
      'gpx_export',
      { state: 'force_off', reason: 'incident' },
      'admin-1',
    );
    expect(featureStates.save).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'gpx_export',
        state: 'force_off',
        reason: 'incident',
        updated_by: 'admin-1',
      }),
    );
  });

  it('setGlobalState() rejects unknown feature keys', async () => {
    const { svc } = makeService();
    await expect(
      svc.setGlobalState('nope', { state: 'force_on' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clearGlobalState() deletes by feature and is idempotent', async () => {
    const { svc, featureStates } = makeService();
    await svc.clearGlobalState('gpx_export');
    expect(featureStates.delete).toHaveBeenCalledWith({
      feature: 'gpx_export',
    });
  });

  it('getUserFlags() resolves per-flag values with override states', async () => {
    const { svc } = makeService({
      user: { ...USER, subscription_tier: 'pro' },
      userOverrides: [{ feature: 'group_rides', enabled: true }],
      states: [{ feature: 'commuter_mode', state: 'force_off' }],
    });
    const res = await svc.getUserFlags('u1');
    expect(res.user_id).toBe('u1');
    const byKey = Object.fromEntries(res.flags.map((f) => [f.feature, f]));
    // pro (mid) tier grant
    expect(byKey.gpx_export).toMatchObject({
      resolved: true,
      override_state: 'default',
    });
    // per-user grant beats the missing premium-only tier grant
    expect(byKey.group_rides).toMatchObject({
      resolved: true,
      override_state: 'force_on',
    });
    // kill switch beats the tier grant
    expect(byKey.commuter_mode).toMatchObject({
      resolved: false,
      override_state: 'default',
    });
  });

  it('getUserFlags() 404s for a missing user', async () => {
    const { svc } = makeService({ user: null });
    await expect(svc.getUserFlags('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('setOverride() upserts the user_features row', async () => {
    const { svc, userFeatures } = makeService();
    await svc.setOverride('u1', 'gpx_export', { enabled: false });
    expect(userFeatures.save).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        feature: 'gpx_export',
        enabled: false,
      }),
    );
  });

  it('setOverride() rejects unknown features before touching the user', async () => {
    const { svc, users } = makeService();
    await expect(
      svc.setOverride('u1', 'nope', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('removeOverride() deletes the row', async () => {
    const { svc, userFeatures } = makeService();
    await svc.removeOverride('u1', 'gpx_export');
    expect(userFeatures.delete).toHaveBeenCalledWith({
      user_id: 'u1',
      feature: 'gpx_export',
    });
  });

  it('listOverriddenUsers() maps joined rows and pagination', async () => {
    const { svc } = makeService({
      overriddenRows: [
        [
          {
            user_id: 'u1',
            enabled: true,
            updated_at: NOW,
            user: USER,
          },
        ],
        1,
      ],
    });
    const res = await svc.listOverriddenUsers('gpx_export', {});
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(res.rows[0]).toMatchObject({
      user_id: 'u1',
      email: 'rider@example.com',
      subscription_tier: 'free',
      enabled: true,
    });
  });
});
