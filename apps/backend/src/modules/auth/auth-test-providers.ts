import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';

/**
 * Providers required by `AuthGuard` / `OptionalAuthGuard` in controller
 * unit tests. The guards are instantiated by Nest's DI when a controller
 * decorated with `@UseGuards(AuthGuard)` is added to a `TestingModule`,
 * even though their `canActivate` is never invoked when test code calls
 * controller methods directly.
 *
 * The User-repo mock returns a non-deleted account so the soft-delete
 * check (US-62) doesn't reject the simulated request if a test path
 * ever does exercise the guard pipeline.
 */
export const authGuardTestProviders = [
  { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
  {
    provide: getRepositoryToken(User),
    useValue: {
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', deleted_at: null }),
    },
  },
];
