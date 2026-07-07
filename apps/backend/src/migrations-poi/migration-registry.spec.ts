import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PoiDataSource } from '../data-source.poi.js';

/**
 * Sibling of `../migrations/migration-registry.spec.ts`, for the separate
 * POI database lineage (ADR 0007).
 *
 * The POI lineage has its own TWO registries — `PoiDataSource.options.
 * migrations` (CLI, `data-source.poi.ts`, used by `pnpm db:migrate:poi`)
 * and the inline `migrations: [...]` array in the runtime
 * `poi-database.module.ts` (`migrationsRun: true`) — and, unlike the app
 * DB, neither had an orphan-migration guard. A file added to
 * `src/migrations-poi/` but left out of one (or both) arrays would
 * silently never replay on a fresh POI DB bootstrap — the same
 * #555-shaped class of bug the app DB guard exists to catch.
 */
describe('POI migration registry — every file on disk is registered', () => {
  // The test file lives alongside the migration files. Jest runs it from a
  // Node CommonJS-ish loader so `__dirname` resolves to the source path
  // even though the rest of the build is ESM.
  const migrationsDir = join(__dirname, '.');

  const filesOnDisk = (): string[] =>
    readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !name.endsWith('.spec.ts'))
      // Filenames look like `<timestamp>-<ClassName>.ts`. The class name
      // follows the convention `<ClassName><timestamp>`, so reassemble
      // that and compare.
      .map((name) => {
        const match = name.match(/^(\d+)-(.+)\.ts$/);
        if (!match) throw new Error(`unexpected migration filename: ${name}`);
        return `${match[2]}${match[1]}`;
      })
      .sort();

  // `poi-database.module.ts`'s `migrations: [...]` array isn't importable
  // (it's inline inside a `useFactory`), so read it by source text instead —
  // scoped to just the array block, NOT the whole file. A whole-file
  // `source.includes(className)` would also match the top-of-file `import`
  // line for a class that was removed from the array but whose (now-unused)
  // import was left behind, silently defeating the guard against exactly
  // the orphan-migration failure mode this exists to catch.
  const runtimeModuleMigrationsBlock = (): string => {
    const source = readFileSync(
      join(__dirname, '..', 'modules', 'poi', 'poi-database.module.ts'),
      'utf8',
    );
    return source.match(/migrations:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  };

  it('matches PoiDataSource `migrations:` (the CLI lineage) against `src/migrations-poi/*.ts`', () => {
    const registered: string[] = (
      (PoiDataSource.options.migrations ?? []) as Array<{ name: string }>
    )
      .map((m) => (typeof m === 'function' ? m.name : '???'))
      .sort();

    expect(registered).toEqual(filesOnDisk());
  });

  // The Nest runtime (`migrationsRun: true`) replays migrations from a
  // SEPARATE inline list in poi-database.module.ts, not from PoiDataSource.
  // A migration registered only in data-source.poi.ts applies via the CLI
  // but is silently skipped on a fresh runtime bootstrap, so the entity /
  // queries read a column that was never added.
  it('registers every migration in the runtime poi-database.module.ts too', () => {
    const block = runtimeModuleMigrationsBlock();
    const missing = filesOnDisk().filter(
      (className) => !block.includes(className),
    );
    expect(missing).toEqual([]);
  });

  // A migration registered TWICE in the runtime list is as fatal as a
  // missing one: TypeORM refuses to initialize with duplicate migration
  // names, so a fresh bootstrap fails outright. `includes` above can't see
  // this — count the entries of the inline array.
  it('never registers a migration twice in the runtime list', () => {
    const entries = runtimeModuleMigrationsBlock()
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const duplicates = entries.filter(
      (entry, index) => entries.indexOf(entry) !== index,
    );
    expect(duplicates).toEqual([]);
  });
});
