/**
 * Downsampling for route polylines shipped to the backend's proximity
 * checks (closures/passes check-route, POIs along-route). A live-routed
 * day can carry thousands of vertices — ~186 KB of JSON — which blows the
 * backend's deliberate 100 KB body limit (see backend main.ts). The
 * checks buffer the route by hundreds of metres to kilometres, so a
 * stride-sampled line loses nothing they can detect.
 */

/**
 * ~0.2–1 km vertex spacing for typical day routes, ≈25 KB of JSON —
 * comfortably inside the backend's default body limit with headroom for
 * the surrounding payload fields.
 */
export const MAX_CHECK_ROUTE_POINTS = 500;

/**
 * Evenly stride-samples `points` down to at most `maxPoints`, always
 * keeping the first and last vertex. Returns the input array unchanged
 * (same reference) when it's already within the cap.
 */
export function sampleRoutePoints<T>(
  points: readonly T[],
  maxPoints: number = MAX_CHECK_ROUTE_POINTS,
): readonly T[] {
  if (maxPoints < 2 || points.length <= maxPoints) return points;

  const sampled: T[] = [];
  const lastIndex = points.length - 1;
  const stride = lastIndex / (maxPoints - 1);
  let previousIndex = -1;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.min(lastIndex, Math.round(i * stride));
    if (index === previousIndex) continue;
    previousIndex = index;
    const point = points[index];
    if (point !== undefined) sampled.push(point);
  }
  return sampled;
}
