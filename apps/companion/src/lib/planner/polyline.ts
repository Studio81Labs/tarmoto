import { haversineKm } from "@tarmoto/shared";

/**
 * Distance-based polyline helpers shared by the segment-highlight layer and
 * the route-quality span mapper. Coordinates are GeoJSON `[lng, lat]` order;
 * distances are cumulative kilometres from the start vertex.
 *
 * Segments never carry their own line geometry — they're positioned along a
 * day's routed polyline by distance — so both consumers slice the same way:
 * interpolate the boundary points, keep the interior vertices, and dedupe.
 */

export type LngLat = [number, number];

/** Cumulative km at each vertex (index 0 = 0), by haversine along the line. */
export function cumulativeKm(coordinates: readonly LngLat[]): number[] {
  const cum: number[] = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const step =
      previous && current
        ? haversineKm(previous[1], previous[0], current[1], current[0])
        : 0;
    cum.push((cum[index - 1] ?? 0) + step);
  }
  return cum;
}

/** Point at `targetKm` along the line, linearly interpolated within the edge. */
export function pointAtDistanceKm(
  coordinates: readonly LngLat[],
  cumLengthsKm: readonly number[],
  targetKm: number,
): LngLat {
  const lastIndex = coordinates.length - 1;
  if (targetKm <= 0) return coordinates[0]!;
  if (targetKm >= (cumLengthsKm[lastIndex] ?? 0))
    return coordinates[lastIndex]!;

  for (let index = 1; index < cumLengthsKm.length; index += 1) {
    if (cumLengthsKm[index]! < targetKm) continue;
    const edgeKm = cumLengthsKm[index]! - cumLengthsKm[index - 1]!;
    const t = edgeKm > 0 ? (targetKm - cumLengthsKm[index - 1]!) / edgeKm : 0;
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    return [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ];
  }
  return coordinates[lastIndex]!;
}

/**
 * Coordinates of the sub-line between `startKm` and `endKm` — the two
 * boundary points (interpolated) plus every interior vertex, deduped.
 * Empty when the range is degenerate or off the line.
 */
export function slicePolylineByDistanceKm(
  coordinates: readonly LngLat[],
  cumLengthsKm: readonly number[],
  startKm: number,
  endKm: number,
): LngLat[] {
  const totalKm = cumLengthsKm[cumLengthsKm.length - 1] ?? 0;
  if (totalKm <= 0) return [];
  const clampedStart = Math.max(0, startKm);
  const clampedEnd = Math.min(totalKm, endKm);
  if (clampedEnd <= clampedStart) return [];

  const result: LngLat[] = [];
  result.push(pointAtDistanceKm(coordinates, cumLengthsKm, clampedStart));
  for (let index = 0; index < cumLengthsKm.length; index += 1) {
    const km = cumLengthsKm[index]!;
    if (km > clampedStart && km < clampedEnd) result.push(coordinates[index]!);
  }
  result.push(pointAtDistanceKm(coordinates, cumLengthsKm, clampedEnd));

  return dedupeAdjacentPoints(result);
}

/** Drop consecutive points that coincide (within float tolerance). */
export function dedupeAdjacentPoints(points: readonly LngLat[]): LngLat[] {
  const result: LngLat[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (
      !previous ||
      Math.abs(previous[0] - point[0]) > 1e-9 ||
      Math.abs(previous[1] - point[1]) > 1e-9
    ) {
      result.push(point);
    }
  }
  return result;
}

/** Clamp to the unit interval; non-finite input collapses to 0. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
