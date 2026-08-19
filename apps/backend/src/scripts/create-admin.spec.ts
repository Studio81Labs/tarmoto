/**
 * Unit tests for the create-admin CLI core — no Nest bootstrap required.
 *
 * Imports only from create-admin-args (pure arg parser) and
 * create-admin-core (pure upsert logic). The CLI entry point
 * (create-admin.ts) is never imported here so its `void main()` call never
 * runs during tests. The stdin prompt and AppDataSource initialisation live
 * in main() and remain untested at the unit level.
 *
 * Covers:
 *  - parseArgs (arg parser from create-admin-args)
 *  - runCreateAdmin (upsert core with a mocked EntityManager)
 */

// Mock hashAdminPassword so bcrypt doesn't slow down the test suite.
jest.mock('../modules/admin-auth/admin-password.js', () => ({
  hashAdminPassword: jest.fn((plain: string) =>
    Promise.resolve(`hashed:${plain}`),
  ),
}));

import { EntityManager } from 'typeorm';
import { AdminUser } from '../entities/admin-user.entity.js';
import { AdminSession } from '../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../entities/admin-refresh-token.entity.js';
import { hashAdminPassword } from '../modules/admin-auth/admin-password.js';
import { parseArgs, VALID_ROLES } from './create-admin-args.js';
import { runCreateAdmin, CreateAdminResult } from './create-admin-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PerEntityRepos {
  adminUserRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  adminSessionRepo: {
    find: jest.Mock;
    update: jest.Mock;
  };
  adminRefreshTokenRepo: {
    update: jest.Mock;
  };
}

function makeManager(
  existing: AdminUser | null = null,
  sessions: Pick<AdminSession, 'id'>[] = [],
): { manager: jest.Mocked<EntityManager> } & PerEntityRepos {
  const adminUserRepo = {
    findOne: jest.fn().mockResolvedValue(existing),
    save: jest
      .fn()
      .mockImplementation((entity: AdminUser) =>
        Promise.resolve({ ...entity, id: 'uuid-1' }),
      ),
    create: jest.fn().mockImplementation((data: Partial<AdminUser>) => ({
      ...data,
    })),
  };

  const adminSessionRepo = {
    find: jest.fn().mockResolvedValue(sessions),
    update: jest.fn().mockResolvedValue({ affected: sessions.length }),
  };

  const adminRefreshTokenRepo = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  const manager = {
    getRepository: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === AdminUser) return adminUserRepo;
      if (entity === AdminSession) return adminSessionRepo;
      if (entity === AdminRefreshToken) return adminRefreshTokenRepo;
      throw new Error(`Unexpected entity in mock: ${String(entity)}`);
    }),
  } as unknown as jest.Mocked<EntityManager>;

  return { manager, adminUserRepo, adminSessionRepo, adminRefreshTokenRepo };
}

// ---------------------------------------------------------------------------
// parseArgs (from create-admin-args)
// ---------------------------------------------------------------------------

describe('create-admin parseArgs', () => {
  describe('defaults', () => {
    it('sets role=admin and ssoOnly=false for an empty argv', () => {
      const { options } = parseArgs([]);
      expect(options.role).toBe('admin');
      expect(options.ssoOnly).toBe(false);
      expect(options.help).toBe(false);
      expect(options.email).toBe('');
    });

    it('ignores the bare `--` separator pnpm forwards', () => {
      const { options } = parseArgs(['--', '--email=ops@tarmoto.app']);
      expect(options.email).toBe('ops@tarmoto.app');
      expect(options.role).toBe('admin');
    });
  });

  describe('--email', () => {
    it('parses --email=addr and lowercases+trims it', () => {
      const { options } = parseArgs(['--email=  OPS@Tarmoto.App  ']);
      expect(options.email).toBe('ops@tarmoto.app');
    });

    it('rejects an empty --email value', () => {
      expect(() => parseArgs(['--email='])).toThrow(/must not be empty/);
    });

    it('requires a value (no bare --email)', () => {
      expect(() => parseArgs(['--email'])).toThrow(/requires a value/);
    });
  });

  describe('--role', () => {
    it.each(VALID_ROLES)('accepts role=%s', (role) => {
      expect(parseArgs([`--role=${role}`]).options.role).toBe(role);
    });

    it('rejects an unknown role with a clear message', () => {
      expect(() => parseArgs(['--role=superuser'])).toThrow(
        /Invalid --role "superuser"/,
      );
    });

    it('defaults to admin when --role is omitted', () => {
      expect(parseArgs([]).options.role).toBe('admin');
    });
  });

  describe('--password', () => {
    it('throws a helpful error when --password=x is passed on the command line', () => {
      expect(() => parseArgs(['--password=x'])).toThrow(
        /do not pass the admin password on the command line/i,
      );
    });

    it('throws a helpful error when --password is passed without a value', () => {
      expect(() => parseArgs(['--password'])).toThrow(
        /do not pass the admin password on the command line/i,
      );
    });
  });

  describe('--sso-only', () => {
    it('parses --sso-only as a valueless flag', () => {
      expect(parseArgs(['--sso-only']).options.ssoOnly).toBe(true);
    });

    it('rejects --sso-only=value', () => {
      expect(() => parseArgs(['--sso-only=yes'])).toThrow(
        /does not take a value/,
      );
    });
  });

  describe('--help', () => {
    it('sets help=true', () => {
      expect(parseArgs(['--help']).options.help).toBe(true);
    });
  });

  describe('strict parsing', () => {
    it('rejects unknown flags', () => {
      expect(() => parseArgs(['--wat'])).toThrow(/Unknown argument: --wat/);
    });

    it('rejects bare (non --) tokens', () => {
      expect(() => parseArgs(['-sso-only'])).toThrow(/must start with "--"/);
    });

    it('combines multiple flags', () => {
      const { options } = parseArgs([
        '--email=ops@tarmoto.app',
        '--role=support',
        '--sso-only',
      ]);
      expect(options.email).toBe('ops@tarmoto.app');
      expect(options.role).toBe('support');
      expect(options.ssoOnly).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// runCreateAdmin — create path
// ---------------------------------------------------------------------------

describe('runCreateAdmin – create', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new row, hashes the password, returns {created:true, sessionsRevoked:false}', async () => {
    const { manager, adminUserRepo } = makeManager(null);
    const result: CreateAdminResult = await runCreateAdmin(
      manager,
      {
        email: 'new@tarmoto.app',
        role: 'admin',
        ssoOnly: false,
        help: false,
      },
      'plaintext',
    );

    expect(result).toEqual({
      created: true,
      email: 'new@tarmoto.app',
      role: 'admin',
      sessionsRevoked: false,
    });

    // hashAdminPassword was called with the plaintext — never store plaintext
    expect(hashAdminPassword).toHaveBeenCalledWith('plaintext');

    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:plaintext');
    expect(saved.email).toBe('new@tarmoto.app');
    expect(saved.role).toBe('admin');
    expect(saved.status).toBe('active');
  });

  it('creates an SSO-only row with password_hash=null, no revoke', async () => {
    const { manager, adminUserRepo, adminSessionRepo } = makeManager(null);
    const result = await runCreateAdmin(
      manager,
      {
        email: 'sso@tarmoto.app',
        role: 'support',
        ssoOnly: true,
        help: false,
      },
      null,
    );

    expect(result).toEqual({
      created: true,
      email: 'sso@tarmoto.app',
      role: 'support',
      sessionsRevoked: false,
    });
    expect(hashAdminPassword).not.toHaveBeenCalled();

    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();

    // No sessions to revoke on a fresh create
    expect(adminSessionRepo.update).not.toHaveBeenCalled();
  });

  it('hashes the password passed in directly', async () => {
    const { manager } = makeManager(null);
    await runCreateAdmin(
      manager,
      {
        email: 'env@tarmoto.app',
        role: 'read_only',
        ssoOnly: false,
        help: false,
      },
      'envpw',
    );

    expect(hashAdminPassword).toHaveBeenCalledWith('envpw');
  });

  it('throws when email is empty', async () => {
    const { manager } = makeManager(null);
    await expect(
      runCreateAdmin(
        manager,
        {
          email: '',
          role: 'admin',
          ssoOnly: false,
          help: false,
        },
        'pw',
      ),
    ).rejects.toThrow(/--email is required/);
  });

  it('throws when no password is provided and not sso-only (CREATE path)', async () => {
    const { manager } = makeManager(null);
    await expect(
      runCreateAdmin(
        manager,
        {
          email: 'nopw@tarmoto.app',
          role: 'admin',
          ssoOnly: false,
          help: false,
        },
        null,
      ),
    ).rejects.toThrow(/a password is required for a new admin/i);
  });
});

// ---------------------------------------------------------------------------
// runCreateAdmin — update path
// ---------------------------------------------------------------------------

describe('runCreateAdmin – update', () => {
  beforeEach(() => jest.clearAllMocks());

  function existingUser(overrides: Partial<AdminUser> = {}): AdminUser {
    return {
      id: 'existing-uuid',
      email: 'existing@tarmoto.app',
      password_hash: 'old-hash',
      role: 'read_only',
      status: 'active',
      sso_provider: null,
      sso_subject: null,
      last_login_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  it('role/status-only rerun: updates role + status, leaves password_hash untouched, NO revoke', async () => {
    const { manager, adminUserRepo, adminSessionRepo, adminRefreshTokenRepo } =
      makeManager(existingUser());

    const result = await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'super_admin',
        ssoOnly: false,
        help: false,
      },
      null, // no password supplied — role/status-only
    );

    // Password hash NOT touched when no password is provided
    expect(hashAdminPassword).not.toHaveBeenCalled();

    expect(result).toEqual({
      created: false,
      email: 'existing@tarmoto.app',
      role: 'super_admin',
      sessionsRevoked: false,
    });

    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.role).toBe('super_admin');
    expect(saved.status).toBe('active');
    expect(saved.password_hash).toBe('old-hash');

    // No credential change → no session revocation
    expect(adminSessionRepo.update).not.toHaveBeenCalled();
    expect(adminRefreshTokenRepo.update).not.toHaveBeenCalled();
  });

  it('reactivating a disabled admin (no credential change) revokes old sessions', async () => {
    const sessions = [{ id: 'sess-1' }] as AdminSession[];
    const { manager, adminUserRepo, adminSessionRepo, adminRefreshTokenRepo } =
      makeManager(existingUser({ status: 'disabled' }), sessions);

    const result = await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'support',
        ssoOnly: false,
        help: false,
      },
      null, // no password — credential unchanged, but disabled→active
    );

    // Credential untouched, but the disabled→active flip must revoke sessions.
    expect(hashAdminPassword).not.toHaveBeenCalled();
    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.status).toBe('active');
    expect(saved.password_hash).toBe('old-hash');

    expect(result.sessionsRevoked).toBe(true);
    expect(adminSessionRepo.update).toHaveBeenCalledTimes(1);
    const [sessionCriteria] = adminSessionRepo.update.mock.calls[0] as [
      unknown,
      unknown,
    ];
    expect(sessionCriteria).toMatchObject({ admin_user_id: 'existing-uuid' });
    expect(adminRefreshTokenRepo.update).toHaveBeenCalledTimes(1);
  });

  it('new password on update → password_hash set AND sessions + refresh tokens revoked', async () => {
    const sessions = [{ id: 'sess-1' }, { id: 'sess-2' }] as AdminSession[];
    const { manager, adminUserRepo, adminSessionRepo, adminRefreshTokenRepo } =
      makeManager(existingUser(), sessions);

    const result = await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        ssoOnly: false,
        help: false,
      },
      'newpassword',
    );

    expect(result).toEqual({
      created: false,
      email: 'existing@tarmoto.app',
      role: 'admin',
      sessionsRevoked: true,
    });

    expect(hashAdminPassword).toHaveBeenCalledWith('newpassword');
    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:newpassword');

    // Sessions revoked
    expect(adminSessionRepo.update).toHaveBeenCalledTimes(1);
    const [sessionCriteria] = adminSessionRepo.update.mock.calls[0] as [
      unknown,
      unknown,
    ];
    expect(sessionCriteria).toMatchObject({ admin_user_id: 'existing-uuid' });

    // Refresh tokens revoked for those sessions
    expect(adminRefreshTokenRepo.update).toHaveBeenCalledTimes(1);
    const [tokenCriteria] = adminRefreshTokenRepo.update.mock.calls[0] as [
      unknown,
      unknown,
    ];
    expect(tokenCriteria).toMatchObject({
      session_id: expect.anything() as unknown, // In(['sess-1','sess-2']) operator
    });
  });

  it('--sso-only when existing had a password → password_hash=null AND sessions revoked', async () => {
    const sessions = [{ id: 'sess-a' }] as AdminSession[];
    const { manager, adminUserRepo, adminSessionRepo } = makeManager(
      existingUser({ password_hash: 'old-hash' }),
      sessions,
    );

    const result = await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'support',
        ssoOnly: true,
        help: false,
      },
      null,
    );

    expect(result).toEqual({
      created: false,
      email: 'existing@tarmoto.app',
      role: 'support',
      sessionsRevoked: true,
    });

    expect(hashAdminPassword).not.toHaveBeenCalled();
    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();

    expect(adminSessionRepo.update).toHaveBeenCalledTimes(1);
  });

  it('--sso-only when existing was already null → NO revoke (no credential change)', async () => {
    const { manager, adminSessionRepo, adminRefreshTokenRepo } = makeManager(
      existingUser({ password_hash: null }),
    );

    const result = await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'support',
        ssoOnly: true,
        help: false,
      },
      null,
    );

    expect(result).toEqual({
      created: false,
      email: 'existing@tarmoto.app',
      role: 'support',
      sessionsRevoked: false,
    });

    // null → null is not a credential change
    expect(adminSessionRepo.update).not.toHaveBeenCalled();
    expect(adminRefreshTokenRepo.update).not.toHaveBeenCalled();
  });

  it('update via env password: hashes and saves', async () => {
    const sessions = [{ id: 'sess-z' }] as AdminSession[];
    const { manager, adminUserRepo } = makeManager(existingUser(), sessions);

    await runCreateAdmin(
      manager,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        ssoOnly: false,
        help: false,
      },
      'envpw',
    );

    expect(hashAdminPassword).toHaveBeenCalledWith('envpw');
    const [[saved]] = adminUserRepo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:envpw');
  });
});
