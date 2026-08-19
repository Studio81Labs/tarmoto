// The explicit annotation keeps jest-mock's internal types out of the
// emitted declarations (TS2883 under declaration builds).
import type { Provider } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getEntityManagerToken } from '@nestjs/typeorm';
// TS 6.0 no longer surfaces jest's ambient globals inside src/ builds;
// the explicit import is also the runtime-honest form for a file that
// only ever executes under jest.
import { jest } from '@jest/globals';

/**
 * Providers required by `AuthGuard` / `OptionalAuthGuard` in controller
 * unit tests. The guards are instantiated by Nest's DI when a controller
 * decorated with `@UseGuards(AuthGuard)` is added to a `TestingModule`,
 * even though their `canActivate` is never invoked when test code calls
 * controller methods directly.
 *
 * The EntityManager mock returns a non-deleted account so the soft-delete
 * check (US-62) doesn't reject the simulated request if a test path
 * ever does exercise the guard pipeline.
 */
export const authGuardTestProviders: Provider[] = [
  { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
  {
    provide: getEntityManagerToken(),
    useValue: {
      // @jest/globals types jest.fn() strictly (args `never` until told
      // otherwise), unlike the old ambient namespace — the generic names
      // the resolved shape.
      findOne: jest
        .fn<() => Promise<{ id: string; deleted_at: null }>>()
        .mockResolvedValue({ id: 'user-1', deleted_at: null }),
    },
  },
];
