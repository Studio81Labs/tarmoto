// jest.mock is hoisted by Jest before imports — mocking the GitHub SSO helper
// lets us test the successful callback path without real network calls.
jest.mock('./admin-github-sso.js', () => ({
  exchangeGithubCode: jest.fn(),
  buildGithubAuthorizeUrl: jest
    .fn()
    .mockReturnValue('https://github.com/login/oauth/authorize?mock=1'),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuditService } from '../admin/admin-audit.interceptor.js';
import {
  ADMIN_CLIENT_COOKIE,
  ADMIN_REFRESH_COOKIE,
  ADMIN_SSO_STATE_COOKIE,
} from './admin-auth.constants.js';
import { getAdminAuditActor } from '../admin/admin-audit-context.js';
import { exchangeGithubCode } from './admin-github-sso.js';

function mockResponse(): Response {
  return {
    getHeader: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn(),
  } as unknown as Response;
}

/** A minimal AdminSessionTokens stub that includes clientNonce. */
function makeTokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    clientNonce: 'nonce-hex-abc',
    user: {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
    },
    expiresIn: 540,
    ...overrides,
  };
}

describe('AdminAuthController', () => {
  let controller: AdminAuthController;
  const service = {
    loginWithPassword: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn(),
    findActiveById: jest.fn(),
    findOrProvisionSsoUser: jest.fn(),
    createSession: jest.fn(),
  } as unknown as jest.Mocked<AdminAuthService>;

  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminAuditService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        { provide: ConfigService, useValue: { get: () => 'development' } },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    controller = moduleRef.get(AdminAuthController);
    jest.clearAllMocks();
  });

  it('logs in, sets auth + client cookies, and stamps the audit actor on the request', async () => {
    (service.loginWithPassword as jest.Mock).mockResolvedValue(makeTokens());
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();
    const body = await controller.login(
      { email: 'ops@tarmoto.app', password: 'pw' },
      req,
      res,
    );

    expect(service.loginWithPassword).toHaveBeenCalledWith(
      'ops@tarmoto.app',
      'pw',
    );

    expect(res.setHeader).toHaveBeenCalled();
    // The client nonce cookie must appear in at least one Set-Cookie call.
    const allSetHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [
      string,
      string | string[],
    ][];
    const allCookieValues = allSetHeaderCalls
      .filter(([name]) => name === 'Set-Cookie')

      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .join('\n');
    expect(allCookieValues).toContain(ADMIN_CLIENT_COOKIE);
    expect(allCookieValues).toContain('nonce-hex-abc');

    expect(body).toEqual({
      user: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'active',
      },
      expiresIn: 540,
    });
    expect(getAdminAuditActor(req)).toEqual({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });
  });

  it('refresh reads client nonce cookie, passes it to service.refresh, re-affirms cookie, and stamps audit actor', async () => {
    (service.refresh as jest.Mock).mockResolvedValue(
      makeTokens({ clientNonce: 'nonce-hex-abc' }),
    );
    const req = {
      headers: {
        cookie: `${ADMIN_REFRESH_COOKIE}=raw-refresh; ${ADMIN_CLIENT_COOKIE}=nonce-hex-abc`,
      },
    } as unknown as Request;
    const res = mockResponse();
    await controller.refresh(req, res);

    // service.refresh must receive both the raw refresh token AND the client nonce.

    expect(service.refresh).toHaveBeenCalledWith(
      'raw-refresh',
      'nonce-hex-abc',
    );

    // The client nonce cookie must be re-affirmed in the response.
    const allSetHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [
      string,
      string | string[],
    ][];
    const allCookieValues = allSetHeaderCalls
      .filter(([name]) => name === 'Set-Cookie')

      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .join('\n');
    expect(allCookieValues).toContain(ADMIN_CLIENT_COOKIE);

    expect(getAdminAuditActor(req)).toEqual({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });
  });

  it('refresh passes null client nonce when client cookie is absent', async () => {
    (service.refresh as jest.Mock).mockResolvedValue(makeTokens());
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=raw-refresh` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.refresh(req, res);

    expect(service.refresh).toHaveBeenCalledWith('raw-refresh', null);
  });

  it('logout stamps the audit actor when revoke returns an actor, and clears client cookie', async () => {
    (service.revoke as jest.Mock).mockResolvedValue({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=r` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.logout(req, res);

    expect(service.revoke).toHaveBeenCalledWith('r');
    expect(getAdminAuditActor(req)).toEqual({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });

    // Client cookie must be cleared (Max-Age=0).
    const allSetHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [
      string,
      string | string[],
    ][];
    const allCookieValues = allSetHeaderCalls
      .filter(([name]) => name === 'Set-Cookie')

      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .join('\n');
    expect(allCookieValues).toContain(ADMIN_CLIENT_COOKIE);
    expect(allCookieValues).toContain('Max-Age=0');
  });

  it('logout does not stamp an actor when revoke returns null (token not found)', async () => {
    (service.revoke as jest.Mock).mockResolvedValue(null);
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=unknown` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.logout(req, res);
    expect(getAdminAuditActor(req)).toBeNull();
  });

  it('returns the current admin from the request', () => {
    const req = {
      adminUser: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'active',
      },
    } as unknown as Request;
    expect(controller.me(req)).toEqual({
      user: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'active',
      },
    });
  });

  it('logout reads the refresh cookie, calls revoke, and clears cookies', async () => {
    (service.revoke as jest.Mock).mockResolvedValue(null);
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=r` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.logout(req, res);

    expect(service.revoke).toHaveBeenCalledWith('r');
  });

  it('refresh throws UnauthorizedException when refresh cookie is absent', async () => {
    const req = { headers: { cookie: '' } } as unknown as Request;
    const res = mockResponse();
    await expect(controller.refresh(req, res)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('SSO callback with mismatched state redirects to error URL without calling service', async () => {
    const req = {
      headers: { cookie: `${ADMIN_SSO_STATE_COOKIE}=correct-state` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.callback('code123', 'wrong-state', req, res);

    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');

    expect(service.findOrProvisionSsoUser).not.toHaveBeenCalled();

    expect(service.createSession).not.toHaveBeenCalled();
  });

  it('SSO callback with missing state cookie redirects to error URL without calling service', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();
    await controller.callback('code123', 'some-state', req, res);

    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');

    expect(service.findOrProvisionSsoUser).not.toHaveBeenCalled();

    expect(service.createSession).not.toHaveBeenCalled();
  });

  it('SSO callback with mismatched state records a denied audit row with state_mismatch reason', async () => {
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AdminAuditService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        { provide: ConfigService, useValue: { get: () => 'development' } },
        { provide: AdminAuditService, useValue: auditSpy },
      ],
    }).compile();
    const ctrl = moduleRef.get(AdminAuthController);

    const req = {
      headers: { cookie: `${ADMIN_SSO_STATE_COOKIE}=correct-state` },
      originalUrl: '/admin/auth/sso/github/callback?code=c&state=wrong',
    } as unknown as Request;
    const res = mockResponse();

    await ctrl.callback('code123', 'wrong-state', req, res);

    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');

    expect(auditSpy.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.sso_login',
        outcome: 'denied',
        method: 'GET',
        admin_user_id: null,
        admin_role: null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        metadata: expect.objectContaining({
          provider: 'github',
          reason: 'state_mismatch',
        }),
      }),
    );
  });

  it('SSO callback exchange/provisioning failure records a denied audit row with callback_failed reason and redirects', async () => {
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AdminAuditService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        {
          provide: AdminAuthService,
          useValue: {
            ...service,
            findOrProvisionSsoUser: jest
              .fn()
              .mockRejectedValue(new Error('unlinked identity')),
          },
        },
        { provide: ConfigService, useValue: { get: () => 'development' } },
        { provide: AdminAuditService, useValue: auditSpy },
      ],
    }).compile();
    const ctrl = moduleRef.get(AdminAuthController);

    (exchangeGithubCode as jest.Mock).mockResolvedValue({
      subject: 'gh-unknown',
      emails: ['unknown@example.com'],
    });

    const req = {
      headers: { cookie: `${ADMIN_SSO_STATE_COOKIE}=valid-state` },
      originalUrl:
        '/admin/auth/sso/github/callback?code=code123&state=valid-state',
    } as unknown as Request;
    const res = mockResponse();

    await ctrl.callback('code123', 'valid-state', req, res);

    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');

    expect(auditSpy.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.sso_login',
        outcome: 'denied',
        method: 'GET',
        admin_user_id: null,
        admin_role: null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        metadata: expect.objectContaining({
          provider: 'github',
          reason: 'callback_failed',
          detail: 'unlinked identity',
        }),
      }),
    );
  });

  it('successful SSO callback sets client cookie, redirects to /, and records an audit row', async () => {
    const adminUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin' as const,
      status: 'active' as const,
      sso_provider: 'github',
      sso_subject: 'gh-123',
    };
    (exchangeGithubCode as jest.Mock).mockResolvedValue({
      subject: 'gh-123',
      emails: ['ops@tarmoto.app'],
    });
    (service.findOrProvisionSsoUser as jest.Mock).mockResolvedValue(adminUser);
    (service.createSession as jest.Mock).mockResolvedValue(
      makeTokens({ clientNonce: 'sso-nonce-xyz' }),
    );

    const callbackPath = '/admin/auth/sso/github/callback';
    const req = {
      headers: {
        cookie: `${ADMIN_SSO_STATE_COOKIE}=valid-state`,
      },
      originalUrl: `${callbackPath}?code=code123&state=valid-state`,
    } as unknown as Request;
    const res = mockResponse();

    await controller.callback('code123', 'valid-state', req, res);

    // Successful login redirects to the app root.

    expect(res.redirect).toHaveBeenCalledWith('/');

    // Client nonce cookie must be set.
    const allSetHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [
      string,
      string | string[],
    ][];
    const allCookieValues = allSetHeaderCalls
      .filter(([name]) => name === 'Set-Cookie')

      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .join('\n');
    expect(allCookieValues).toContain(ADMIN_CLIENT_COOKIE);
    expect(allCookieValues).toContain('sso-nonce-xyz');

    // An audit row must be recorded for the SSO login (GET bypasses the
    // AdminAuditInterceptor which only fires on mutating requests).

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.sso_login',
        outcome: 'allowed',
        admin_user_id: 'a1',
        admin_role: 'admin',
        metadata: { provider: 'github' },
      }),
    );
  });

  it('GET config returns passwordLoginEnabled: true in dev/test', () => {
    expect(controller.getConfig()).toEqual({ passwordLoginEnabled: true });
  });

  it('GET config returns passwordLoginEnabled: false in production without flag', async () => {
    const prodModule = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'NODE_ENV') return 'production';
              return undefined;
            },
          },
        },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    const prodController = prodModule.get(AdminAuthController);
    expect(prodController.getConfig()).toEqual({ passwordLoginEnabled: false });
  });

  it('GET config returns passwordLoginEnabled: true in production with flag set', async () => {
    const prodModule = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'NODE_ENV') return 'production';
              if (key === 'TARMOTO_ADMIN_PASSWORD_LOGIN_ENABLED') return 'true';
              return undefined;
            },
          },
        },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    const prodController = prodModule.get(AdminAuthController);
    expect(prodController.getConfig()).toEqual({ passwordLoginEnabled: true });
  });

  it('login throws ForbiddenException and does not call service when password login is disabled', async () => {
    const productionService = {
      loginWithPassword: jest.fn(),
      refresh: jest.fn(),
      revoke: jest.fn(),
      findActiveById: jest.fn(),
      findOrProvisionSsoUser: jest.fn(),
      createSession: jest.fn(),
    } as unknown as jest.Mocked<AdminAuthService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: productionService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'NODE_ENV') return 'production';
              return undefined;
            },
          },
        },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    const prodController = moduleRef.get(AdminAuthController);
    const res = mockResponse();

    const req = { headers: {} } as unknown as Request;
    await expect(
      prodController.login(
        { email: 'ops@tarmoto.app', password: 'pw' },
        req,
        res,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(productionService.loginWithPassword).not.toHaveBeenCalled();
  });

  it('login with password-login-disabled records a denied audit row with reason password_login_disabled', async () => {
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AdminAuditService>;

    const prodModule = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'NODE_ENV') return 'production';
              return undefined;
            },
          },
        },
        { provide: AdminAuditService, useValue: auditSpy },
      ],
    }).compile();
    const prodController = prodModule.get(AdminAuthController);
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();

    await expect(
      prodController.login(
        { email: 'ops@tarmoto.app', password: 'pw' },
        req,
        res,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(auditSpy.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.login',
        outcome: 'denied',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        metadata: expect.objectContaining({
          email: 'ops@tarmoto.app',
          reason: 'password_login_disabled',
        }),
      }),
    );
  });

  it('login with bad credentials records a denied audit row with reason invalid_credentials', async () => {
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AdminAuditService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        {
          provide: AdminAuthService,
          useValue: {
            ...service,
            loginWithPassword: jest
              .fn()
              .mockRejectedValue(
                new UnauthorizedException('Invalid credentials'),
              ),
          },
        },
        { provide: ConfigService, useValue: { get: () => 'development' } },
        { provide: AdminAuditService, useValue: auditSpy },
      ],
    }).compile();
    const ctrl = moduleRef.get(AdminAuthController);
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();

    await expect(
      ctrl.login({ email: 'bad@example.com', password: 'wrong' }, req, res),
    ).rejects.toThrow(UnauthorizedException);

    expect(auditSpy.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.login',
        outcome: 'denied',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        metadata: expect.objectContaining({
          email: 'bad@example.com',
          reason: 'invalid_credentials',
        }),
      }),
    );
  });
});
