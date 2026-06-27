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
 *  - runCreateAdmin (upsert core with a mocked Repository<AdminUser>)
 */

// Mock hashAdminPassword so bcrypt doesn't slow down the test suite.
jest.mock('../modules/admin-auth/admin-password.js', () => ({
  hashAdminPassword: jest.fn((plain: string) =>
    Promise.resolve(`hashed:${plain}`),
  ),
}));

import { Repository } from 'typeorm';
import { AdminUser } from '../entities/admin-user.entity.js';
import { hashAdminPassword } from '../modules/admin-auth/admin-password.js';
import { parseArgs, VALID_ROLES } from './create-admin-args.js';
import { runCreateAdmin, CreateAdminResult } from './create-admin-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(
  existing: AdminUser | null = null,
): jest.Mocked<
  Pick<Repository<AdminUser>, 'createQueryBuilder' | 'save' | 'create'>
> {
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(existing),
  };

  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    save: jest
      .fn()
      .mockImplementation((entity: AdminUser) =>
        Promise.resolve({ id: 'uuid-1', ...entity }),
      ),
    create: jest.fn().mockImplementation((data: Partial<AdminUser>) => ({
      ...data,
    })),
  };
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

  it('inserts a new row, hashes the password, returns {created:true}', async () => {
    const repo = makeRepo(null);
    const result: CreateAdminResult = await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
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
    });

    // hashAdminPassword was called with the plaintext — never store plaintext
    expect(hashAdminPassword).toHaveBeenCalledWith('plaintext');

    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:plaintext');
    expect(saved.email).toBe('new@tarmoto.app');
    expect(saved.role).toBe('admin');
    expect(saved.status).toBe('active');
  });

  it('creates an SSO-only row with password_hash=null', async () => {
    const repo = makeRepo(null);
    const result = await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'sso@tarmoto.app',
        role: 'support',
        ssoOnly: true,
        help: false,
      },
      null,
    );

    expect(result.created).toBe(true);
    expect(hashAdminPassword).not.toHaveBeenCalled();

    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();
  });

  it('hashes the password passed in directly', async () => {
    const repo = makeRepo(null);
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
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
    const repo = makeRepo(null);
    await expect(
      runCreateAdmin(
        repo as unknown as Repository<AdminUser>,
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

  it('throws when no password is provided and not sso-only', async () => {
    const repo = makeRepo(null);
    await expect(
      runCreateAdmin(
        repo as unknown as Repository<AdminUser>,
        {
          email: 'nopw@tarmoto.app',
          role: 'admin',
          ssoOnly: false,
          help: false,
        },
        null,
      ),
    ).rejects.toThrow(/No password provided/i);
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

  it('updates role + status, returns {created:false}', async () => {
    const repo = makeRepo(existingUser());
    const result = await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'super_admin',
        ssoOnly: false,
        help: false,
      },
      null,
    );

    // Password hash NOT touched when no password is provided
    expect(hashAdminPassword).not.toHaveBeenCalled();

    expect(result).toEqual({
      created: false,
      email: 'existing@tarmoto.app',
      role: 'super_admin',
    });

    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.role).toBe('super_admin');
    expect(saved.status).toBe('active');
    expect(saved.password_hash).toBe('old-hash');
  });

  it('updates password_hash when a password is provided on update', async () => {
    const repo = makeRepo(existingUser());
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        ssoOnly: false,
        help: false,
      },
      'newpassword',
    );

    expect(hashAdminPassword).toHaveBeenCalledWith('newpassword');
    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:newpassword');
  });

  it('sets password_hash=null on update when --sso-only is passed', async () => {
    const repo = makeRepo(existingUser({ password_hash: 'old-hash' }));
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'support',
        ssoOnly: true,
        help: false,
      },
      null,
    );

    expect(hashAdminPassword).not.toHaveBeenCalled();
    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();
  });

  it('updates password_hash via provided password on update path', async () => {
    const repo = makeRepo(existingUser());
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        ssoOnly: false,
        help: false,
      },
      'envpw',
    );

    expect(hashAdminPassword).toHaveBeenCalledWith('envpw');
    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:envpw');
  });
});
