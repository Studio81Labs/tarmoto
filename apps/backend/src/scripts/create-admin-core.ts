/**
 * Pure core for the create-admin CLI. Extracted so it can be unit-tested
 * without booting the Nest application context (mirrors the args-module
 * pattern used by seed-demo-data and cluster-fun-zones).
 */

import { EntityManager } from 'typeorm';
import { AdminUser, AdminRole } from '../entities/admin-user.entity.js';
import { hashAdminPassword } from '../modules/admin-auth/admin-password.js';
import { revokeAdminSessions } from '../modules/admin-auth/admin-session-revoke.js';
import { CreateAdminOptions } from './create-admin-args.js';

export interface CreateAdminResult {
  created: boolean;
  email: string;
  role: AdminRole;
  sessionsRevoked: boolean;
}

/**
 * Thrown by runCreateAdmin when failIfExists=true and the email is already
 * taken — either because the pre-insert findOne found the row, or because
 * the INSERT itself hit a unique-violation (Postgres code 23505, the narrow
 * race where findOne missed but a concurrent INSERT committed first).
 *
 * Callers that set failIfExists=true should catch this and convert it to a
 * 409 ConflictException. The default upsert path (failIfExists=false, used
 * by the CLI) never throws this error.
 */
export class AdminAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`Admin with email '${email}' already exists.`);
    this.name = 'AdminAlreadyExistsError';
  }
}

/**
 * Core upsert logic. Accepts a TypeORM EntityManager, resolved options, and the
 * already-resolved plaintext password (or null) so it can be unit-tested
 * independently of any DB context and without any I/O.
 *
 * The caller (main) is responsible for resolving the password from the
 * environment, stdin, or interactive prompt before invoking this function.
 * The password is never read from argv — that path leaks secrets via shell
 * history and process listings.
 *
 * CREATE path (no existing row):
 *   For non-sso-only accounts, requires a non-null, non-empty password; throws
 *   otherwise. Inserts a new row with status='active'. No sessions to revoke.
 *
 * UPDATE path (row already exists):
 *   Always updates role + status='active'.
 *   --sso-only → sets password_hash=null; revokes sessions if the existing
 *     hash was non-null (credential change).
 *   password provided (non-null) → updates password_hash; always revokes sessions.
 *   password null + not sso-only → leaves password_hash untouched; no revoke
 *     (role/status-only rerun).
 *
 * @param manager       TypeORM EntityManager — gives access to all three tables
 *                      (admin_users, admin_sessions, admin_refresh_tokens).
 * @param options       Parsed CLI options (email must be non-empty and lowercased).
 * @param password      Resolved plaintext password, or null for SSO-only /
 *                      role-only reruns. Never pass an argv value here — the
 *                      caller must resolve it from env / stdin only.
 * @param failIfExists  When true, the function is strictly insert-only:
 *                      - If the pre-insert findOne finds an existing row, it
 *                        throws AdminAlreadyExistsError instead of updating.
 *                      - If the INSERT hits a Postgres unique-violation (23505)
 *                        it also throws AdminAlreadyExistsError.
 *                      Defaults to false so the CLI retains its upsert
 *                      behaviour unchanged.
 */
export async function runCreateAdmin(
  manager: EntityManager,
  options: CreateAdminOptions,
  password: string | null,
  failIfExists = false,
): Promise<CreateAdminResult> {
  if (!options.email) {
    throw new Error('--email is required.');
  }

  const adminRepo = manager.getRepository(AdminUser);

  // Select password_hash explicitly — the column is select:false on the entity
  // so a default find() would omit it, making credential-change detection impossible.
  const existing = await adminRepo.findOne({
    where: { email: options.email },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      password_hash: true,
    },
  });

  if (existing) {
    // In insert-only mode (failIfExists=true), an existing row is a conflict:
    // reject instead of mutating the row via the UPDATE path.
    if (failIfExists) {
      throw new AdminAlreadyExistsError(options.email);
    }

    // UPDATE: role + status always; credential only when explicitly provided.
    // Reactivating a disabled admin must also revoke old sessions: InternalGuard
    // only blocks pre-disable sessions while the row is disabled, so flipping it
    // back to active would otherwise revive any still-unexpired session/cookie.
    const reactivated = existing.status !== 'active';
    existing.role = options.role;
    existing.status = 'active';

    let credentialChanged = false;

    if (options.ssoOnly) {
      // Nulling a previously-set hash is a credential change.
      credentialChanged = existing.password_hash !== null;
      existing.password_hash = null;
    } else if (password !== null) {
      existing.password_hash = await hashAdminPassword(password);
      credentialChanged = true;
    }
    // else: leave existing.password_hash unchanged — role/status-only rerun.

    await adminRepo.save(existing);

    let sessionsRevoked = false;
    if (credentialChanged || reactivated) {
      await revokeAdminSessions(manager, existing.id);
      sessionsRevoked = true;
    }

    return {
      created: false,
      email: options.email,
      role: options.role,
      sessionsRevoked,
    };
  }

  // CREATE: non-sso-only accounts require a non-empty password.
  if (!options.ssoOnly && (password === null || password.length === 0)) {
    throw new Error(
      'a password is required for a new admin (set TARMOTO_ADMIN_PASSWORD, pipe via stdin, or use --sso-only).',
    );
  }

  const hash =
    password !== null && password.length > 0
      ? await hashAdminPassword(password)
      : null;

  const admin = adminRepo.create({
    email: options.email,
    role: options.role,
    status: 'active',
    password_hash: hash,
    sso_provider: null,
    sso_subject: null,
    last_login_at: null,
  });

  // When in insert-only mode, convert a Postgres unique-violation (23505) from
  // the INSERT into AdminAlreadyExistsError. This handles the narrow race where
  // the findOne above returned null but a concurrent INSERT committed between
  // that read and this save.
  try {
    await adminRepo.save(admin);
  } catch (err: unknown) {
    if (
      failIfExists &&
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === '23505'
    ) {
      throw new AdminAlreadyExistsError(options.email);
    }
    throw err;
  }

  return {
    created: true,
    email: options.email,
    role: options.role,
    sessionsRevoked: false,
  };
}
