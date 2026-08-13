import { buildFeatureSnapshot, buildLimitSnapshot } from '@tarmoto/shared';
import { AuthService } from './auth.service.js';

/**
 * Focused coverage for the launch-mode registration grant: while an
 * operator has a launch tier set, `register()` creates the user on that
 * tier with `plan_source = 'founder'`; with launch mode off, defaults
 * apply untouched.
 */
describe('AuthService register launch-tier grant', () => {
  const NOW = new Date('2026-07-01T00:00:00Z');

  function makeService(launchTier: 'pro' | 'premium' | null) {
    const userRepo = {
      // A just-registered rider has no store chain, so the rollup read returns
      // nothing and the resolver sees no store side. Present because the auth
      // response now serves the BILLED tier, which spans every billing source.
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((v: object) => ({
        id: 'u1',
        phone: null,
        avatar_url: null,
        bio: null,
        home_region: null,
        home_location: null,
        work_location: null,
        preferences: {},
        subscription_tier: 'free',
        plan_source: null,
        created_at: NOW,
        ...v,
      })),
      save: jest.fn().mockImplementation((v: object) => Promise.resolve(v)),
    };
    const jwt = { sign: jest.fn().mockReturnValue('token') };
    const emailVerification = {
      issueAndSend: jest.fn().mockResolvedValue(undefined),
    };
    const featureResolver = {
      resolveEntitlementsForLoadedUser: jest
        .fn()
        .mockImplementation((user: { subscription_tier: string }) =>
          Promise.resolve({
            features: buildFeatureSnapshot(user.subscription_tier, {}, {}),
            limits: buildLimitSnapshot(user.subscription_tier, {}, {}),
          }),
        ),
    };
    const appSettings = {
      getLaunchTier: jest.fn().mockResolvedValue({
        tier: launchTier,
        updated_by: null,
        updated_at: null,
      }),
    };
    const svc = new AuthService(
      userRepo as never,
      jwt as never,
      emailVerification as never,
      featureResolver as never,
      appSettings as never,
    );
    return { svc, userRepo };
  }

  const dto = {
    email: 'new@rider.cz',
    password: 'hunter2hunter2',
    display_name: 'New Rider',
  };

  it('creates free users untouched when launch mode is off', async () => {
    const { svc, userRepo } = makeService(null);
    const res = await svc.register(dto);
    const createMock = userRepo.create as jest.Mock<
      unknown,
      [Record<string, unknown>]
    >;
    const [created] = createMock.mock.calls[0]!;
    expect(created).not.toHaveProperty('plan_source');
    expect(created).not.toHaveProperty('subscription_tier');
    expect(res.user.subscription_tier).toBe('free');
    expect(res.user.features.gpx_export).toBe(false);
    // Free tier is capped at 1 active trip.
    expect(res.user.limits.max_active_trips).toBe(1);
  });

  it('auto-grants the launch tier with plan_source founder', async () => {
    const { svc, userRepo } = makeService('pro');
    const res = await svc.register(dto);
    expect(userRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_tier: 'pro',
        plan_source: 'founder',
      }),
    );
    expect(res.user.subscription_tier).toBe('pro');
    // the pro (mid) tier grant reaches the resolved snapshot immediately
    expect(res.user.features.gpx_export).toBe(true);
    expect(res.user.features.group_rides).toBe(false);
    // pro is unlimited on max_active_trips
    expect(res.user.limits.max_active_trips).toBeNull();
  });

  it('DUAL-WRITES the grant columns alongside the legacy ones (#1132)', async () => {
    // The launch grant is the only grant writer in the repo, so it is the only
    // place that can keep the new columns populated while readers still consult
    // `subscription_tier`. If it wrote only the legacy pair, the grant columns
    // would be empty on every account created after the migration and the
    // backfill would look correct while silently going stale.
    const { svc, userRepo } = makeService('premium');
    await svc.register(dto);

    const created = (
      userRepo.create.mock.calls as Array<[Record<string, unknown>]>
    )[0]?.[0];

    expect(created).toMatchObject({
      subscription_tier: 'premium',
      plan_source: 'founder',
      grant_tier: 'premium',
      grant_source: 'founder',
    });
    // Both-or-neither is a DB constraint; a timestamp is what makes the grant
    // auditable ("when did this rider get premium?").
    expect(created?.grant_granted_at).toBeInstanceOf(Date);
  });

  it('writes NO grant columns when launch mode is off', async () => {
    // A rider who was never granted anything must not carry a grant row — the
    // CHECK would reject a half-written one, and a `free` grant entitles nothing
    // while making the rider look granted.
    const { svc, userRepo } = makeService(null);
    await svc.register(dto);

    const created = (
      userRepo.create.mock.calls as Array<[Record<string, unknown>]>
    )[0]?.[0];

    expect(created).not.toHaveProperty('grant_tier');
    expect(created).not.toHaveProperty('grant_source');
    expect(created).not.toHaveProperty('grant_granted_at');
  });

  it('supports granting the premium (top) tier', async () => {
    const { svc } = makeService('premium');
    const res = await svc.register(dto);
    expect(res.user.subscription_tier).toBe('premium');
    expect(res.user.features.group_rides).toBe(true);
    expect(res.user.limits.max_active_trips).toBeNull();
  });
});
