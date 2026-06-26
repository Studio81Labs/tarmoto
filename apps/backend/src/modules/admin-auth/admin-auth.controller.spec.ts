import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import {
  ADMIN_REFRESH_COOKIE,
  ADMIN_SSO_STATE_COOKIE,
} from './admin-auth.constants.js';

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

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        { provide: ConfigService, useValue: { get: () => 'development' } },
      ],
    }).compile();
    controller = moduleRef.get(AdminAuthController);
    jest.clearAllMocks();
  });

  it('logs in and sets cookies', async () => {
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
    const res = mockResponse();
    const body = await controller.login(
      { email: 'ops@tarmoto.app', password: 'pw' },
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

  it('logout reads the refresh cookie and clears cookies', async () => {
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
