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

  it('logs in, sets cookies, and stamps the audit actor on the request', async () => {
    (service.loginWithPassword as jest.Mock).mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      user: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'active',
      },
      expiresIn: 540,
    });
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();
    const body = await controller.login(
      { email: 'ops@tarmoto.app', password: 'pw' },
      req,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.loginWithPassword).toHaveBeenCalledWith(
      'ops@tarmoto.app',
      'pw',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.setHeader).toHaveBeenCalled();
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

  it('refresh stamps the audit actor on the request after successful token rotation', async () => {
    (service.refresh as jest.Mock).mockResolvedValue({
      accessToken: 'a2',
      refreshToken: 'r2',
      user: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'support',
        status: 'active',
      },
      expiresIn: 540,
    });
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=raw-refresh` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.refresh(req, res);
    expect(getAdminAuditActor(req)).toEqual({
      admin_user_id: 'a1',
      admin_role: 'support',
    });
  });

  it('logout stamps the audit actor when revoke returns an actor', async () => {
    (service.revoke as jest.Mock).mockResolvedValue({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=r` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.logout(req, res);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.revoke).toHaveBeenCalledWith('r');
    expect(getAdminAuditActor(req)).toEqual({
      admin_user_id: 'a1',
      admin_role: 'admin',
    });
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.revoke).toHaveBeenCalledWith('r');
  });

  it('refresh throws UnauthorizedException when refresh cookie is absent', async () => {
    const req = { headers: { cookie: '' } } as unknown as Request;
    const res = mockResponse();
    await expect(controller.refresh(req, res)).rejects.toThrow(
      UnauthorizedException,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('SSO callback with mismatched state redirects to error URL without calling service', async () => {
    const req = {
      headers: { cookie: `${ADMIN_SSO_STATE_COOKIE}=correct-state` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.callback('code123', 'wrong-state', req, res);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.findOrProvisionSsoUser).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it('SSO callback with missing state cookie redirects to error URL without calling service', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = mockResponse();
    await controller.callback('code123', 'some-state', req, res);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.redirect).toHaveBeenCalledWith('/?adminAuthError=sso');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.findOrProvisionSsoUser).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it('successful SSO callback redirects to / and records an audit row with event_key admin.auth.sso_login', async () => {
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
      email: 'ops@tarmoto.app',
    });
    (service.findOrProvisionSsoUser as jest.Mock).mockResolvedValue(adminUser);
    (service.createSession as jest.Mock).mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: {
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'active',
      },
      expiresIn: 540,
    });

    const callbackPath = '/api/v1/admin/auth/sso/github/callback';
    const req = {
      headers: {
        cookie: `${ADMIN_SSO_STATE_COOKIE}=valid-state`,
      },
      originalUrl: `${callbackPath}?code=code123&state=valid-state`,
    } as unknown as Request;
    const res = mockResponse();

    await controller.callback('code123', 'valid-state', req, res);

    // Successful login redirects to the app root.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res.redirect).toHaveBeenCalledWith('/');

    // An audit row must be recorded for the SSO login (GET bypasses the
    // AdminAuditInterceptor which only fires on mutating requests).
    // eslint-disable-next-line @typescript-eslint/unbound-method
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

    await expect(
      prodController.login({ email: 'ops@tarmoto.app', password: 'pw' }, res),
    ).rejects.toThrow(ForbiddenException);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(productionService.loginWithPassword).not.toHaveBeenCalled();
  });
});
