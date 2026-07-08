import { deriveDayQualitySegments } from "@/lib/trip-planner-map";
import type { TripDay } from "@/lib/types";

/**
 * Collapse a multi-day trip into one synthetic `TripDay` for the INSPECT
 * tab's whole-route view (shown when no day is selected). Metrics sum across
 * days, quality is distance-weighted, and the per-segment quality + surface
 * inputs are concatenated so the quality strip, surface mix, and flagged
 * sections span the entire route.
 *
 * Quality segments are the *derived* per-day segments, so each keeps its real
 * `d{dayNumber}-s{n}` id (never a synthetic `d0-*`). That's what lets a
 * strip/flagged click resolve back through `findPlannerQualitySegment`, which
 * scans the real trip days — a run coalesced across a day boundary still
 * resolves against the day its id starts on.
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
  // Weight the quality mean only over days that carry a real measurement
  // (avgQuality > 0). A no-data / unhydrated day (avgQuality === 0) would
  // otherwise drag the aggregate toward "rough" — e.g. a measured 4.0 day plus
  // an unmeasured one would read 2.0 instead of the true 4.0. Falls to 0 when
  // nothing is measured, which INSPECT renders as "—".
  const scoredDistance = days.reduce(
    (sum, day) => (day.avgQuality > 0 ? sum + day.distanceKm : sum),
    0,
  );
  const weightedQuality = days.reduce(
    (sum, day) =>
      day.avgQuality > 0 ? sum + day.avgQuality * day.distanceKm : sum,
    0,
  );
  const avgQuality = scoredDistance > 0 ? weightedQuality / scoredDistance : 0;

  const surfaceMix: Record<string, number> = {};
  for (const day of days) {
    if (!day.surfaceMix) continue;
    for (const [surface, metres] of Object.entries(day.surfaceMix)) {
      surfaceMix[surface] = (surfaceMix[surface] ?? 0) + metres;
    }
  }

  // Derived (not raw) so geometry-only days still emit real day-scoped ids.
  const qualitySegments = days.flatMap((day) => deriveDayQualitySegments(day));
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
