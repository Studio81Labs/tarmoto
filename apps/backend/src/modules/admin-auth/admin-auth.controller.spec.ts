import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { ADMIN_REFRESH_COOKIE } from './admin-auth.constants.js';

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
    expect(service.loginWithPassword).toHaveBeenCalledWith(
      'ops@tarmoto.app',
      'pw',
    );
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
    expect(service.revoke).toHaveBeenCalledWith('r');
  });
});
