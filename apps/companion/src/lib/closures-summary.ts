import { haversineKm, type Formatters } from "@tarmoto/shared";
import type { RoadClosure } from "./api";
import { sampleRoutePoints } from "./route-sampling";
import type { Trip } from "./types";

export type PlannerClosure = RoadClosure;

export interface ClosureSeverityCounts {
  full: number;
  partial: number;
  advisory: number;
  total: number;
}

export interface PlannerClosureRoute {
  id: string;
  label: string;
  points: Array<{ lat: number; lng: number }>;
}

const SEVERITY_ORDER: Record<PlannerClosure["severity"], number> = {
  full: 0,
  partial: 1,
  advisory: 2,
};

export function previewDateForMonth(month: number, now: Date = new Date()) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("month must be an integer between 1 and 12");
  }

  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const year = month < currentMonth ? currentYear + 1 : currentYear;

  return new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
}

export function countClosuresBySeverity(
  closures: readonly PlannerClosure[],
): ClosureSeverityCounts {
  const counts: ClosureSeverityCounts = {
    full: 0,
    partial: 0,
    advisory: 0,
    total: 0,
  };

  for (const closure of closures) {
    counts[closure.severity] += 1;
    counts.total += 1;
  }

  return counts;
}

export function sortClosures(
  closures: readonly PlannerClosure[],
): PlannerClosure[] {
  return [...closures].sort((a, b) => {
    const severityDelta =
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return (
      new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime() ||
      a.title.localeCompare(b.title)
    );
  });
}

export function dedupeClosures(
  closures: readonly PlannerClosure[],
): PlannerClosure[] {
  const unique = new Map<string, PlannerClosure>();

  for (const closure of closures) {
    if (!unique.has(closure.id)) unique.set(closure.id, closure);
  }

  return [...unique.values()];
}

export function detourLengthKm(closure: PlannerClosure): number | null {
  const detour = closure.detour;
  if (!detour || detour.length < 2) return null;

  let totalKm = 0;
  for (let i = 1; i < detour.length; i += 1) {
    const prev = detour[i - 1]!;
    const next = detour[i]!;
    totalKm += haversineKm(prev.lat, prev.lng, next.lat, next.lng);
  }

  return totalKm;
}

export function buildTripClosureRoutes(
  trip: Trip | null,
): PlannerClosureRoute[] {
  if (!trip) return [];

  return trip.days.flatMap((day) => {
    const coords = day.routeGeometry?.coordinates;
    if (!coords || coords.length < 2) return [];

    return [
      {
        id: `day-${day.dayNumber}`,
        label: day.title
          ? `Day ${day.dayNumber} · ${day.title}`
          : `Day ${day.dayNumber}`,
        // Downsampled: the closures/passes checks buffer the route by
        // hundreds of metres+, and the full live-routed polyline can
        // exceed the backend's JSON body limit.
        points: sampleRoutePoints(coords).flatMap(([lng, lat]) =>
          lng !== undefined && lat !== undefined ? [{ lng, lat }] : [],
        ),
      },
    ];
  });
}

/**
 * Closure window copy for cards/popovers. Both branches render through the
 * UTC-pinned `calendarDate*` formatters (not `date()`/`dateRange()`) so the
 * displayed day is the closure's calendar day, never shifted by the
 * viewer's timezone — a closure starting at 22:30Z must still read as
 * starting on that same UTC calendar day everywhere.
 */
export function formatClosureWindow(
  closure: PlannerClosure,
  format: Formatters,
): string {
  if (!closure.ends_at) {
    return `${format.calendarDate(closure.starts_at)} onward`;
  }
  return format.calendarDateRange(closure.starts_at, closure.ends_at);
}
