import { DataSource } from 'typeorm';
import { createPoiDataSource } from './poi-database.module.js';

describe('createPoiDataSource', () => {
  it('returns an uninitialized DataSource without throwing when the DB is unreachable', async () => {
    const options = {
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
    const ds = await createPoiDataSource(options);
    expect(ds).toBeInstanceOf(DataSource);
    expect(ds.isInitialized).toBe(false);
  });
});
