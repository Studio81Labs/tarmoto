import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
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

function makeManagerMock(
  refreshTokensRepo: object,
  sessionsRepo: object,
): object {
  return {
    getRepository: jest.fn().mockImplementation((entity: unknown): object => {
      if (entity === AdminRefreshToken) return refreshTokensRepo;
      if (entity === AdminSession) return sessionsRepo;
      return repoMock<object>();
    }),
  };
}

function makeDataSource(managerMock: object): DataSource {
  return {
    transaction: jest.fn((cb: (m: object) => Promise<unknown>) =>
      cb(managerMock),
    ),
  } as unknown as DataSource;
}

const noopDataSource = {
  transaction: jest.fn(),
} as unknown as DataSource;

const config = { get: () => 'development' } as unknown as ConfigService;
const jwt = new JwtService({ secret: 'test-secret' });

// ---------------------------------------------------------------------------
// loginWithPassword
// ---------------------------------------------------------------------------

describe('AdminAuthService.loginWithPassword', () => {
  it('rejects unknown email', async () => {
    const users = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.loginWithPassword('nobody@x.io', 'pw'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a user with null password_hash (SSO-only account)', async () => {
    const adminUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      password_hash: null,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.loginWithPassword('ops@tarmoto.app', 'hunter2'),
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
      noopDataSource,
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
    const savedHash = (
      refreshTokens.save as jest.Mock<unknown, [{ token_hash: string }]>
    ).mock.calls[0][0].token_hash;
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
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.loginWithPassword('ops@tarmoto.app', 'hunter2'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('AdminAuthService.refresh', () => {
  const sessionId = 'sess1';
  const userId = 'u1';
  const storedTokenId = 'tok1';
  const newTokenId = 'tok2';

  const adminUser = {
    id: userId,
    email: 'ops@tarmoto.app',
    role: 'admin',
    status: 'active',
    password_hash: null,
  };

  const activeSession = {
    id: sessionId,
    admin_user_id: userId,
    revoked_at: null,
    expires_at: new Date(Date.now() + 3_600_000),
  };

  it('(a) rotates a valid token: old token revoked with replaced_by_token_id, new token returned', async () => {
    const rawToken = 'valid_raw_token';
    const tokenHash = hashRefreshToken(rawToken);
    const storedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    // Outside-transaction repo mocks (used for initial lookups)
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
    });
    const sessions = repoMock({
      findOne: jest.fn().mockResolvedValue(activeSession),
    });
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });

    // Inside-transaction repo mocks (used via manager.getRepository)
    const rtManagerRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn().mockResolvedValue({ id: newTokenId }),
      update: jest.fn(),
    };
    const sessManagerRepo = {
      update: jest.fn(),
    };

    const manager = makeManagerMock(rtManagerRepo, sessManagerRepo);
    const dataSource = makeDataSource(manager);

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      dataSource,
    );

    const result = await service.refresh(rawToken);

    expect(result.user.id).toBe(userId);
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');

    // Old token must be revoked and linked to the new token.
    expect(rtManagerRepo.update).toHaveBeenCalledWith(
      { id: storedTokenId },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        revoked_at: expect.any(Date),
        replaced_by_token_id: newTokenId,
      }),
    );

    // Session last_seen_at must be bumped.
    expect(sessManagerRepo.update).toHaveBeenCalledWith(
      { id: sessionId },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        last_seen_at: expect.any(Date),
      }),
    );
  });

  it('(b) revoked token triggers chain-revocation and throws UnauthorizedException', async () => {
    const rawToken = 'already_revoked_token';
    const tokenHash = hashRefreshToken(rawToken);
    const revokedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: new Date(Date.now() - 1_000), // already revoked
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(revokedToken),
      update: jest.fn(),
    });
    const sessions = repoMock({
      update: jest.fn(),
    });
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;

    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      sessions as never,
      refreshTokens as never,
      dataSource,
    );

    await expect(service.refresh(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Chain-revocation: sessions + refresh tokens bulk-revoked via injected repos.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        revoked_at: expect.any(Date),
      }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        revoked_at: expect.any(Date),
      }),
    );

    // No rotation transaction should be started.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(c) expired token triggers chain-revocation and throws UnauthorizedException', async () => {
    const rawToken = 'expired_raw_token';
    const tokenHash = hashRefreshToken(rawToken);
    const expiredToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() - 1_000), // expired
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(expiredToken),
      update: jest.fn(),
    });
    const sessions = repoMock({
      update: jest.fn(),
    });
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;

    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      sessions as never,
      refreshTokens as never,
      dataSource,
    );

    await expect(service.refresh(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        revoked_at: expect.any(Date),
      }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        revoked_at: expect.any(Date),
      }),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findOrProvisionSsoUser
// ---------------------------------------------------------------------------

describe('AdminAuthService.findOrProvisionSsoUser', () => {
  const provider = 'google';
  const subject = 'sub_abc123';
  const email = 'ops@tarmoto.app';

  it('throws UnauthorizedException when no admin row exists for the email', async () => {
    const users = repoMock({
      // bySso lookup returns null, byEmail lookup returns null
      findOne: jest.fn().mockResolvedValue(null),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, email),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException when the email row exists but is disabled', async () => {
    const disabledUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'disabled',
      sso_provider: null,
      sso_subject: null,
    };
    const users = repoMock({
      // bySso returns null; byEmail returns disabled user
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(disabledUser),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, email),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('links SSO credentials to an existing active admin row and returns the user', async () => {
    const activeUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
    };
    const users = repoMock({
      // bySso returns null; byEmail returns active user
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(activeUser),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );

    const result = await service.findOrProvisionSsoUser(
      provider,
      subject,
      email,
    );
    expect(result.id).toBe('a1');

    // Must persist the SSO link.
    expect(users.update).toHaveBeenCalledWith(
      { id: 'a1' },
      expect.objectContaining({
        sso_provider: provider,
        sso_subject: subject,
      }),
    );
  });

  it('returns immediately when a matching SSO provider+subject row already exists', async () => {
    const linkedUser = {
      id: 'a2',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      sso_provider: provider,
      sso_subject: subject,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(linkedUser),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );

    const result = await service.findOrProvisionSsoUser(
      provider,
      subject,
      email,
    );
    expect(result.id).toBe('a2');

    // No re-linking: only one findOne call (the bySso lookup), no update.
    expect(users.findOne).toHaveBeenCalledTimes(1);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when the existing SSO-matched row is disabled', async () => {
    const disabledLinkedUser = {
      id: 'a3',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'disabled',
      sso_provider: provider,
      sso_subject: subject,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(disabledLinkedUser),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, email),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
