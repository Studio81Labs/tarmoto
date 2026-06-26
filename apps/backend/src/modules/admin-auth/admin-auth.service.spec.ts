import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service.js';
import { hashAdminPassword, hashRefreshToken } from './admin-password.js';

function repoMock<T extends object>(overrides: Partial<T> = {}): T {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((v: unknown) => v),
    save: jest.fn((v: unknown) => v),
    update: jest.fn(),
    ...overrides,
  } as unknown as T;
}

const config = { get: () => 'development' } as unknown as ConfigService;
const jwt = new JwtService({ secret: 'test-secret' });

describe('AdminAuthService.loginWithPassword', () => {
  it('rejects unknown email', async () => {
    const users = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock() as never,
      repoMock() as never,
    );
    await expect(
      service.loginWithPassword('nobody@x.io', 'pw'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('issues tokens for valid credentials', async () => {
    const passwordHash = await hashAdminPassword('hunter2');
    const adminUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      password_hash: passwordHash,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });
    const sessions = repoMock({
      save: jest.fn().mockResolvedValue({ id: 'sess1' }),
    });
    const refreshTokens = repoMock();
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
    );

    const result = await service.loginWithPassword(
      'ops@tarmoto.app',
      'hunter2',
    );
    expect(result.user).toEqual({
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
    });
    expect(typeof result.accessToken).toBe('string');
    expect(refreshTokens.save).toHaveBeenCalled();
    const savedHash = (refreshTokens.save as jest.Mock).mock.calls[0][0]
      .token_hash;
    // Stored hash must be the SHA-256 of the opaque token, never the raw token.
    expect(savedHash).toBe(hashRefreshToken(result.refreshToken));
  });

  it('rejects a disabled account', async () => {
    const passwordHash = await hashAdminPassword('hunter2');
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue({
        id: 'a1',
        email: 'ops@tarmoto.app',
        role: 'admin',
        status: 'disabled',
        password_hash: passwordHash,
      }),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock() as never,
      repoMock() as never,
    );
    await expect(
      service.loginWithPassword('ops@tarmoto.app', 'hunter2'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
