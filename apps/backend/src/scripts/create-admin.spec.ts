/**
 * Unit tests for the create-admin CLI core — no Nest bootstrap required.
 *
 * Imports only from create-admin-args (pure arg parser) and
 * create-admin-core (pure upsert logic). The CLI entry point
 * (create-admin.ts) is never imported here so its `void main()` call never
 * runs during tests.
 *
 * Covers:
 *  - parseArgs (arg parser from create-admin-args)
 *  - resolvePassword (pure helper from create-admin-core)
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
import {
  runCreateAdmin,
  resolvePassword,
  CreateAdminResult,
} from './create-admin-core.js';

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
      expect(options.password).toBeNull();
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
    it('captures the password value', () => {
      const { options } = parseArgs(['--password=s3cr3t']);
      expect(options.password).toBe('s3cr3t');
    });

    it('rejects an empty --password value', () => {
      expect(() => parseArgs(['--password='])).toThrow(/must not be empty/);
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
// resolvePassword
// ---------------------------------------------------------------------------

describe('resolvePassword', () => {
  it('returns null for --sso-only regardless of other sources', () => {
    expect(
      resolvePassword(
        { password: 's3cr3t', ssoOnly: true },
        { TARMOTO_ADMIN_PASSWORD: 'envpw' },
      ),
    ).toBeNull();
  });

  it('returns the --password flag value when provided', () => {
    expect(resolvePassword({ password: 'flagpw', ssoOnly: false }, {})).toBe(
      'flagpw',
    );
  });

  it('falls back to TARMOTO_ADMIN_PASSWORD when --password is null', () => {
    expect(
      resolvePassword(
        { password: null, ssoOnly: false },
        { TARMOTO_ADMIN_PASSWORD: 'envpw' },
      ),
    ).toBe('envpw');
  });

  it('throws a clear error when neither password source is available', () => {
    expect(() =>
      resolvePassword({ password: null, ssoOnly: false }, {}),
    ).toThrow(/provide --password|TARMOTO_ADMIN_PASSWORD|--sso-only/i);
  });

  it('throws when env var is present but empty', () => {
    expect(() =>
      resolvePassword(
        { password: null, ssoOnly: false },
        { TARMOTO_ADMIN_PASSWORD: '' },
      ),
    ).toThrow();
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
        password: 'plaintext',
        ssoOnly: false,
        help: false,
      },
      {},
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
        password: null,
        ssoOnly: true,
        help: false,
      },
      {},
    );

    expect(result.created).toBe(true);
    expect(hashAdminPassword).not.toHaveBeenCalled();

    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();
  });

  it('picks up password from the env param (TARMOTO_ADMIN_PASSWORD)', async () => {
    const repo = makeRepo(null);
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'env@tarmoto.app',
        role: 'read_only',
        password: null,
        ssoOnly: false,
        help: false,
      },
      { TARMOTO_ADMIN_PASSWORD: 'envpw' },
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
          password: 'pw',
          ssoOnly: false,
          help: false,
        },
        {},
      ),
    ).rejects.toThrow(/--email is required/);
  });

  it('throws when no password source is available and not sso-only', async () => {
    const repo = makeRepo(null);
    await expect(
      runCreateAdmin(
        repo as unknown as Repository<AdminUser>,
        {
          email: 'nopw@tarmoto.app',
          role: 'admin',
          password: null,
          ssoOnly: false,
          help: false,
        },
        {},
      ),
    ).rejects.toThrow(/provide --password|TARMOTO_ADMIN_PASSWORD|--sso-only/i);
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
        password: null,
        ssoOnly: false,
        help: false,
      },
      {},
    );

    // Password hash NOT touched when no explicit password source given
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

  it('updates password_hash when --password is supplied on update', async () => {
    const repo = makeRepo(existingUser());
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        password: 'newpassword',
        ssoOnly: false,
        help: false,
      },
      {},
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
        password: null,
        ssoOnly: true,
        help: false,
      },
      {},
    );

    expect(hashAdminPassword).not.toHaveBeenCalled();
    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBeNull();
  });

  it('updates password_hash via env var on update path', async () => {
    const repo = makeRepo(existingUser());
    await runCreateAdmin(
      repo as unknown as Repository<AdminUser>,
      {
        email: 'existing@tarmoto.app',
        role: 'admin',
        password: null,
        ssoOnly: false,
        help: false,
      },
      { TARMOTO_ADMIN_PASSWORD: 'envpw' },
    );

    expect(hashAdminPassword).toHaveBeenCalledWith('envpw');
    const [[saved]] = repo.save.mock.calls as unknown as [[AdminUser]];
    expect(saved.password_hash).toBe('hashed:envpw');
  });
});
