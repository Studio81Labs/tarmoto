/**
 * Pure core for the create-admin CLI. Extracted so it can be unit-tested
 * without booting the Nest application context (mirrors the args-module
 * pattern used by seed-demo-data and cluster-fun-zones).
 */

import { Repository } from 'typeorm';
import { AdminUser, AdminRole } from '../entities/admin-user.entity.js';
import { hashAdminPassword } from '../modules/admin-auth/admin-password.js';
import { CreateAdminOptions } from './create-admin-args.js';

export interface CreateAdminResult {
  created: boolean;
  email: string;
  role: AdminRole;
}

/**
 * Core upsert logic. Accepts the TypeORM Repository, resolved options, and the
 * already-resolved plaintext password (or null for SSO-only accounts) so it
 * can be unit-tested independently of any DB context and without any I/O.
 *
 * The caller (main) is responsible for resolving the password from the
 * environment, stdin, or interactive prompt before invoking this function.
 * The password is never read from argv — that path leaks secrets via shell
 * history and process listings.
 *
 * CREATE path (no existing row):
 *   For non-sso-only accounts, requires a non-empty password; throws otherwise.
 *   Inserts a new row with status='active'.
 *
 * UPDATE path (row already exists):
 *   Always updates role + status='active'.
 *   Sets password_hash=null when options.ssoOnly is true.
 *   Updates password_hash when a non-null password is provided.
 *   Leaves password_hash untouched when password is null and not sso-only.
 *
 * @param repo      TypeORM Repository<AdminUser>
 * @param options   Parsed CLI options (email must be non-empty and lowercased)
 * @param password  Resolved plaintext password, or null for SSO-only accounts.
 *                  Never pass an argv value here — the caller must resolve it
 *                  from env / stdin only.
 */
export async function runCreateAdmin(
  repo: Repository<AdminUser>,
  options: CreateAdminOptions,
  password: string | null,
): Promise<CreateAdminResult> {
  if (!options.email) {
    throw new Error('--email is required.');
  }

  // Check for an existing row first so that on the UPDATE path we can skip
  // password hashing entirely when no credential was provided.
  const existing = await repo
    .createQueryBuilder('au')
    .addSelect('au.password_hash')
    .where('au.email = :email', { email: options.email })
    .getOne();

  if (existing) {
    // UPDATE: role + status always; password when explicitly provided.
    existing.role = options.role;
    existing.status = 'active';

    if (options.ssoOnly) {
      existing.password_hash = null;
    } else if (password !== null) {
      existing.password_hash = await hashAdminPassword(password);
    }
    // Otherwise leave existing.password_hash unchanged.

    await repo.save(existing);
    return { created: false, email: options.email, role: options.role };
  }

  // CREATE: non-sso-only accounts require a non-empty password.
  if (!options.ssoOnly && (password === null || password.length === 0)) {
    throw new Error(
      'No password provided. Set the TARMOTO_ADMIN_PASSWORD env var, ' +
        'pipe the password via stdin, or use --sso-only for a password-less SSO account.',
    );
  }

  const hash =
    password !== null && password.length > 0
      ? await hashAdminPassword(password)
      : null;

  const admin = repo.create({
    email: options.email,
    role: options.role,
    status: 'active',
    password_hash: hash,
    sso_provider: null,
    sso_subject: null,
    last_login_at: null,
  });
  await repo.save(admin);
  return { created: true, email: options.email, role: options.role };
}
