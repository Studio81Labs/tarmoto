import { poiDatabaseConfig } from './poi-database.config.js';

describe('poiDatabaseConfig', () => {
  const OLD = process.env;
  afterEach(() => {
    process.env = OLD;
  });

  it('defaults to the local poi-db (localhost:5434, tarmoto_poi)', () => {
    process.env = { ...OLD };
    delete process.env.TARMOTO_POI_DATABASE_HOST;
    delete process.env.TARMOTO_POI_DATABASE_PORT;
    delete process.env.TARMOTO_POI_DATABASE_NAME;
    expect(poiDatabaseConfig()).toEqual({
      host: 'localhost',
      port: 5434,
      database: 'tarmoto_poi',
      username: 'tarmoto',
      password: 'tarmoto',
    });
  });

  it('reads TARMOTO_POI_DATABASE_* overrides', () => {
    process.env = {
      ...OLD,
      TARMOTO_POI_DATABASE_HOST: 'poi.internal',
      TARMOTO_POI_DATABASE_PORT: '6000',
      TARMOTO_POI_DATABASE_NAME: 'pois_prod',
      TARMOTO_POI_DATABASE_USER: 'poi',
      TARMOTO_POI_DATABASE_PASSWORD: 'secret',
    };
    expect(poiDatabaseConfig()).toEqual({
      host: 'poi.internal',
      port: 6000,
      database: 'pois_prod',
      username: 'poi',
      password: 'secret',
    });
  });
});
