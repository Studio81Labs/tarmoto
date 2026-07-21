export interface SpatialRoutePoint {
  lat: number;
  lng: number;
}

export interface RouteSpatialSql {
  geometrySql: string;
  prefilterSql: string;
  params: Record<string, number>;
}

export interface RouteEnvelopeDegrees {
  bufferLngDeg: number;
  bufferLatDeg: number;
}

const CONSERVATIVE_METERS_PER_DEGREE = 110_000;

export function routeEnvelopeDegrees(
  routes: ReadonlyArray<ReadonlyArray<SpatialRoutePoint>>,
  bufferM: number,
): RouteEnvelopeDegrees {
  let maxAbsLat = 0;
  for (const route of routes) {
    for (const point of route) {
      maxAbsLat = Math.max(maxAbsLat, Math.abs(point.lat));
    }
  }

  const bufferLatDeg = bufferM / CONSERVATIVE_METERS_PER_DEGREE;
  const expandedAbsLat = Math.min(90, maxAbsLat + bufferLatDeg);
  const bufferLngDeg =
    expandedAbsLat >= 90
      ? 180
      : Math.min(
          180,
          bufferM /
            (CONSERVATIVE_METERS_PER_DEGREE *
              Math.cos((expandedAbsLat * Math.PI) / 180)),
        );

  return { bufferLngDeg, bufferLatDeg };
}

/**
 * Builds a parameterized LineString/MultiLineString and an index-friendly
 * bounding-box prefilter for an exact geography distance check.
 *
 * Longitude degrees get narrower toward the poles, so a fixed
 * metres-to-degrees radius is not conservative outside mid-latitudes. The
 * expanded box uses the route's highest absolute latitude and falls back to
 * the full longitude range when the buffer reaches a pole.
 */
export function buildRouteSpatialSql(
  routes: ReadonlyArray<ReadonlyArray<SpatialRoutePoint>>,
  bufferM: number,
  geometryColumn: string,
): RouteSpatialSql {
  const params: Record<string, number> = {};
  const lines = routes.map((route, routeIndex) => {
    const points = route
      .map((point, pointIndex) => {
        const suffix = `${routeIndex}_${pointIndex}`;
        params[`routeLng${suffix}`] = point.lng;
        params[`routeLat${suffix}`] = point.lat;
        return `ST_MakePoint(:routeLng${suffix}, :routeLat${suffix})`;
      })
      .join(',');
    return `ST_MakeLine(ARRAY[${points}])`;
  });

  const collected =
    lines.length === 1 ? lines[0] : `ST_Collect(ARRAY[${lines.join(',')}])`;
  const geometrySql = `ST_SetSRID(${collected}, 4326)`;

  const { bufferLngDeg, bufferLatDeg } = routeEnvelopeDegrees(routes, bufferM);

  params.bufferLatDeg = bufferLatDeg;
  params.bufferLngDeg = bufferLngDeg;

  return {
    geometrySql,
    prefilterSql: `${geometryColumn} && ST_Expand((${geometrySql})::box2d, :bufferLngDeg, :bufferLatDeg)`,
    params,
  };
}
