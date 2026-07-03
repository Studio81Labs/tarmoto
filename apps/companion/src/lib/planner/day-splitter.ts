import { haversineKm } from "@tarmoto/shared";
import { deriveFlaggedSections, surfaceMixToPercents } from "./api";
import type {
  DayPlan,
  PlannerPoi,
  RouteQualitySummary,
  RouteSegment,
  SplitOptions,
} from "./types";

/**
 * Phase-2 day splitting (addendum §4): a pure, deterministic client-side
 * util that slices the live route into DayPlans on an explicit user action
 * — never automatically on route edits. Breaks land at overnight towns
 * when one sits near the target distance; otherwise at the raw distance,
 * flagged `noTownNearby` so the UI can say so.
 *
 * Pinned breaks (manual overrides, §6) are hard boundaries: each region
 * between pins is split independently by the daily-km target, so a pin
 * survives re-splits while the rest of the route rebalances around it.
 */

/** Max snap distance from a raw break target to an overnight town. */
export function snapWindowKm(dailyKmTarget: number): number {
  return Math.min(0.2 * dailyKmTarget, 25);
}

/** A day shorter than this share of the daily target merges into its predecessor. */
const MIN_LAST_DAY_SHARE = 0.4;

/** Towns further off-route than this never become snap candidates. */
const MAX_TOWN_OFF_ROUTE_KM = 10;

interface RoutePoint {
  lng: number;
  lat: number;
  km: number;
}

interface TownOnRoute {
  poi: PlannerPoi;
  alongKm: number;
  offRouteKm: number;
}

/** Flatten segment geometries into one polyline with cumulative km. */
export function routePointsWithKm(segments: RouteSegment[]): RoutePoint[] {
  const points: RoutePoint[] = [];
  let km = 0;
  for (const segment of segments) {
    const coords = segment.geometry.coordinates;
    for (let i = 0; i < coords.length; i += 1) {
      const [lng, lat] = coords[i] ?? [];
      if (typeof lng !== "number" || typeof lat !== "number") continue;
      const previous = points[points.length - 1];
      if (previous) {
        const step = haversineKm(previous.lat, previous.lng, lat, lng);
        // Adjacent segments share their boundary vertex — skip the dup.
        if (step === 0 && i === 0) continue;
        km += step;
      }
      points.push({ lng, lat, km });
    }
  }
  return points;
}

function projectTowns(towns: PlannerPoi[], route: RoutePoint[]): TownOnRoute[] {
  return towns
    .map((poi) => {
      if (poi.kmAlongRoute !== undefined) {
        return {
          poi,
          alongKm: poi.kmAlongRoute,
          offRouteKm: poi.distanceFromRouteKm ?? 0,
        };
      }
      let bestKm = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const point of route) {
        const distance = haversineKm(point.lat, point.lng, poi.lat, poi.lng);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestKm = point.km;
        }
      }
      return { poi, alongKm: bestKm, offRouteKm: bestDistance };
    })
    .filter((town) => town.offRouteKm <= MAX_TOWN_OFF_ROUTE_KM)
    .sort((a, b) => a.alongKm - b.alongKm);
}

interface BreakPoint {
  km: number;
  town: TownOnRoute | null;
  pinned: boolean;
  noTownNearby: boolean;
}

function targetBreaksForRegion(
  startKm: number,
  endKm: number,
  dailyKmTarget: number,
  forcedDays: number | null,
): number[] {
  const regionKm = endKm - startKm;
  if (regionKm <= 0) return [];
  const targets: number[] = [];
  if (forcedDays !== null && forcedDays >= 2) {
    for (let k = 1; k < forcedDays; k += 1) {
      targets.push(startKm + (regionKm * k) / forcedDays);
    }
    return targets;
  }
  for (let k = 1; dailyKmTarget * k < regionKm; k += 1) {
    targets.push(startKm + dailyKmTarget * k);
  }
  return targets;
}

function snapBreak(
  targetKm: number,
  windowKm: number,
  towns: TownOnRoute[],
  totalKm: number,
): BreakPoint {
  let best: TownOnRoute | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const town of towns) {
    // A break at (or past) an end of the route is no break at all.
    if (town.alongKm <= 0 || town.alongKm >= totalKm) continue;
    const delta = Math.abs(town.alongKm - targetKm);
    if (delta <= windowKm && delta < bestDelta) {
      bestDelta = delta;
      best = town;
    }
  }
  if (best) {
    return { km: best.alongKm, town: best, pinned: false, noTownNearby: false };
  }
  return { km: targetKm, town: null, pinned: false, noTownNearby: true };
}

function dayQuality(
  segments: RouteSegment[],
  dayKm: number,
  dayTimeMin: number,
): RouteQualitySummary {
  const metresBySurface: Record<string, number> = {};
  let scoreWeight = 0;
  let scoreSum = 0;
  for (const segment of segments) {
    metresBySurface[segment.surface] =
      (metresBySurface[segment.surface] ?? 0) + segment.lengthKm * 1000;
    if (segment.score !== null) {
      scoreSum += segment.score * segment.lengthKm;
      scoreWeight += segment.lengthKm;
    }
  }
  return {
    distanceKm: Math.round(dayKm * 10) / 10,
    timeMin: Math.round(dayTimeMin),
    score:
      scoreWeight > 0 ? Math.round((scoreSum / scoreWeight) * 10) / 10 : null,
    surfaceMix: surfaceMixToPercents(metresBySurface),
    flagged: deriveFlaggedSections(segments),
  };
}

/** Coordinate at a given along-route km on a raw LineString (break markers). */
export function coordinateAtKm(
  coordinates: ReadonlyArray<ReadonlyArray<number>>,
  targetKm: number,
): { lng: number; lat: number } | null {
  let km = 0;
  let previous: { lng: number; lat: number } | null = null;
  for (const coordinate of coordinates) {
    const [lng, lat] = coordinate;
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (previous) km += haversineKm(previous.lat, previous.lng, lat, lng);
    if (km >= targetKm) return { lng, lat };
    previous = { lng, lat };
  }
  return previous;
}

/**
 * Raw (unsnapped) break targets for a route — used to pre-fetch overnight
 * town candidates near each target before running the split.
 */
export function rawBreakTargetKms(
  totalKm: number,
  dailyKmTarget: number,
  forcedDays: number | null,
): number[] {
  return targetBreaksForRegion(
    0,
    totalKm,
    Math.max(1, dailyKmTarget),
    forcedDays,
  );
}

export function splitIntoDays(
  segments: RouteSegment[],
  opts: SplitOptions,
  overnightTowns: PlannerPoi[] = [],
  pinnedBreakKms: number[] = [],
): DayPlan[] {
  if (segments.length === 0) return [];
  const route = routePointsWithKm(segments);
  const totalKm = route[route.length - 1]?.km ?? 0;
  if (totalKm <= 0) return [];

  const dailyKmTarget = Math.max(1, opts.dailyKmTarget);
  const windowKm = snapWindowKm(dailyKmTarget);
  const towns = projectTowns(overnightTowns, route);

  // Pinned breaks are hard boundaries; each region between them is split
  // independently. Without pins there is a single region [0, totalKm] and
  // forcedDays applies directly; with pins, forcedDays would be ambiguous
  // across regions, so regions fall back to the daily-km target.
  const pins = [...new Set(pinnedBreakKms)]
    .filter((km) => km > 0 && km < totalKm)
    .sort((a, b) => a - b);

  const breaks: BreakPoint[] = pins.map((km) => ({
    km,
    town: towns.find((town) => Math.abs(town.alongKm - km) < 0.05) ?? null,
    pinned: true,
    noTownNearby: false,
  }));

  const regionBounds = [0, ...pins, totalKm];
  for (let r = 0; r < regionBounds.length - 1; r += 1) {
    const regionStart = regionBounds[r]!;
    const regionEnd = regionBounds[r + 1]!;
    const forcedDays = pins.length === 0 ? opts.forcedDays : null;
    for (const target of targetBreaksForRegion(
      regionStart,
      regionEnd,
      dailyKmTarget,
      forcedDays,
    )) {
      const candidate = snapBreak(target, windowKm, towns, totalKm);
      // Snapping can pull two neighbouring targets onto the same town, or
      // onto a pin — drop duplicates instead of emitting a 0 km day.
      const clashes = breaks.some((b) => Math.abs(b.km - candidate.km) < 1);
      if (!clashes && candidate.km > regionStart && candidate.km < regionEnd) {
        breaks.push(candidate);
      }
    }
  }
  breaks.sort((a, b) => a.km - b.km);

  // Rebalance: a runt final day merges into its predecessor by dropping
  // the last (unpinned) break.
  while (breaks.length > 0) {
    const last = breaks[breaks.length - 1]!;
    const lastDayKm = totalKm - last.km;
    if (lastDayKm >= MIN_LAST_DAY_SHARE * dailyKmTarget || last.pinned) break;
    breaks.pop();
  }

  // Slice into DayPlans.
  const boundaries = [
    {
      km: 0,
      town: null as TownOnRoute | null,
      pinned: false,
      noTownNearby: false,
    },
    ...breaks,
    { km: totalKm, town: null, pinned: false, noTownNearby: false },
  ];
  const totalTimeMin = opts.totalTimeMin ?? 0;

  // Segment midpoints along the route, in order.
  const segmentMidKms: number[] = [];
  let cursorKm = 0;
  for (const segment of segments) {
    segmentMidKms.push(cursorKm + segment.lengthKm / 2);
    cursorKm += segment.lengthKm;
  }

  const plans: DayPlan[] = [];
  for (let d = 0; d < boundaries.length - 1; d += 1) {
    const from = boundaries[d]!;
    const to = boundaries[d + 1]!;
    const dayKm = to.km - from.km;
    const daySegments = segments.filter((segment, index) => {
      const mid = segmentMidKms[index]!;
      const isLastDay = d === boundaries.length - 2;
      return mid >= from.km && (isLastDay ? mid <= to.km : mid < to.km);
    });
    const stays = towns
      .filter(
        (town) =>
          Math.abs(town.alongKm - to.km) <= windowKm &&
          town.alongKm > 0 &&
          town.alongKm < totalKm,
      )
      .sort((a, b) => Math.abs(a.alongKm - to.km) - Math.abs(b.alongKm - to.km))
      .map((town) => town.poi);

    const plan: DayPlan = {
      dayNumber: d + 1,
      segmentIds: daySegments.map((segment) => segment.id),
      distanceKm: Math.round(dayKm * 10) / 10,
      timeMin:
        totalTimeMin > 0 ? Math.round((totalTimeMin * dayKm) / totalKm) : 0,
      quality: dayQuality(daySegments, dayKm, (totalTimeMin * dayKm) / totalKm),
      startTown: d === 0 ? "Start" : boundaryLabel(boundaries[d]!),
      endTown: d === boundaries.length - 2 ? "Finish" : boundaryLabel(to),
      suggestedStays: to.town
        ? [to.town.poi, ...stays.filter((poi) => poi.id !== to.town!.poi.id)]
        : stays,
      endKm: Math.round(to.km * 10) / 10,
    };
    if (to.noTownNearby && d < boundaries.length - 2) plan.noTownNearby = true;
    if (to.pinned) plan.breakPinned = true;
    plans.push(plan);
  }
  return plans;
}

function boundaryLabel(boundary: {
  km: number;
  town: TownOnRoute | null;
}): string {
  if (boundary.town) return boundary.town.poi.name;
  return `km ${Math.round(boundary.km)}`;
}
