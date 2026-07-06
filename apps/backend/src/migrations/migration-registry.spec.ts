import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDataSource } from '../data-source.js';

/**
 * Guardrail for the migration-orphan class of bugs (#555):
 *
 * Every `*.ts` file in `apps/backend/src/migrations/` MUST be imported
 * AND added to the `migrations: [...]` array on `AppDataSource`.
 * TypeORM's `migration:run` only replays migrations declared on the
 * data source — files that exist on disk but aren't registered get
 * silently skipped, and the column / index / extension they add
 * never lands on a fresh bootstrap. The hazard-photo (#555) and
 * commute-routing-engine-version migrations both shipped this way
 * after timestamp collisions with newer PRs.
 *
 * The check is cheap (filesystem read + array compare) and runs
 * inside the regular unit-test pass, so any future orphan trips
 * here before it can reach prod.
 */
describe('migration registry — every file on disk is registered', () => {
  it('matches data-source `migrations:` against `src/migrations/*.ts`', () => {
    // The test file lives alongside the migration files. Jest runs
    // it from a Node CommonJS-ish loader so `__dirname` resolves to
    // the source path even though the rest of the build is ESM.
    const migrationsDir = join(__dirname, '.');
    const filesOnDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !name.endsWith('.spec.ts'))
      // Filenames look like `<timestamp>-<ClassName>.ts`. The class
      // name follows the convention `<ClassName><timestamp>`, so
      // reassemble that and compare.
      .map((name) => {
        const match = name.match(/^(\d+)-(.+)\.ts$/);
        if (!match) throw new Error(`unexpected migration filename: ${name}`);
        return `${match[2]}${match[1]}`;
      })
      .sort();

    const registered: string[] = (
      (AppDataSource.options.migrations ?? []) as Array<{ name: string }>
    )
      .map((m) => (typeof m === 'function' ? m.name : '???'))
      .sort();

    expect(registered).toEqual(filesOnDisk);
  });

  // The Nest runtime (`migrationsRun: true`) replays migrations from a SEPARATE
  // inline list in database.module.ts, not from AppDataSource. A migration
  // registered only in data-source.ts applies via the CLI but is silently
  // skipped on a fresh runtime bootstrap, so the entity + queries read a column
  // that was never added. The list is inline (not importable), so assert by
  // source text that every migration class is present.
  it('registers every migration in the runtime database.module.ts too', () => {
    const source = readFileSync(
      join(__dirname, '..', 'modules', 'database', 'database.module.ts'),
      'utf8',
    );
    const filesOnDisk = readdirSync(join(__dirname, '.'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .map((name) => {
        const match = name.match(/^(\d+)-(.+)\.ts$/);
        if (!match) throw new Error(`unexpected migration filename: ${name}`);
        return `${match[2]}${match[1]}`;
      });

    const missing = filesOnDisk.filter(
      (className) => !source.includes(className),
    );
    expect(missing).toEqual([]);
  });

  // A migration registered TWICE in the runtime list is as fatal as a
  // missing one: TypeORM refuses to initialize with duplicate migration
  // names, so a fresh bootstrap fails outright. `includes` above can't
  // see this — count the entries of the inline array.
  it('never registers a migration twice in the runtime list', () => {
    const source = readFileSync(
      join(__dirname, '..', 'modules', 'database', 'database.module.ts'),
      'utf8',
    );
    const block = source.match(/migrations:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const entries = block
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const duplicates = entries.filter(
      (entry, index) => entries.indexOf(entry) !== index,
    );
    expect(duplicates).toEqual([]);
  });
});
