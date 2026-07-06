import { buildFeatureSnapshot } from '@tarmoto/shared';
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
      resolveForLoadedUser: jest
        .fn()
        .mockImplementation((user: { subscription_tier: string }) =>
          Promise.resolve(buildFeatureSnapshot(user.subscription_tier, {}, {})),
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
  });

  it('supports granting the premium (top) tier', async () => {
    const { svc } = makeService('premium');
    const res = await svc.register(dto);
    expect(res.user.subscription_tier).toBe('premium');
    expect(res.user.features.group_rides).toBe(true);
  });
});
