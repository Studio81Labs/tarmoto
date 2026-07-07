/**
 * CLI entry point to populate the configured Tarmoto database with demo
 * accounts and activity (rides, roads, trips, hazards, reviews, badges,
 * follows) so every app state can be exercised locally.
 *
 * Usage (after `pnpm backend:build`):
 *   node dist/scripts/seed-demo-data.js
 *   node dist/scripts/seed-demo-data.js --only=road.hunter@tarmoto.app
 *   node dist/scripts/seed-demo-data.js --clean
 *
 * Or from the repo root: `pnpm db:seed`.
 *
 * Reads from and writes to the same database, so a real connection (and
 * applied migrations) is required. Designed to be safe to re-run: existing
 * demo data is deleted before each run. Refuses to touch a production
 * database unless `--force` is passed.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { BadgesService } from '../modules/badges/badges.service.js';
import { parseArgs, usage } from './seed-demo-data-args.js';
import { DemoSeeder } from './demo-seed/demo-seeder.js';
import { bootstrapScriptContext } from './bootstrap-script-context.js';

async function main(): Promise<void> {
  const { options } = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (process.env.NODE_ENV === 'production' && !options.force) {
    throw new Error(
      'Refusing to seed demo data while NODE_ENV=production. ' +
        'Re-run with --force if this is intentional.',
    );
  }

  // Workers + scheduler disabled for this one-off seed (see helper rationale).
  const app = await bootstrapScriptContext();

  try {
    const seeder = new DemoSeeder(app.get(DataSource), app.get(BadgesService));

    if (options.clean) {
      const { usersDeleted, roadsDeleted } = await seeder.clean();
      console.log('Demo data cleaned:');
      console.log(`  accounts deleted : ${usersDeleted}`);
      console.log(`  demo roads deleted: ${roadsDeleted}`);
      return;
    }

    const result = await seeder.run({ only: options.only });
    console.log('Demo data seeded:');
    console.log(`  accounts     : ${result.usersCreated}`);
    console.log(`  demo roads   : ${result.roadsAvailable}`);
    console.log(`  rides        : ${result.ridesCreated}`);
    console.log(`  hazards      : ${result.hazardsCreated}`);
    console.log(`  road reviews : ${result.reviewsCreated}`);
    console.log(`  shared rides : ${result.sharedRidesCreated}`);
    console.log(`  trips        : ${result.tripsCreated}`);
    console.log(`  follows      : ${result.followsCreated}`);
    console.log(`  badges earned: ${result.badgesAwarded}`);
    console.log(`  passes ensured: ${result.passesEnsured}`);
    console.log(`  closures     : ${result.closuresCreated}`);
    console.log('');
    console.log("Demo accounts (each account's password is its own email):");
    console.log('  newbie@tarmoto.app          — fresh signup, no badges');
    console.log('  weekend.warrior@tarmoto.app — mid-tier rider, premium');
    console.log('  road.hunter@tarmoto.app     — power user, pro, gold badges');
    console.log('  trip.planner@tarmoto.app    — multi-day trips, premium');
    console.log('  community.scout@tarmoto.app — hazards & reviews, premium');
    console.log(
      '  brno.rider@tarmoto.app      — real recorded rides + trips, premium',
    );
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('seed-demo-data failed:', err);
  process.exit(1);
});
