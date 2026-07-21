export const IMPORT_TRIP_BODY_LIMIT_PATHS = [
  '/api/v1/trips/import',
  '/api/v1/trips/:tripId/import',
] as const;

/** Planner endpoints that accept a full routed polyline in their JSON body. */
export const ROUTE_GEOMETRY_BODY_LIMIT_PATHS = [
  '/api/v1/poi/in-corridor',
  '/api/v1/passes/check-route',
  '/api/v1/closures/check-route',
  '/api/v1/roads/fun-zones/in-corridor',
] as const;
