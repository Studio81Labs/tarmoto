/**
 * Argument parser for `create-admin`. Lives in its own module so unit tests
 * can exercise it without booting the Nest app (mirrors
 * `seed-demo-data-args.ts`).
 */

import { AdminRole } from '../entities/admin-user.entity.js';

export const VALID_ROLES: AdminRole[] = [
  'read_only',
  'support',
  'admin',
  'super_admin',
];

export interface CreateAdminOptions {
  /** Target admin email (lowercased + trimmed). Required. */
  email: string;
  /** Role to assign. Defaults to 'admin'. */
  role: AdminRole;
  /**
   * Plaintext password provided via --password flag. `null` when not
   * provided via argv (caller should then check the env var or --sso-only).
   * Never stored or logged.
   */
  password: string | null;
  /** When true create/update a password-less SSO-only row. */
  ssoOnly: boolean;
  /** Print usage and exit. */
  help: boolean;
}

export interface ParsedAdminArgs {
  options: CreateAdminOptions;
}

// Boolean flags that must not be given a value.
const VALUELESS_FLAGS = new Set(['sso-only', 'help']);

// Value flags that require `=value`.
const VALUE_FLAGS = new Set(['email', 'role', 'password']);

export function parseArgs(argv: string[]): ParsedAdminArgs {
  const options: CreateAdminOptions = {
    email: '',
    role: 'admin',
    password: null,
    ssoOnly: false,
    help: false,
  };

  for (const raw of argv) {
    if (raw.length === 0) continue;
    if (!raw.startsWith('--')) {
      throw new Error(
        `Unknown argument: "${raw}". Flags must start with "--".`,
      );
    }

    const stripped = raw.replace(/^--/, '');
    const eqIdx = stripped.indexOf('=');
    const key = (
      eqIdx === -1 ? stripped : stripped.slice(0, eqIdx)
    ).toLowerCase();
    const valueRaw = eqIdx === -1 ? undefined : stripped.slice(eqIdx + 1);

    if (VALUELESS_FLAGS.has(key)) {
      if (valueRaw !== undefined) {
        throw new Error(`Argument --${key} does not take a value.`);
      }
      if (key === 'sso-only') options.ssoOnly = true;
      else options.help = true;
      continue;
    }

    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown argument: --${key}`);
    }
    if (valueRaw === undefined) {
      throw new Error(`Argument ${raw} requires a value (use --${key}=value).`);
    }

    if (key === 'email') {
      const email = valueRaw.trim().toLowerCase();
      if (email.length === 0) {
        throw new Error('--email value must not be empty.');
      }
      options.email = email;
    } else if (key === 'role') {
      const role = valueRaw.trim() as AdminRole;
      if (!VALID_ROLES.includes(role)) {
        throw new Error(
          `Invalid --role "${role}". Valid roles: ${VALID_ROLES.join(', ')}.`,
        );
      }
      options.role = role;
    } else if (key === 'password') {
      if (valueRaw.length === 0) {
        throw new Error('--password value must not be empty.');
      }
      options.password = valueRaw;
    }
  }

  return { options };
}

export function usage(): string {
  return [
    'Usage: node dist/scripts/create-admin.js [options]',
    '',
    'Create or update an admin_users row in any environment. Safe to re-run:',
    'existing rows are updated (role + status; password only if provided).',
    '',
    'Options:',
    '  --email=<addr>         (required) Admin email address.',
    '  --role=<role>          Role to assign (default: admin).',
    `                         Valid: ${VALID_ROLES.join(', ')}.`,
    '  --password=<pw>        Plaintext password to hash and store.',
    '                         Alternatively set TARMOTO_ADMIN_PASSWORD env var.',
    '  --sso-only             Create a password-less SSO-only row.',
    '                         Mutually exclusive with --password / env var.',
    '  --help                 Show this help.',
    '',
    'Examples:',
    '  # Password via flag',
    "  node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin --password='s3cr3t'",
    '',
    '  # Password via environment variable',
    "  TARMOTO_ADMIN_PASSWORD='s3cr3t' node dist/scripts/create-admin.js --email=ops@tarmoto.app",
    '',
    '  # SSO-only (no password)',
    '  node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=support --sso-only',
    '',
    '  # From repo root after build:',
    "  pnpm backend:build && pnpm --filter @tarmoto/backend create-admin -- --email=ops@tarmoto.app --role=admin --password='...'",
  ].join('\n');
}
