import { FEATURE_KEYS } from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';

const allGranted = () =>
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));

/**
 * Provider required by `FeatureGuard` in controller unit tests — the
 * guard is instantiated by Nest's DI when a controller decorated with
 * `@UseGuards(..., FeatureGuard)` joins a `TestingModule`, even though
 * `canActivate` is never invoked when tests call controller methods
 * directly. The resolver mock grants every feature so a test that does
 * exercise the guard pipeline is not rejected.
 */
export const featureGuardTestProviders = [
  {
    provide: FeatureResolver,
    useValue: {
      resolveForUser: jest.fn().mockResolvedValue(allGranted()),
      resolveForLoadedUser: jest.fn().mockResolvedValue(allGranted()),
      getGlobalStates: jest.fn().mockResolvedValue({}),
    },
  },
];
