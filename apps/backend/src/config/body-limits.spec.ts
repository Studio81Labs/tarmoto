import {
  IMPORT_TRIP_BODY_LIMIT_PATHS,
  ROUTE_GEOMETRY_BODY_LIMIT_PATHS,
} from './body-limits.js';

describe('body limit route config', () => {
  it('applies the widened GPX/KML import limit to create and replacement import endpoints only', () => {
    expect(IMPORT_TRIP_BODY_LIMIT_PATHS).toEqual([
      '/api/v1/trips/import',
      '/api/v1/trips/:tripId/import',
    ]);
  });

  it('applies the bounded route-geometry limit to every planner corridor endpoint', () => {
    expect(ROUTE_GEOMETRY_BODY_LIMIT_PATHS).toEqual([
      '/api/v1/poi/in-corridor',
      '/api/v1/passes/check-route',
      '/api/v1/closures/check-route',
      '/api/v1/roads/fun-zones/in-corridor',
    ]);
  });
});
