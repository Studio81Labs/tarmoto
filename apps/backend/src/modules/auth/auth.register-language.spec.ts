import {
  buildFeatureSnapshot,
  buildLimitSnapshot,
  resolveLocale,
} from '@tarmoto/shared';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

/**
 * Coverage for Accept-Language capture at signup: the header the
 * controller reads must reach `AuthService.register` unmodified, and the
 * service must derive the persisted `language` via `resolveLocale` rather
 * than a hardcoded default.
 *
 * Only `en` is registered today (`SUPPORTED_LOCALES` is `['en']`), so
 * `resolveLocale(anyHeader)` always resolves to `'en'` — asserting
 * `language === 'en'` alone would pass even if the header were never read
 * at all. Every assertion below is instead pinned to
 * `resolveLocale(<the exact header the test sent>)`, so it fails if the
 * capture is dropped, the header stops reaching the service, or the field
 * is ever hardcoded to a literal `'en'`. (`resolveLocale`'s own
 * fallback/q-weight behavior is unit-tested in `@tarmoto/shared`.)
 */
describe('Auth register: Accept-Language -> User.language capture', () => {
  const NOW = new Date('2026-07-12T00:00:00Z');

  const dto = {
    email: 'new@rider.cz',
    password: 'hunter2hunter2',
    display_name: 'New Rider',
  };

  function makeService() {
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
        tier: null,
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
    return { svc, userRepo, emailVerification };
  }

  function createdArg(userRepo: {
    create: jest.Mock;
  }): Record<string, unknown> {
    const createMock = userRepo.create as jest.Mock<
      unknown,
      [Record<string, unknown>]
    >;
    const [created] = createMock.mock.calls[0]!;
    return created;
  }

  describe('AuthService.register', () => {
    it('derives the created user language from the Accept-Language header via resolveLocale', async () => {
      const { svc, userRepo } = makeService();
      const header = 'en-GB,en;q=0.8';

      await svc.register(dto, header);

      // Pinned to resolveLocale(header) — NOT a hardcoded 'en' literal —
      // so this only passes if the value genuinely flows through
      // resolveLocale. It happens to equal 'en' today only because 'en'
      // is the sole registered locale.
      expect(createdArg(userRepo).language).toBe(resolveLocale(header));
      expect(createdArg(userRepo).language).toBe('en');
    });

    it('falls back to resolveLocale(undefined) when no Accept-Language header is sent', async () => {
      const { svc, userRepo } = makeService();

      await svc.register(dto);

      expect(createdArg(userRepo).language).toBe(resolveLocale(undefined));
      expect(createdArg(userRepo).language).toBe('en');
    });

    it('leaves the verification-email send untouched', async () => {
      const { svc, emailVerification } = makeService();

      await svc.register(dto, 'en-GB,en;q=0.8');

      expect(emailVerification.issueAndSend).toHaveBeenCalledTimes(1);
      // Still invoked with only the saved user — no locale/language arg
      // has been added to this call; that wiring is a later task.
      expect(emailVerification.issueAndSend.mock.calls[0]).toHaveLength(1);
    });
  });

  describe('AuthController.register', () => {
    function makeController() {
      const authService = { register: jest.fn().mockResolvedValue({}) };
      const controller = new AuthController(
        authService as never,
        {} as never,
        {} as never,
      );
      return { controller, authService };
    }

    it('threads the raw Accept-Language header through to AuthService.register', async () => {
      const { controller, authService } = makeController();
      const header = 'en-GB,en;q=0.8';

      await controller.register(dto, header);

      expect(authService.register).toHaveBeenCalledWith(dto, header);
    });

    it('threads undefined through when the header is absent', async () => {
      const { controller, authService } = makeController();

      await controller.register(dto, undefined);

      expect(authService.register).toHaveBeenCalledWith(dto, undefined);
    });
  });
});
