import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const DATA_SOURCE = join(ROOT, 'data-source.ts');
const DATABASE_MODULE = join(ROOT, 'modules', 'database', 'database.module.ts');
const MIGRATION_IMPORT =
  'AddTripShareTripLink1715250000000 } from ' +
  "'./migrations/1715250000000-AddTripShareTripLink.js'";
const MODULE_MIGRATION_IMPORT =
  'AddTripShareTripLink1715250000000 } from ' +
  "'../../migrations/1715250000000-AddTripShareTripLink.js'";

describe('trip-share migration registration', () => {
  it('registers the trip-share trip-link migration for CLI and runtime migration execution', () => {
    const dataSource = readFileSync(DATA_SOURCE, 'utf8');
    const databaseModule = readFileSync(DATABASE_MODULE, 'utf8');

    expect(dataSource).toContain(MIGRATION_IMPORT);
    expect(dataSource).toContain('AddTripShareTripLink1715250000000,');
    expect(databaseModule).toContain(MODULE_MIGRATION_IMPORT);
    expect(databaseModule).toContain('AddTripShareTripLink1715250000000,');
  });
});
