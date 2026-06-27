/**
 * CLI entry point to create or update an admin_users row in any environment.
 * This is the supported prod-bootstrap path — NODE_ENV is NOT gated (unlike
 * the demo seeder which refuses to run in production without --force).
 *
 * Usage (after `pnpm backend:build`):
 *   node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin --password='...'
 *   node dist/scripts/create-admin.js --email=ops@tarmoto.app --role=admin --sso-only
 *   TARMOTO_ADMIN_PASSWORD='...' node dist/scripts/create-admin.js --email=ops@tarmoto.app
 *
 * From the repo root (build once, then run):
 *   pnpm backend:build && pnpm --filter @tarmoto/backend create-admin -- \
 *     --email=ops@tarmoto.app --role=admin --password='...'
 *
 * SSO-only:
 *   pnpm backend:build && pnpm --filter @tarmoto/backend create-admin -- \
 *     --email=ops@tarmoto.app --role=admin --sso-only
 *
 * Upsert behaviour:
 *   - New email  → INSERT with hashed password (or null for --sso-only), role,
 *                  status 'active'. Logs "Created admin: <email> (<role>)".
 *   - Existing   → UPDATE role + status='active'. Password updated only when
 *                  --password / env var / --sso-only is explicitly given.
 *                  Logs "Updated admin: <email> (<role>)".
 *
 * The pure core (runCreateAdmin, resolvePassword) and arg parser (parseArgs)
 * live in create-admin-core.ts / create-admin-args.ts so they can be
 * unit-tested without booting the Nest context.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module.js';
import { AdminUser } from '../entities/admin-user.entity.js';
import { parseArgs, usage } from './create-admin-args.js';
import { runCreateAdmin } from './create-admin-core.js';

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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);
    const repo = dataSource.getRepository(AdminUser);
    const result = await runCreateAdmin(repo, options);
    const verb = result.created ? 'Created' : 'Updated';
    console.log(`${verb} admin: ${result.email} (${result.role})`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(
    'create-admin failed:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
