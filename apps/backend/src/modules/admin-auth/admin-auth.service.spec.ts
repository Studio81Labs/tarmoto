import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { hashAdminPassword, hashRefreshToken } from './admin-password.js';
import type { AdminAuditService } from '../admin/admin-audit.interceptor.js';

function repoMock<T extends object = Record<string, jest.Mock>>(
  overrides: Partial<T> = {},
): T {
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

/** Shared no-op audit service used in tests that don't assert on audit calls. */
const noopAudit = {
  record: jest.fn().mockResolvedValue(undefined),
} as unknown as AdminAuditService;

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
      noopAudit,
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
      noopAudit,
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
    const sessions = repoMock<Record<string, jest.Mock>>({
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
      noopAudit,
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
    expect(typeof result.clientNonce).toBe('string');
    expect(result.clientNonce.length).toBeGreaterThan(0);
    expect(refreshTokens.save).toHaveBeenCalled();
    const savedHash = (
      refreshTokens.save as jest.Mock<unknown, [{ token_hash: string }]>
    ).mock.calls[0]![0].token_hash;
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
      noopAudit,
    );
    await expect(
      service.loginWithPassword('ops@tarmoto.app', 'hunter2'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('AdminAuthService.createSession', () => {
  it('stores a client_nonce on the session row and returns it in the tokens', async () => {
    const adminUser = {
      id: 'a1',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      password_hash: null,
    };
    const savedSession = { id: 'sess-nonce-1' };
    const users = repoMock({ findOne: jest.fn().mockResolvedValue(adminUser) });
    const sessions = repoMock<Record<string, jest.Mock>>({
      save: jest.fn().mockResolvedValue(savedSession),
    });
    const refreshTokens = repoMock();

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      noopDataSource,
      noopAudit,
    );

    const result = await service.createSession('a1');

    // clientNonce must be a non-empty hex string.
    expect(typeof result.clientNonce).toBe('string');
    expect(result.clientNonce.length).toBeGreaterThan(0);

    // The saved session row must carry the client_nonce.
    const saveCalls = (
      sessions.save as jest.Mock<unknown, [{ client_nonce: string }]>
    ).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    expect(saveCalls[0]![0].client_nonce).toBe(result.clientNonce);
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
  const clientNonce = 'matching-nonce-hex-abc123';

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
    client_nonce: clientNonce,
  };

  it('(a) rotates a valid token: claim succeeds, old token revoked and linked to new token, session bumped, tokens include clientNonce', async () => {
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
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
    });
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });

    // Inside-transaction repo mocks (used via manager.getRepository).
    // The first update call is the claim — must return affected: 1 so rotation proceeds.
    const rtManagerRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn().mockResolvedValue({ id: newTokenId }),
      update: jest.fn().mockResolvedValueOnce({ affected: 1 }),
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
      noopAudit,
    );

    const result = await service.refresh(rawToken, clientNonce);

    expect(result.user.id).toBe(userId);
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    // Returned tokens must carry the session's client nonce.
    expect(result.clientNonce).toBe(clientNonce);

    // Claim call: conditional revoke gated on revoked_at IS NULL.
    expect(rtManagerRepo.update).toHaveBeenCalledWith(
      { id: storedTokenId, revoked_at: IsNull() },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        revoked_at: expect.any(Date),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        last_used_at: expect.any(Date),
      }),
    );

    // Replacement-link call: sets replaced_by_token_id on the (already claimed) old row.
    expect(rtManagerRepo.update).toHaveBeenCalledWith(
      { id: storedTokenId },
      { replaced_by_token_id: newTokenId },
    );

    // Session last_seen_at must be bumped.
    expect(sessManagerRepo.update).toHaveBeenCalledWith(
      { id: sessionId },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        last_seen_at: expect.any(Date),
      }),
    );
  });

  it('(b) revoked token with missing client nonce — foreign jar: gate fires, chain-revokes, and throws 401', async () => {
    const rawToken = 'already_revoked_token';
    const tokenHash = hashRefreshToken(rawToken);
    const revokedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: new Date(Date.now() - 1_000), // already revoked
      expires_at: new Date(Date.now() + 3_600_000),
    };

    // Session has a stored nonce — the gate checks nonce BEFORE the revoked
    // check, so missing nonce triggers revocation regardless of token state.
    const sessionWithNonce = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
      client_nonce: clientNonce,
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(revokedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(sessionWithNonce),
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
      noopAudit,
    );

    // No client nonce presented (e.g., cookie absent) — gate fires.
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

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(c) plain expiry (not revoked, expires_at past) with matching nonce — normal lifetime end: throws 401 WITHOUT chain-revocation', async () => {
    const rawToken = 'expired_raw_token';
    const tokenHash = hashRefreshToken(rawToken);
    const expiredToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null, // NOT explicitly revoked
      expires_at: new Date(Date.now() - 1_000), // simply expired
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(expiredToken),
      update: jest.fn(),
    });
    // Session has a nonce so the gate passes; the expiry check is what throws.
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
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
      noopAudit,
    );

    // Present the matching nonce so the gate passes; only the expiry check throws.
    await expect(service.refresh(rawToken, clientNonce)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Plain expiry is not an attack — must NOT revoke the session family.
    expect(sessions.update).not.toHaveBeenCalled();
    expect(refreshTokens.update).not.toHaveBeenCalled();
    // No rotation transaction should be started.

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(d) in-tx claim-loser with matching nonce (same jar) — benign race: throws 401, family NOT revoked, no token minted', async () => {
    const rawToken = 'valid_raw_token_concurrent';
    const tokenHash = hashRefreshToken(rawToken);
    const storedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    // Outside-transaction repo mocks (pre-transaction lookups pass normally).
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
    });
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });

    // Inside-transaction mocks: claim returns affected: 0 (losing tab in a concurrent race).
    const rtManagerRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
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
      noopAudit,
    );

    // Present the matching nonce — same browser jar as the winning tab.
    await expect(service.refresh(rawToken, clientNonce)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Benign race: the winning tab's new token is already in the shared cookie jar.
    // The losing tab must NOT revoke the session family.
    expect(sessManagerRepo.update).not.toHaveBeenCalled();

    expect(sessions.update).not.toHaveBeenCalled();

    // No new token must be minted — the loser must not issue tokens.
    expect(rtManagerRepo.save).not.toHaveBeenCalled();
  });

  it('(d2) in-tx claim-loser with mismatched nonce — genuine reuse: throws 401 and revokes family', async () => {
    const rawToken = 'valid_raw_token_concurrent_evil';
    const tokenHash = hashRefreshToken(rawToken);
    const storedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
      update: jest.fn(),
    });
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });

    // claim returns affected: 0 — someone else claimed first.
    const rtManagerRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const sessManagerRepo = { update: jest.fn() };

    const manager = makeManagerMock(rtManagerRepo, sessManagerRepo);
    const dataSource = makeDataSource(manager);

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      dataSource,
      noopAudit,
    );

    // Present a DIFFERENT nonce — foreign jar / potential theft.
    await expect(
      service.refresh(rawToken, 'foreign-nonce-xyz'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Genuine reuse: session family must be revoked via the outer injected repos.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
  });

  it('(d3) in-tx claim-loser with absent nonce — genuine reuse: throws 401 and revokes family', async () => {
    const rawToken = 'valid_raw_token_no_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const storedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
      update: jest.fn(),
    });
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });

    const rtManagerRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const sessManagerRepo = { update: jest.fn() };

    const manager = makeManagerMock(rtManagerRepo, sessManagerRepo);
    const dataSource = makeDataSource(manager);

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      dataSource,
      noopAudit,
    );

    // No nonce presented at all — foreign caller.
    await expect(service.refresh(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
  });

  it('(e) pre-tx revoked token with MATCHING client nonce — same browser jar: throws 401, family NOT revoked', async () => {
    const rawToken = 'revoked_token_matching_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const revokedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: new Date(), // previously consumed
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const sessionWithNonce = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
      client_nonce: clientNonce,
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(revokedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(sessionWithNonce),
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
      noopAudit,
    );

    // Present the matching nonce — same browser jar (e.g., sibling tab).
    await expect(service.refresh(rawToken, clientNonce)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Benign: same browser jar — the session family must stay alive.
    expect(sessions.update).not.toHaveBeenCalled();
    expect(refreshTokens.update).not.toHaveBeenCalled();

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(f) pre-tx revoked token with MISMATCHED client nonce — foreign jar: chain-revokes and throws 401', async () => {
    const rawToken = 'revoked_token_wrong_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const revokedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: new Date(Date.now() - 30_000), // revoked 30 seconds ago
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const sessionWithNonce = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
      client_nonce: clientNonce,
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(revokedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(sessionWithNonce),
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
      noopAudit,
    );

    // Present a DIFFERENT nonce — foreign jar, genuine replay.
    await expect(
      service.refresh(rawToken, 'foreign-nonce-different'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Genuine replay: must revoke the session family.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('unknown token — not found: throws 401, nothing revoked', async () => {
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({ update: jest.fn() });
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;

    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      sessions as never,
      refreshTokens as never,
      dataSource,
      noopAudit,
    );

    await expect(
      service.refresh('totally-unknown-token', clientNonce),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessions.update).not.toHaveBeenCalled();
    expect(refreshTokens.update).not.toHaveBeenCalled();

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(h1) still-VALID token with MISSING nonce — foreign jar steals refresh cookie: gate revokes family, throws 401, no token minted', async () => {
    // This is the P1 hole: attacker copies only tarmoto_admin_refresh cookie
    // (without the tarmoto_admin_client nonce) and uses the still-valid token
    // before the legitimate browser rotates it.  The gate must fire and
    // revoke the entire session family WITHOUT entering the transaction.
    const rawToken = 'valid_stolen_token_no_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const validToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(validToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
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
      noopAudit,
    );

    // No nonce presented — attacker does not have the nonce cookie.
    await expect(service.refresh(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Gate fires: session family must be revoked immediately.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    // No rotation transaction must be started — the attacker must not mint a token.

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(h2) still-VALID token with MISMATCHED nonce — foreign jar: gate revokes family, throws 401, no token minted', async () => {
    const rawToken = 'valid_stolen_token_wrong_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const validToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(validToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
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
      noopAudit,
    );

    // Attacker has a nonce but it does not match the session's stored nonce.
    await expect(
      service.refresh(rawToken, 'attacker-wrong-nonce-xyz'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Gate fires: session family must be revoked immediately.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { session_id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
    // No rotation transaction must be started.

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('(g) pre-tx revoked token with absent nonce (cookie missing) — foreign jar: chain-revokes and throws 401', async () => {
    const rawToken = 'revoked_token_no_nonce';
    const tokenHash = hashRefreshToken(rawToken);
    const revokedToken = {
      id: storedTokenId,
      session_id: sessionId,
      token_hash: tokenHash,
      revoked_at: new Date(),
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const sessionWithNonce = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
      client_nonce: clientNonce,
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(revokedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(sessionWithNonce),
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
      noopAudit,
    );

    // No nonce at all — call without presentedClientNonce.
    await expect(service.refresh(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Must revoke because nonce is absent.
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId, revoked_at: IsNull() },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher is intentional
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe('AdminAuthService.revoke', () => {
  const sessionId = 'sess-rev-1';
  const userId = 'u-rev-1';

  it('returns null when the token is not found', async () => {
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      repoMock(),
      refreshTokens as never,
      noopDataSource,
      noopAudit,
    );
    const result = await service.revoke('unknown-raw-token');
    expect(result).toBeNull();
  });

  it('revokes the session family and returns the actor on success', async () => {
    const storedToken = {
      id: 'tok-rev-1',
      session_id: sessionId,
      token_hash: 'irrelevant',
      revoked_at: null,
    };
    const session = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };
    const adminUser = {
      id: userId,
      email: 'ops@tarmoto.app',
      role: 'super_admin' as const,
      status: 'active' as const,
    };

    const users = repoMock({ findOne: jest.fn().mockResolvedValue(adminUser) });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(session),
      update: jest.fn(),
    });
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
      update: jest.fn(),
    });

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      noopDataSource,
      noopAudit,
    );

    const result = await service.revoke('any-raw-token');

    expect(result).toEqual({
      admin_user_id: userId,
      admin_role: 'super_admin',
    });

    // Session and refresh tokens for that session must be revoked.
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
  });

  it('still revokes the session but returns null when the user row is missing', async () => {
    const storedToken = {
      id: 'tok-rev-2',
      session_id: sessionId,
      token_hash: 'irrelevant',
      revoked_at: null,
    };
    const session = {
      id: sessionId,
      admin_user_id: userId,
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const users = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(session),
      update: jest.fn(),
    });
    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
      update: jest.fn(),
    });

    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
      noopDataSource,
      noopAudit,
    );

    const result = await service.revoke('any-raw-token');

    expect(result).toBeNull();
    // Revocation still happens.
    expect(sessions.update).toHaveBeenCalled();
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
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, [email]),
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
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([disabledUser]),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, [email]),
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
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([activeUser]),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );

    const result = await service.findOrProvisionSsoUser(provider, subject, [
      email,
    ]);
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
      noopAudit,
    );

    const result = await service.findOrProvisionSsoUser(provider, subject, [
      email,
    ]);
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
      noopAudit,
    );
    await expect(
      service.findOrProvisionSsoUser(provider, subject, [email]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException and does NOT update when the email row is already linked to a DIFFERENT SSO identity', async () => {
    // The bySso lookup (provider + subject) returned null, but the byEmail row
    // already has a sso_subject set to a different value. This means a different
    // GitHub account is trying to claim the same verified email — deny it.
    const alreadyLinkedUser = {
      id: 'a4',
      email: 'ops@tarmoto.app',
      role: 'admin',
      status: 'active',
      sso_provider: 'github',
      sso_subject: 'some_other_github_subject', // different from the presenting subject
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([alreadyLinkedUser]),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );

    await expect(
      service.findOrProvisionSsoUser(provider, subject, [email]),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // The existing SSO link must NOT be overwritten.
    expect(users.update).not.toHaveBeenCalled();
  });

  it('finds an admin by a verified SECONDARY email and links SSO for the first time', async () => {
    // The admin's seeded address is secondary@tarmoto.app.
    // GitHub primary is unrelated; secondary@tarmoto.app is in the verified list.
    const adminBySecondary = {
      id: 'a5',
      email: 'secondary@tarmoto.app',
      role: 'super_admin',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      // find returns the admin matched on the secondary email.
      find: jest.fn().mockResolvedValue([adminBySecondary]),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );

    const result = await service.findOrProvisionSsoUser('github', 'gh-999', [
      'primary@github.com',
      'secondary@tarmoto.app',
    ]);
    expect(result.id).toBe('a5');

    // Must link on first-time SSO match.
    expect(users.update).toHaveBeenCalledWith(
      { id: 'a5' },
      expect.objectContaining({
        sso_provider: 'github',
        sso_subject: 'gh-999',
      }),
    );
  });

  it('throws UnauthorizedException when none of the verified emails matches an active admin', async () => {
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );
    await expect(
      service.findOrProvisionSsoUser('github', 'gh-unknown', [
        'nobody@example.com',
        'alsounknown@example.com',
      ]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('links the ACTIVE row and ignores a DISABLED row when both share verified emails', async () => {
    // One of the GitHub verified emails maps to a disabled admin row; another
    // maps to an unlinked active admin row. The disabled row must be ignored
    // and the active row linked.
    const disabledRow = {
      id: 'a6',
      email: 'disabled@tarmoto.app',
      role: 'admin',
      status: 'disabled',
      sso_provider: null,
      sso_subject: null,
    };
    const activeRow = {
      id: 'a7',
      email: 'active@tarmoto.app',
      role: 'admin',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([disabledRow, activeRow]),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );

    const result = await service.findOrProvisionSsoUser('github', 'gh-777', [
      'disabled@tarmoto.app',
      'active@tarmoto.app',
    ]);
    // Disabled row must be ignored; active row returned.
    expect(result.id).toBe('a7');

    // SSO credentials must be linked to the active row only.
    expect(users.update).toHaveBeenCalledWith(
      { id: 'a7' },
      expect.objectContaining({
        sso_provider: 'github',
        sso_subject: 'gh-777',
      }),
    );
  });

  it('throws UnauthorizedException (ambiguous) when verified emails map to TWO DIFFERENT active admin rows', async () => {
    const activeRow1 = {
      id: 'a8',
      email: 'first@tarmoto.app',
      role: 'admin',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
    };
    const activeRow2 = {
      id: 'a9',
      email: 'second@tarmoto.app',
      role: 'super_admin',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([activeRow1, activeRow2]),
      update: jest.fn(),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );

    await expect(
      service.findOrProvisionSsoUser('github', 'gh-888', [
        'first@tarmoto.app',
        'second@tarmoto.app',
      ]),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Must never update when ambiguous.
    expect(users.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AdminAuthService.onModuleInit
// ---------------------------------------------------------------------------

describe('AdminAuthService.onModuleInit', () => {
  it('throws in production when TARMOTO_ADMIN_AUTH_SESSION_SECRET is unset', () => {
    const prodConfig = {
      get: (key: string) => (key === 'NODE_ENV' ? 'production' : undefined),
    } as unknown as ConfigService;
    const service = new AdminAuthService(
      jwt,
      prodConfig,
      repoMock(),
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );
    expect(() => service.onModuleInit()).toThrow(
      /TARMOTO_ADMIN_AUTH_SESSION_SECRET/,
    );
  });

  it('does not throw in development when secret is unset', () => {
    const devConfig = {
      get: (key: string) => (key === 'NODE_ENV' ? 'development' : undefined),
    } as unknown as ConfigService;
    const service = new AdminAuthService(
      jwt,
      devConfig,
      repoMock(),
      repoMock(),
      repoMock(),
      noopDataSource,
      noopAudit,
    );
    expect(() => service.onModuleInit()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdminAuthService.refresh — denied audit on nonce-mismatch revocation
// ---------------------------------------------------------------------------

describe('AdminAuthService.refresh denied audit', () => {
  const sessionId = 'sess-audit-1';
  const userId = 'u-audit-1';
  const clientNonce = 'correct-nonce-abc';

  const activeSession = {
    id: sessionId,
    admin_user_id: userId,
    revoked_at: null,
    expires_at: new Date(Date.now() + 3_600_000),
    client_nonce: clientNonce,
  };

  it('records a denied audit row with reason nonce_mismatch when the nonce gate fires and revokes', async () => {
    const rawToken = 'valid-token-for-audit-test';
    const storedToken = {
      id: 'tok-audit-1',
      session_id: sessionId,
      token_hash: hashRefreshToken(rawToken),
      revoked_at: null,
      expires_at: new Date(Date.now() + 3_600_000),
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(storedToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
      update: jest.fn(),
    });
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AdminAuditService;
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;

    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      sessions as never,
      refreshTokens as never,
      dataSource,
      auditSpy,
    );

    // Wrong nonce triggers the gate.
    await expect(
      service.refresh(rawToken, 'wrong-nonce-xyz'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Denied audit row must be recorded with reason nonce_mismatch.

    expect(auditSpy.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_key: 'admin.auth.refresh',
        outcome: 'denied',
        admin_user_id: userId,
        target_type: 'admin_session',
        target_id: sessionId,
        metadata: { reason: 'nonce_mismatch' },
      }),
    );
  });

  it('does NOT record a denied audit row for benign refresh paths (plain expiry, same-jar replay)', async () => {
    // Plain expiry — gate passes (matching nonce), but token is expired.
    const rawToken = 'expired-token-benign';
    const expiredToken = {
      id: 'tok-exp-1',
      session_id: sessionId,
      token_hash: hashRefreshToken(rawToken),
      revoked_at: null,
      expires_at: new Date(Date.now() - 1_000), // expired
    };

    const refreshTokens = repoMock({
      findOne: jest.fn().mockResolvedValue(expiredToken),
      update: jest.fn(),
    });
    const sessions = repoMock<Record<string, jest.Mock>>({
      findOne: jest.fn().mockResolvedValue(activeSession),
      update: jest.fn(),
    });
    const auditSpy = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AdminAuditService;
    const dataSource = { transaction: jest.fn() } as unknown as DataSource;

    const service = new AdminAuthService(
      jwt,
      config,
      repoMock(),
      sessions as never,
      refreshTokens as never,
      dataSource,
      auditSpy,
    );

    // Matching nonce — gate passes; plain expiry path throws without revoking.
    await expect(service.refresh(rawToken, clientNonce)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // No denied audit row must be recorded for a benign expiry.

    expect(auditSpy.record).not.toHaveBeenCalled();
  });
});
