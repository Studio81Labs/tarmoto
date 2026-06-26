import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalGuard } from './internal.guard.js';
import { ADMIN_ACCESS_TOKEN_SCOPE } from '../admin-auth/admin-auth.constants.js';

const config = {
  get: (key: string) => (key === 'NODE_ENV' ? 'development' : undefined),
} as unknown as ConfigService;
const jwt = new JwtService({
  secret: 'dev-only-admin-secret-do-not-use-in-production',
});

function contextFor(
  method: string,
  url: string,
  cookieToken?: string,
  _requiredRoles?: string[],
): ExecutionContext {
  const req: Record<string, unknown> = {
    method,
    url,
    originalUrl: url,
    headers: cookieToken
      ? { cookie: `tarmoto_admin_access=${cookieToken}` }
      : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
    __req: req,
  } as unknown as ExecutionContext;
}

function guardWith(opts: {
  session?: unknown;
  requiredRoles?: string[];
}): InternalGuard {
  const reflector = {
    getAllAndOverride: () => opts.requiredRoles,
  } as unknown as Reflector;
  const sessions = {
    findOne: jest.fn().mockResolvedValue(opts.session ?? null),
    update: jest.fn(),
    manager: {
      findOne: jest
        .fn()
        .mockResolvedValue(
          (opts.session as Record<string, unknown> | undefined)?.admin_user ??
            null,
        ),
    },
  };
  const audit = { record: jest.fn() };
  return new InternalGuard(
    jwt,
    config,
    reflector,
    sessions as never,
    audit as never,
  );
}

describe('InternalGuard', () => {
  it('bypasses public auth paths', async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('POST', '/admin/auth/login')),
    ).resolves.toBe(true);
  });

  it('rejects missing token on a protected admin path', async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a valid session and sets adminUser', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: 'dev-only-admin-secret-do-not-use-in-production' },
    );
    const guard = guardWith({
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: 'a1', role: 'support', status: 'active' },
      },
    });
    const ctx = contextFor('GET', '/admin/metrics', token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      (ctx as unknown as { __req: { adminUser?: unknown } }).__req.adminUser,
    ).toBeDefined();
  });

  it('forbids when role rank is insufficient', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: 'dev-only-admin-secret-do-not-use-in-production' },
    );
    const guard = guardWith({
      requiredRoles: ['admin'],
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: 'a1', role: 'support', status: 'active' },
      },
    });
    await expect(
      guard.canActivate(contextFor('GET', '/admin/admins', token, ['admin'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
