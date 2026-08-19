import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  createPoiDataSource,
  PoiDatabaseModule,
} from './poi-database.module.js';

const BASE_OPTIONS = {
  type: 'postgres' as const,
  host: '127.0.0.1',
  port: 1, // nothing listening
  database: 'nope',
  username: 'x',
  password: 'x',
  entities: [],
  migrations: [],
  connectTimeoutMS: 200,
  retryAttempts: 0,
};

describe('createPoiDataSource', () => {
  it('returns an uninitialized DataSource without throwing when the DB is unreachable', async () => {
    const ds = await createPoiDataSource(BASE_OPTIONS);
    expect(ds).toBeInstanceOf(DataSource);
    expect(ds.isInitialized).toBe(false);
  });
});

describe('createPoiDataSource — non-connection vs. connection error classification (Codex fix)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('REJECTS at boot when initialize() fails with a NON-connection error (e.g. a real schema/migration bug)', async () => {
    // A pg SQLSTATE 42704 ("undefined_object", e.g. `type "geometry" does
    // not exist") is a genuine schema/migration DDL failure, not a dropped
    // connection. `migrationsRun: true` means initialize() is what runs the
    // POI migrations, so this simulates a broken migration surfacing there.
    const schemaErr = Object.assign(
      new Error('type "geometry" does not exist'),
      { code: '42704' },
    );
    jest.spyOn(DataSource.prototype, 'initialize').mockRejectedValue(schemaErr);

    await expect(createPoiDataSource(BASE_OPTIONS)).rejects.toThrow(
      'type "geometry" does not exist',
    );
  });

  it('still resolves an uninitialized DataSource (no throw) when initialize() fails with a connection error', async () => {
    // Proves the classification actually branches: same mocked-initialize
    // shape as above, but a connection-coded error keeps the current
    // tolerate-down behavior instead of rejecting.
    const connectionErr = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    jest
      .spyOn(DataSource.prototype, 'initialize')
      .mockRejectedValue(connectionErr);

    const ds = await createPoiDataSource(BASE_OPTIONS);
    expect(ds).toBeInstanceOf(DataSource);
    expect(ds.isInitialized).toBe(false);
  });
});

describe('PoiDatabaseModule wiring (regression)', () => {
  // MODULE-WIRING level regression test for the crash the unit test above
  // can't see: `createPoiDataSource` swallows its own initialize() failure
  // and returns fine on its own, but `@nestjs/typeorm`'s
  // `TypeOrmCoreModule.createDataSourceFactory` then re-runs
  // `dataSource.initialize()` on whatever `dataSourceFactory` returned,
  // UNLESS the module's options carry `manualInitialization: true`:
  //   `!dataSource.isInitialized && !options.manualInitialization
  //     ? dataSource.initialize() : dataSource`
  // That second initialize() rejects (retryAttempts: 0 makes handleRetry
  // re-throw immediately instead of retrying), which is what crashed
  // `NestFactory.create(AppModule)` at boot. Assembling the real
  // `PoiDatabaseModule` (not just calling `createPoiDataSource` directly,
  // like the suite above) is the only way to see that failure.
  const ENV_KEYS = [
    'TARMOTO_POI_DATABASE_HOST',
    'TARMOTO_POI_DATABASE_PORT',
  ] as const;
  const savedEnv: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // Nothing listens on 127.0.0.1:1 (same dead-port shape as the suite
    // above), but this time reached through the real ConfigService ->
    // useFactory -> dataSourceFactory wiring instead of a hand-built
    // options object.
    process.env.TARMOTO_POI_DATABASE_HOST = '127.0.0.1';
    process.env.TARMOTO_POI_DATABASE_PORT = '1';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('compiling the module does not throw, and leaves the "poi" DataSource uninitialized', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PoiDatabaseModule],
    }).compile();

    try {
      const dataSource = moduleRef.get<DataSource>(getDataSourceToken('poi'));
      expect(dataSource).toBeInstanceOf(DataSource);
      expect(dataSource.isInitialized).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });
});
