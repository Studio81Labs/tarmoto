/**
 * Argument parser for `seed-demo-data`. Lives in its own module so unit
 * tests can exercise it without booting the Nest app (mirrors
 * `cluster-fun-zones-args.ts`).
 */

export interface SeedDemoDataOptions {
  /**
   * When set, only this persona (matched by email) is (re)seeded. `null`
   * seeds the whole demo catalog. Lower-cased + trimmed so it matches the
   * canonical persona emails regardless of how the operator typed it.
   */
  only: string | null;
  /** Delete all demo data and exit without re-seeding. */
  clean: boolean;
  /** Allow running when `NODE_ENV=production` (otherwise refused). */
  force: boolean;
  /** Print usage and exit. */
  help: boolean;
}

export interface ParsedArgs {
  options: SeedDemoDataOptions;
}

// Boolean flags that must not be given a value. Listed explicitly so an
// unknown valueless flag still errors out instead of silently passing.
const VALUELESS_FLAGS = new Set(['clean', 'force', 'help']);

export function parseArgs(argv: string[]): ParsedArgs {
  const options: SeedDemoDataOptions = {
    only: null,
    clean: false,
    force: false,
    help: false,
  };

  for (const raw of argv) {
    if (raw.length === 0) continue;
    // Reject any non-empty token that isn't an explicit `--flag`, so a
    // single-dash typo (`-force`) fails fast rather than running with
    // defaults — important because seeding deletes demo data first.
    if (!raw.startsWith('--')) {
      throw new Error(
        `Unknown argument: "${raw}". Flags must start with "--".`,
      );
    }

    // Split on the FIRST `=` only so values containing `=` survive intact.
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
      if (key === 'clean') options.clean = true;
      else if (key === 'force') options.force = true;
      else options.help = true;
      continue;
    }

    if (key !== 'only') {
      throw new Error(`Unknown argument: --${key}`);
    }
    if (valueRaw === undefined) {
      throw new Error(`Argument ${raw} requires a value (use --key=value).`);
    }
    const email = valueRaw.trim().toLowerCase();
    if (email.length === 0) {
      throw new Error(`Invalid --only: value is empty.`);
    }
    options.only = email;
  }

  return { options };
}

export function usage(): string {
  return [
    'Usage: node dist/scripts/seed-demo-data.js [options]',
    '',
    'Populates the configured Tarmoto database with demo accounts and',
    'activity (rides, roads, trips, hazards, reviews, badges) so every',
    'app state can be exercised locally. Re-runnable: existing demo data',
    'is deleted before each run.',
    '',
    'Options:',
    '  --only=<email>  (Re)seed only the persona with this email.',
    '  --clean         Delete all demo data and exit (no re-seed).',
    '  --force         Allow running when NODE_ENV=production.',
    '  --help          Show this help.',
  ].join('\n');
}
