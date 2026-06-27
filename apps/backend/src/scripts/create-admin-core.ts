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
 * Resolve the plaintext password from options + env, or throw a clear error
 * when neither is provided and `--sso-only` was not requested.
 *
 * Returns `null` for SSO-only accounts.
 * Returns the password string when a source is found.
 * Throws when no source is available and the account is not SSO-only.
 */
export function resolvePassword(
  options: Pick<CreateAdminOptions, 'password' | 'ssoOnly'>,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (options.ssoOnly) {
    return null;
  }
  if (options.password !== null) {
    return options.password;
  }
  const envPw = env['TARMOTO_ADMIN_PASSWORD'];
  if (envPw !== undefined && envPw.length > 0) {
    return envPw;
  }
  throw new Error(
    'No password source found. ' +
      'Provide --password=<pw>, set TARMOTO_ADMIN_PASSWORD, or pass --sso-only for a password-less SSO account.',
  );
}

/**
 * Return true when the caller supplied an explicit credential instruction:
 * a --password flag, the TARMOTO_ADMIN_PASSWORD env var, or --sso-only.
 * Used on the UPDATE path to decide whether to overwrite the stored credential.
 */
function passwordIsExplicit(
  options: Pick<CreateAdminOptions, 'password' | 'ssoOnly'>,
  env: Record<string, string | undefined>,
): boolean {
  return (
    options.ssoOnly ||
    options.password !== null ||
    (env['TARMOTO_ADMIN_PASSWORD'] ?? '').length > 0
  );
}

/**
 * Core upsert logic. Accepts the TypeORM Repository and resolved options so
 * it can be unit-tested independently of the Nest app context.
 *
 * CREATE path (no existing row):
 *   Requires a password source or --sso-only; throws otherwise.
 *   Inserts a new row with status='active'.
 *
 * UPDATE path (row already exists):
 *   Always updates role + status='active'.
 *   Updates password_hash ONLY when a credential was explicitly provided;
 *   leaves it untouched otherwise (safe no-op).
 *
 * @param repo     TypeORM Repository<AdminUser>
 * @param options  Parsed CLI options (email must be non-empty and lowercased)
 * @param env      Environment record (defaults to process.env). Injected for
 *                 testability — lets tests pass a fake env without mutating
 *                 the real process.env.
 */
export async function runCreateAdmin(
  repo: Repository<AdminUser>,
  options: CreateAdminOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<CreateAdminResult> {
  if (!options.email) {
    throw new Error('--email is required.');
  }

  // Check for an existing row first so that on the UPDATE path we can skip
  // password resolution entirely when no credential was provided.
  const existing = await repo
    .createQueryBuilder('au')
    .addSelect('au.password_hash')
    .where('au.email = :email', { email: options.email })
    .getOne();

  if (existing) {
    // UPDATE: role + status always; password only when explicitly given.
    existing.role = options.role;
    existing.status = 'active';

    if (passwordIsExplicit(options, env)) {
      const plain = resolvePassword(options, env);
      existing.password_hash =
        plain !== null ? await hashAdminPassword(plain) : null;
    }

    await repo.save(existing);
    return { created: false, email: options.email, role: options.role };
  }

  // CREATE: password is mandatory (resolvePassword throws if neither source
  // is available and --sso-only was not passed).
  const plain = resolvePassword(options, env);
  const hash = plain !== null ? await hashAdminPassword(plain) : null;

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
