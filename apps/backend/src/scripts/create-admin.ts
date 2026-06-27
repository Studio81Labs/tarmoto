/**
 * CLI entry point to create or update an admin_users row in any environment.
 * This is the supported prod-bootstrap path — NODE_ENV is NOT gated (unlike
 * the demo seeder which refuses to run in production without --force).
 *
 * Usage (after `pnpm backend:build`):
 *   TARMOTO_ADMIN_PASSWORD='...' node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin
 *   printf 'mypassword' | node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin
 *   node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin  # prompts on TTY
 *   node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin --sso-only
 *
 * From the repo root (build once, then run):
 *   pnpm backend:build && TARMOTO_ADMIN_PASSWORD='...' pnpm --filter @tarmoto/backend create-admin -- \
 *     --email=ops@tarmoto.app --role=admin
 *
 * Upsert behaviour:
 *   - New email  → INSERT with hashed password (or null for --sso-only), role,
 *                  status 'active'. Logs "Created admin: <email> (<role>)".
 *   - Existing   → UPDATE role + status='active'. Password updated only when
 *                  env var / stdin / --sso-only is explicitly given.
 *                  Logs "Updated admin: <email> (<role>)".
 *
 * The pure core (runCreateAdmin) and arg parser (parseArgs) live in
 * create-admin-core.ts / create-admin-args.ts so they can be unit-tested
 * without booting any DB context. The password is never read from argv —
 * supply it via TARMOTO_ADMIN_PASSWORD, piped stdin, or the interactive TTY
 * prompt to avoid leaks via shell history and process listings.
 */
import 'reflect-metadata';
import { createInterface } from 'readline';
import { AppDataSource } from '../data-source.js';
import { AdminUser } from '../entities/admin-user.entity.js';
import { parseArgs, usage } from './create-admin-args.js';
import { runCreateAdmin } from './create-admin-core.js';

/**
 * Read a password from the controlling terminal with muted echo, or from
 * piped stdin when no TTY is attached.
 *
 * Returns the trimmed input, which may be an empty string when nothing was
 * typed/piped — the caller is responsible for rejecting empty values.
 */
async function readPassword(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    return new Promise<string>((resolve, reject) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      // Suppress keystroke echo while the prompt is active. `_writeToOutput`
      // is an undocumented but stable seam used by readline-based password
      // prompts across the Node ecosystem (npm, yarn, etc.).
      let muted = false;
      type RlInternal = { _writeToOutput(s: string): void };
      const internal = rl as unknown as RlInternal;
      const originalWrite = internal._writeToOutput.bind(rl);
      internal._writeToOutput = (s: string): void => {
        if (!muted) originalWrite(s);
      };
      rl.question(prompt, (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      // Mute AFTER rl.question() so the prompt itself is written first.
      muted = true;
      rl.on('error', reject);
    });
  }

  // Piped / redirected stdin: read all data and trim.
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += String(chunk);
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const { options } = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (process.env['NODE_ENV'] === 'production') {
    console.log(
      '[create-admin] Running against a production database. Proceeding.',
    );
  }

  // Resolve the password before touching the DB so that any I/O errors fail
  // fast without an open connection.
  let password: string | null;
  if (options.ssoOnly) {
    password = null;
  } else {
    const envPw = process.env['TARMOTO_ADMIN_PASSWORD'];
    if (envPw !== undefined && envPw.length > 0) {
      password = envPw;
    } else {
      const entered = await readPassword('Admin password: ');
      if (entered.length === 0) {
        console.error(
          'Error: no password provided. Set the TARMOTO_ADMIN_PASSWORD env var, ' +
            'pipe the password via stdin, or use --sso-only.',
        );
        process.exit(1);
      }
      password = entered;
    }
  }

  await AppDataSource.initialize();

  try {
    const repo = AppDataSource.getRepository(AdminUser);
    const result = await runCreateAdmin(repo, options, password);
    const verb = result.created ? 'Created' : 'Updated';
    console.log(`${verb} admin: ${result.email} (${result.role})`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((err: unknown) => {
  console.error(
    'create-admin failed:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
