// The explicit annotation keeps jest-mock's internal types out of the
// emitted declarations (TS2883 under declaration builds).
import type { Provider } from '@nestjs/common';
import {
  LIMIT_FEATURE_KEYS,
  TOGGLE_FEATURE_KEYS,
  type LimitSnapshot,
} from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';
// TS 6.0 no longer surfaces jest's ambient globals inside src/ builds;
// the explicit import is also the runtime-honest form for a file that
// only ever executes under jest.
import { jest } from '@jest/globals';

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
export const featureGuardTestProviders: Provider[] = [
  {
    provide: FeatureResolver,
    useValue: {
      // @jest/globals types jest.fn() strictly (args `never` until told
      // otherwise), unlike the old ambient namespace — each generic names
      // the resolved shape.
      resolveForUser: jest
        .fn<() => Promise<Record<string, boolean>>>()
        .mockResolvedValue(allGranted()),
      resolveLimitsForUser: jest
        .fn<() => Promise<LimitSnapshot>>()
        .mockResolvedValue(buildUnlimitedLimitSnapshot()),
      resolveEntitlementsForLoadedUser: jest
        .fn<
          () => Promise<{
            features: Record<string, boolean>;
            limits: LimitSnapshot;
          }>
        >()
        .mockResolvedValue({
          features: allGranted(),
          limits: buildUnlimitedLimitSnapshot(),
        }),
      getGlobalStates: jest
        .fn<() => Promise<Record<string, never>>>()
        .mockResolvedValue({}),
    },
  },
];
