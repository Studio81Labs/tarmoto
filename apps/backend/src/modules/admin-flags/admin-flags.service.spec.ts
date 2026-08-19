import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TOGGLE_FEATURE_KEYS, buildFeatureSnapshot } from '@tarmoto/shared';
import { AdminFlagsService } from './admin-flags.service.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const USER: Record<string, unknown> = {
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
  states = [],
  overrideCounts = [],
  userOverrides = [],
  user = USER,
  overriddenRows = [[], 0],
  resolvedSnapshot = buildFeatureSnapshot('free', {}, {}),
}: {
  states?: unknown[];
  overrideCounts?: unknown[];
  userOverrides?: unknown[];
  // null = the 404 path; extra keys (grant_tier, …) ride on the record.
  user?: Record<string, unknown> | null;
  overriddenRows?: unknown;
  resolvedSnapshot?: ReturnType<typeof buildFeatureSnapshot>;
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
  const featureResolver = {
    resolveForUser: jest.fn().mockResolvedValue(resolvedSnapshot),
  };
  const eventsGateway = {
    evictFromGroupRideRooms: jest.fn().mockResolvedValue(undefined),
    evictNonEntitledFromGroupRideRooms: jest.fn().mockResolvedValue(undefined),
  };
  return {
    svc: new AdminFlagsService(
      featureStates as never,
      userFeatures as never,
      users as never,
      featureResolver as never,
      eventsGateway as never,
    ),
    featureStates,
    userFeatures,
    users,
    featureResolver,
    eventsGateway,
  };
}

describe('AdminFlagsService', () => {
  it('listFlags() returns every registry key with defaults and no override', async () => {
    const { svc } = makeService();
    const { flags } = await svc.listFlags();
    expect(flags.map((f) => f.feature).sort()).toEqual(
      [...TOGGLE_FEATURE_KEYS].sort(),
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

  it('getUserFlags() previews the EFFECTIVE tier, grant included (#1132)', async () => {
    // The admin preview has to agree with enforcement. Reading the raw column
    // would show a grant-only pro rider as free here while the backend lets them
    // export GPX — an operator debugging a support ticket would see the opposite
    // of what the rider experiences.
    const { svc } = makeService({
      user: { ...USER, subscription_tier: 'free', grant_tier: 'pro' },
    });
    const res = await svc.getUserFlags('u1');
    const byKey = Object.fromEntries(res.flags.map((f) => [f.feature, f]));
    expect(byKey.gpx_export).toMatchObject({ resolved: true });
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

  it('setGlobalState(group_rides, force_off) evicts every socket from group rooms', async () => {
    const { svc, eventsGateway } = makeService();
    await svc.setGlobalState(
      'group_rides',
      { state: 'force_off', reason: 'incident' },
      'admin-1',
    );
    expect(eventsGateway.evictFromGroupRideRooms).toHaveBeenCalledWith();
  });

  it('setGlobalState(group_rides, force_on) does not evict', async () => {
    const { svc, eventsGateway } = makeService();
    await svc.setGlobalState('group_rides', { state: 'force_on' }, 'admin-1');
    expect(eventsGateway.evictFromGroupRideRooms).not.toHaveBeenCalled();
  });

  it('clearGlobalState(group_rides) evicts the members who lost the entitlement', async () => {
    // Clearing the launch-mode force_on = enforcement goes live; only
    // non-entitled members are kicked from the live rooms.
    const { svc, eventsGateway } = makeService();
    await svc.clearGlobalState('group_rides');
    expect(eventsGateway.evictNonEntitledFromGroupRideRooms).toHaveBeenCalled();
  });

  it('clearGlobalState() on other features does not touch the rooms', async () => {
    const { svc, eventsGateway } = makeService();
    await svc.clearGlobalState('gpx_export');
    expect(
      eventsGateway.evictNonEntitledFromGroupRideRooms,
    ).not.toHaveBeenCalled();
  });

  it('setOverride(group_rides, false) evicts the user when no longer entitled', async () => {
    const { svc, eventsGateway } = makeService({
      resolvedSnapshot: buildFeatureSnapshot('free', {}, {}),
    });
    await svc.setOverride('u1', 'group_rides', { enabled: false });
    expect(eventsGateway.evictFromGroupRideRooms).toHaveBeenCalledWith('u1');
  });

  it('removeOverride(group_rides) leaves entitled users connected', async () => {
    // e.g. a premium user whose redundant force_on override is removed —
    // the tier still grants the feature, so no eviction.
    const { svc, eventsGateway } = makeService({
      resolvedSnapshot: buildFeatureSnapshot('premium', {}, {}),
    });
    await svc.removeOverride('u1', 'group_rides');
    expect(eventsGateway.evictFromGroupRideRooms).not.toHaveBeenCalled();
  });

  it('eviction failures are logged, not surfaced — the DB revoke already landed', async () => {
    const { svc, eventsGateway } = makeService();
    eventsGateway.evictFromGroupRideRooms.mockRejectedValueOnce(
      new Error('adapter down'),
    );
    await expect(
      svc.setGlobalState(
        'group_rides',
        { state: 'force_off', reason: 'incident' },
        'admin-1',
      ),
    ).resolves.toMatchObject({ feature: 'group_rides' });
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
