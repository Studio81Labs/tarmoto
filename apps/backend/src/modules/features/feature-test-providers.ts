import {
  LIMIT_FEATURE_KEYS,
  TOGGLE_FEATURE_KEYS,
  type LimitSnapshot,
} from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';

const allGranted = () =>
  Object.fromEntries(TOGGLE_FEATURE_KEYS.map((key) => [key, true]));

/** Every registry limit resolved to unlimited (`null`) — the stub value
 * for controller unit tests that don't care about limit enforcement. */
export const buildUnlimitedLimitSnapshot = (): LimitSnapshot =>
  Object.fromEntries(
    LIMIT_FEATURE_KEYS.map((key) => [key, null]),
  ) as LimitSnapshot;

/**
 * Provider required by `FeatureGuard` in controller unit tests — the
 * guard is instantiated by Nest's DI when a controller decorated with
 * `@UseGuards(..., FeatureGuard)` joins a `TestingModule`, even though
 * `canActivate` is never invoked when tests call controller methods
 * directly. The resolver mock grants every feature and leaves every
 * limit unlimited so a test that does exercise the guard pipeline is
 * not rejected.
 */
export const featureGuardTestProviders = [
  {
    provide: FeatureResolver,
    useValue: {
      resolveForUser: jest.fn().mockResolvedValue(allGranted()),
      resolveLimitsForUser: jest
        .fn()
        .mockResolvedValue(buildUnlimitedLimitSnapshot()),
      resolveEntitlementsForLoadedUser: jest.fn().mockResolvedValue({
        features: allGranted(),
        limits: buildUnlimitedLimitSnapshot(),
      }),
      getGlobalStates: jest.fn().mockResolvedValue({}),
    },
  },
];
