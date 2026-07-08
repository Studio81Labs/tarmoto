import type { TripDay } from "@/lib/types";

/**
 * Collapse a multi-day trip into one synthetic `TripDay` for the INSPECT
 * tab's whole-route view (shown when no day is selected). Metrics sum across
 * days, quality is distance-weighted, and the per-segment quality + surface
 * inputs are concatenated so the quality strip, surface mix, and flagged
 * sections span the entire route.
 *
 * A single-day (or one-element) trip is returned as-is — there's nothing to
 * aggregate. Returns null for an empty trip.
 */
export function aggregateInspectDay(days: TripDay[]): TripDay | null {
  if (days.length === 0) return null;
  if (days.length === 1) return days[0] ?? null;

  const distanceKm = days.reduce((sum, day) => sum + day.distanceKm, 0);
  const durationMinutes = days.reduce(
    (sum, day) => sum + day.durationMinutes,
    0,
  );
  const elevationGain = days.reduce((sum, day) => sum + day.elevationGain, 0);
  const weightedQuality = days.reduce(
    (sum, day) => sum + day.avgQuality * day.distanceKm,
    0,
  );
  const avgQuality = distanceKm > 0 ? weightedQuality / distanceKm : 0;

  const surfaceMix: Record<string, number> = {};
  for (const day of days) {
    if (!day.surfaceMix) continue;
    for (const [surface, metres] of Object.entries(day.surfaceMix)) {
      surfaceMix[surface] = (surfaceMix[surface] ?? 0) + metres;
    }
  }

  const qualitySegments = days.flatMap((day) => day.qualitySegments ?? []);
  const coordinates = days.flatMap(
    (day) => day.routeGeometry?.coordinates ?? [],
  );

  return {
    dayNumber: 0,
    waypoints: days.flatMap((day) => day.waypoints),
    distanceKm,
    durationMinutes,
    elevationGain,
    avgQuality,
    ...(Object.keys(surfaceMix).length > 0 ? { surfaceMix } : {}),
    ...(qualitySegments.length > 0 ? { qualitySegments } : {}),
    ...(coordinates.length > 1
      ? { routeGeometry: { type: "LineString", coordinates } }
      : {}),
  };
}
