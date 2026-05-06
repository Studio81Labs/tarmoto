import { IMPORT_TRIP_BODY_LIMIT_PATHS } from './body-limits.js';

describe('body limit route config', () => {
  it('applies the widened GPX/KML import limit to create and replacement import endpoints only', () => {
    expect(IMPORT_TRIP_BODY_LIMIT_PATHS).toEqual([
      '/api/v1/trips/import',
      '/api/v1/trips/:tripId/import',
    ]);
  });
});
