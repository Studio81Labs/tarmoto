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

const SECRET = 'dev-only-admin-secret-do-not-use-in-production';

const config = {
  get: (key: string) => (key === 'NODE_ENV' ? 'development' : undefined),
} as unknown as ConfigService;
const jwt = new JwtService({ secret: SECRET });

function contextFor(
  method: string,
  url: string,
  cookieToken?: string,
  internalToken?: string,
): ExecutionContext {
  const headers: Record<string, string> = {};
  if (cookieToken) headers.cookie = `tarmoto_admin_access=${cookieToken}`;
  if (internalToken !== undefined) headers['x-internal-token'] = internalToken;
  const req: Record<string, unknown> = {
    method,
    url,
    originalUrl: url,
    headers,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
    __req: req,
  } as unknown as ExecutionContext;
}

function configWith(vals: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => vals[key] } as unknown as ConfigService;
}

function guardWith(opts: {
  session?: unknown;
  requiredRoles?: string[];
  config?: ConfigService;
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
    opts.config ?? config,
    reflector,
    sessions as never,
    audit as never,
  );
}

describe('InternalGuard', () => {
  it('allows a non-admin path without any session', async () => {
    const guard = guardWith({});
    await expect(guard.canActivate(contextFor('GET', '/rides'))).resolves.toBe(
      true,
    );
  });

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

  describe('internal token gate', () => {
    const PROD_TOKEN = {
      NODE_ENV: 'production',
      TARMOTO_INTERNAL_API_TOKEN: 's3kret-internal-token',
    };

    it('fails closed in production when no internal token is configured', async () => {
      const guard = guardWith({
        config: configWith({ NODE_ENV: 'production' }),
      });
      await expect(
        guard.canActivate(contextFor('POST', '/admin/auth/login')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('leaves the gate off in dev when no internal token is configured', async () => {
      const guard = guardWith({
        config: configWith({ NODE_ENV: 'development' }),
      });
      await expect(
        guard.canActivate(contextFor('POST', '/admin/auth/login')),
      ).resolves.toBe(true);
    });

    it('rejects an admin request missing the internal token when configured', async () => {
      const guard = guardWith({ config: configWith(PROD_TOKEN) });
      await expect(
        guard.canActivate(contextFor('POST', '/admin/auth/login')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong internal token when configured', async () => {
      const guard = guardWith({ config: configWith(PROD_TOKEN) });
      await expect(
        guard.canActivate(
          contextFor('POST', '/admin/auth/login', undefined, 'wrong-token'),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts a valid internal token then applies the public-path bypass', async () => {
      const guard = guardWith({ config: configWith(PROD_TOKEN) });
      await expect(
        guard.canActivate(
          contextFor(
            'POST',
            '/admin/auth/login',
            undefined,
            's3kret-internal-token',
          ),
        ),
      ).resolves.toBe(true);
    });

    it('accepts a valid internal token plus a valid session on a protected path', async () => {
      const token = await jwt.signAsync(
        { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
        { secret: SECRET },
      );
      const guard = guardWith({
        config: configWith({
          ...PROD_TOKEN,
          TARMOTO_ADMIN_AUTH_SESSION_SECRET: SECRET,
        }),
        session: {
          id: 's1',
          admin_user_id: 'a1',
          revoked_at: null,
          expires_at: new Date(Date.now() + 100000),
          admin_user: { id: 'a1', role: 'support', status: 'active' },
        },
      });
      await expect(
        guard.canActivate(
          contextFor('GET', '/admin/metrics', token, 's3kret-internal-token'),
        ),
      ).resolves.toBe(true);
    });
  });

  it('allows a valid session and sets adminUser', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
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
      { secret: SECRET },
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
      guard.canActivate(contextFor('GET', '/admin/admins', token)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a revoked session', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
    );
    const guard = guardWith({
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: new Date(),
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: 'a1', role: 'support', status: 'active' },
      },
    });
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics', token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired session', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
    );
    const guard = guardWith({
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: null,
        expires_at: new Date(Date.now() - 1000),
        admin_user: { id: 'a1', role: 'support', status: 'active' },
      },
    });
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics', token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a session whose user is disabled', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
    );
    const guard = guardWith({
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: 'a1', role: 'support', status: 'disabled' },
      },
    });
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics', token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with wrong scope', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: 'wrong_scope' },
      { secret: SECRET },
    );
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics', token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with missing sid', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
    );
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('GET', '/admin/metrics', token)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // --- gating tests for the mutating admin-admins routes ---

  it('[gating] POST /api/v1/admin/admins is forbidden for support role', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
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
      guard.canActivate(contextFor('POST', '/api/v1/admin/admins', token)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[gating] PATCH /api/v1/admin/admins/:id is forbidden for support role', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
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
      guard.canActivate(
        contextFor(
          'PATCH',
          '/api/v1/admin/admins/00000000-0000-0000-0000-000000000001',
          token,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[gating] POST /api/v1/admin/admins is forbidden for read_only role', async () => {
    const token = await jwt.signAsync(
      { sub: 'a1', sid: 's1', scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: SECRET },
    );
    const guard = guardWith({
      requiredRoles: ['admin'],
      session: {
        id: 's1',
        admin_user_id: 'a1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: 'a1', role: 'read_only', status: 'active' },
      },
    });
    await expect(
      guard.canActivate(contextFor('POST', '/api/v1/admin/admins', token)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // --- prefixed-path tests (simulate production where setGlobalPrefix applies) ---

  it('[prefixed] rejects missing token on a protected admin path — catches the prod auth bypass', async () => {
    // This is the critical regression test: in prod, the guard sees
    // /api/v1/admin/metrics. Without normalization it would return true (bypass).
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('GET', '/api/v1/admin/metrics')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('[prefixed] bypasses public auth login path with global prefix', async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('POST', '/api/v1/admin/auth/login')),
    ).resolves.toBe(true);
  });

  it('[prefixed] allows a non-admin prefixed path without session', async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor('GET', '/api/v1/rides')),
    ).resolves.toBe(true);
  });
});
