/**
 * Pure formatting + shaping helpers for the Trip screens.
 *
 * Kept out of the screen modules so unit tests can exercise them without
 * pulling React Native or navigation into the module graph.
 */

import {
  haversineKm as sharedHaversineKm,
  type TripGpxInput,
} from "@tarmoto/shared";
import type { IconName } from "@/components/Icon";
import { translate, type EnglishMessageKey, type Translate } from "@/i18n";
import { getFormatters } from "@/format";
import type {
  Accommodation,
  AccommodationKind,
  CheckRouteForPassesResponse,
  LatLng,
  MountainPass,
  Trip,
  TripDay,
  TripStatus,
  Waypoint,
  WaypointType,
} from "@/types";

export const DAILY_KM_PRESETS = [
  { label: "Relaxed", min: 100, max: 200 },
  { label: "Standard", min: 150, max: 300 },
  { label: "Long", min: 200, max: 400 },
  { label: "Epic", min: 300, max: 500 },
] as const;

export type DailyKmPreset = (typeof DAILY_KM_PRESETS)[number];

export const ROAD_PREFERENCES = [
  { value: "curvy", label: "Curvy" },
  { value: "scenic", label: "Scenic" },
  { value: "mixed", label: "Mixed" },
  { value: "fast", label: "Fast" },
] as const;

export type RoadPreferenceValue = (typeof ROAD_PREFERENCES)[number]["value"];

export const DAY_OPTIONS = [2, 3, 4, 5, 7, 10, 14] as const;
const SUGGESTED_OVERNIGHT_PREFIX = "suggested-overnight:";
const ACCOMMODATION_KIND_PRIORITY: Record<AccommodationKind, number> = {
  hotel: 3,
  apartment: 2.5,
  guest_house: 2.5,
  chalet: 2,
  motel: 1.5,
  hostel: 1,
  camp_site: 0.5,
};

export function formatKm(km: number): string {
  const format = getFormatters();
  const finiteKm = Number.isFinite(km) ? km : 0;
  return format.distanceKm(
    format.units === "metric" ? Math.round(finiteKm) : finiteKm,
  );
}

/** Complete catalog message for stay/POI metadata; no UI-side joining. */
export function formatNearbyPlaceMeta(
  kind: string,
  distanceKm: number,
  detail?: string,
  t: Translate = translate,
): string {
  const values = {
    kind,
    distance: getFormatters().distanceKm(distanceKm),
    ...(detail ? { detail } : {}),
  };
  return detail
    ? t("{kind} · {distance} · {detail}", values)
    : t("{kind} · {distance}", values);
}

/** Unit-aware accessible name shared by accommodation and POI rows. */
export function formatNearbyPlaceAccessibilityLabel(
  label: string,
  distanceKm: number,
  t: Translate = translate,
): string {
  return t("{label}, {distance} away", {
    label,
    distance: getFormatters().distanceKm(distanceKm),
  });
}

/** Unit-aware radius summary shared by the nearby stay and POI sections. */
export function formatNearbyRadius(
  radiusKm: number,
  t: Translate = translate,
): string {
  return t("within {distance}", {
    distance: getFormatters().distanceKm(radiusKm),
  });
}

/** "2h 30m" / "45m" — keep short for metric rows. */
export function formatDurationMin(minutes: number): string {
  return getFormatters().durationCompact(
    !Number.isFinite(minutes) || minutes <= 0 ? 0 : minutes,
  );
}

export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatStatus(status: TripStatus): string {
  const labels: Record<TripStatus, EnglishMessageKey> = {
    draft: "Draft",
    planned: "Planned",
    active: "Active",
    completed: "Completed",
  };
  return translate(labels[status]);
}

type DisplayWaypointType = WaypointType | "rest";

export function formatWaypointType(t: DisplayWaypointType): string {
  const labels: Record<DisplayWaypointType, EnglishMessageKey> = {
    start: "Start",
    via: "Waypoint",
    fuel: "Fuel",
    food: "Food",
    coffee: "Coffee",
    hotel: "Hotel",
    rest: "Rest",
    photo: "Photo",
    end: "End",
  };
  return translate(labels[t]);
}

export const WAYPOINT_ICONS: Record<WaypointType, IconName> = {
  start: "flag-outline",
  via: "map-marker",
  fuel: "gas-station",
  food: "silverware-fork-knife",
  coffee: "coffee",
  hotel: "bed",
  photo: "camera-outline",
  end: "flag-checkered",
};

/**
 * Group waypoints by "logistics" buckets for the day breakdown. Everything
 * that isn't start/end/fuel/hotel collapses into "stops" since riders care
 * most about fuel range and where they're sleeping — the rest is just
 * turn-by-turn detail the map covers.
 */
export function summarizeWaypoints(
  waypoints: Waypoint[],
  // Pass the final-day flag so a NON-final day with no `hotel` infers its
  // overnight from the `end`. After a manual save normalizes a generated leg's
  // terminal stay to a routed `end`, no `hotel` remains; on a multi-day trip
  // that endpoint IS the overnight boundary. Defaults to `true` (no inference)
  // for callers without day context. The final day's `end` is the trip finish.
  isFinalDay = true,
): {
  fuelStops: Waypoint[];
  overnightStops: Waypoint[];
  otherStops: Waypoint[];
  start: Waypoint | null;
  end: Waypoint | null;
} {
  const sorted = [...waypoints].sort((a, b) => a.sequence - b.sequence);
  const fuelStops = sorted.filter((w) => w.waypoint_type === "fuel");
  const hotels = sorted.filter((w) => w.waypoint_type === "hotel");
  const otherStops = sorted.filter(
    (w) =>
      w.waypoint_type !== "fuel" &&
      w.waypoint_type !== "hotel" &&
      w.waypoint_type !== "start" &&
      w.waypoint_type !== "end",
  );
  const start = sorted.find((w) => w.waypoint_type === "start") ?? null;
  const end = sorted.find((w) => w.waypoint_type === "end") ?? null;
  const overnightStops =
    hotels.length > 0 ? hotels : !isFinalDay && end ? [end] : [];
  return { fuelStops, overnightStops, otherStops, start, end };
}

/**
 * Pick the overnight stay that best fits the existing day end. Because the
 * generator has already chosen a day-end area, proximity dominates: we avoid
 * a second reroute pass by preferring stays that are close to the current end
 * point, then using stars / kind / naming quality as tie-breakers.
 */
export function pickSuggestedAccommodation(
  accommodations: Accommodation[],
): Accommodation | null {
  if (accommodations.length === 0) return null;
  const sorted = [...accommodations].sort((a, b) => {
    const scoreDelta = overnightFitScore(b) - overnightFitScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    const distanceDelta = a.distance_km - b.distance_km;
    if (distanceDelta !== 0) return distanceDelta;
    return a.external_id.localeCompare(b.external_id);
  });
  return sorted[0] ?? null;
}

export function isSuggestedOvernightWaypoint(
  waypoint: Pick<Waypoint, "id" | "waypoint_type">,
): boolean {
  return (
    waypoint.waypoint_type === "hotel" &&
    waypoint.id.startsWith(SUGGESTED_OVERNIGHT_PREFIX)
  );
}

export function navigationWaypointsForRoadNames(
  waypoints: Waypoint[],
): Waypoint[] {
  return waypoints.filter(
    (waypoint) => !isSuggestedOvernightWaypoint(waypoint),
  );
}

/**
 * Materialize a UI-level overnight-stop selection into the trip itinerary.
 *
 * We keep the change local to the client-side trip snapshot: the selected stay
 * appears in the day timeline and highlights, but we do not attempt a second
 * route solve. Existing explicit hotel waypoints from the backend are left
 * untouched.
 */
export function withSuggestedOvernightStop(
  trip: Trip,
  dayNumber: number,
  accommodations: Accommodation[],
): Trip {
  const dayIndex = trip.days.findIndex((day) => day.day_number === dayNumber);
  if (dayIndex < 0) return trip;

  const day = trip.days[dayIndex];
  if (!day) return trip;
  if (isLastDay(trip.days, day.day_number)) return trip;

  const explicitHotel = day.waypoints.some(
    (waypoint) =>
      waypoint.waypoint_type === "hotel" &&
      !isSuggestedOvernightWaypoint(waypoint),
  );
  if (explicitHotel) return trip;

  const choice = pickSuggestedAccommodation(accommodations);
  if (!choice) return trip;

  const suggestedId = `${SUGGESTED_OVERNIGHT_PREFIX}${day.id}:${choice.external_id}`;
  const hotelWaypoint: Waypoint = {
    id: suggestedId,
    sequence: 0,
    name: choice.name?.trim() || fallbackAccommodationName(choice.kind),
    lat: choice.lat,
    lng: choice.lng,
    waypoint_type: "hotel",
    road_segment_id: null,
    notes: null,
    duration_min: null,
  };

  const sorted = [...day.waypoints].sort((a, b) => a.sequence - b.sequence);
  const existingSuggested = sorted.find(isSuggestedOvernightWaypoint);
  if (
    existingSuggested &&
    existingSuggested.id === hotelWaypoint.id &&
    existingSuggested.name === hotelWaypoint.name &&
    existingSuggested.lat === hotelWaypoint.lat &&
    existingSuggested.lng === hotelWaypoint.lng
  ) {
    return trip;
  }

  const withoutSuggested = sorted.filter(
    (waypoint) => !isSuggestedOvernightWaypoint(waypoint),
  );
  const endIndex = withoutSuggested.findIndex(
    (waypoint) => waypoint.waypoint_type === "end",
  );
  const insertionIndex =
    endIndex >= 0 ? Math.max(0, endIndex) : withoutSuggested.length;

  const nextWaypoints = [...withoutSuggested];
  nextWaypoints.splice(insertionIndex, 0, hotelWaypoint);
  const normalizedWaypoints = nextWaypoints.map((waypoint, index) => ({
    ...waypoint,
    sequence: index,
  }));

  const nextDay: TripDay = {
    ...day,
    waypoints: normalizedWaypoints,
  };
  const nextDays = [...trip.days];
  nextDays[dayIndex] = nextDay;

  return {
    ...trip,
    days: nextDays,
  };
}

export function sumDistance(days: TripDay[]): number {
  return days.reduce((acc, d) => acc + (d.distance_km || 0), 0);
}

export function averageQuality(days: TripDay[]): number {
  if (days.length === 0) return 0;
  // Weight by distance so a 400 km day of great asphalt doesn't get
  // averaged away by a 50 km gravel hop.
  const totalKm = sumDistance(days);
  if (totalKm <= 0) {
    const flat =
      days.reduce((acc, d) => acc + (d.avg_quality || 0), 0) / days.length;
    return Number.isFinite(flat) ? flat : 0;
  }
  const weighted = days.reduce(
    (acc, d) => acc + (d.avg_quality || 0) * (d.distance_km || 0),
    0,
  );
  return weighted / totalKm;
}

/**
 * Keep pass-check requests comfortably below both the backend's 25,000-point
 * route cap and its JSON body limit. The 1.5 km pass corridor does not need
 * the full rendering density of a saved/imported route.
 */
export const MAX_PASS_CHECK_ROUTE_POINTS = 500;

/**
 * Flatten every day's `route_geometry` into one polyline for the pass-check
 * API. Days are concatenated in `day_number` order and the complete line is
 * evenly sampled, preserving its first/last points. Days with fewer than two
 * points are skipped because PostGIS' `ST_MakeLine` would collapse them into
 * degenerate geometry. Returns an empty array when no usable geometry exists,
 * letting callers short-circuit the network round-trip entirely.
 */
export function flattenTripRoute(days: TripDay[]): LatLng[] {
  const ordered = [...days].sort((a, b) => a.day_number - b.day_number);
  const out: LatLng[] = [];
  for (const day of ordered) {
    const geom = day.route_geometry;
    if (!Array.isArray(geom) || geom.length < 2) continue;
    out.push(...geom);
  }
  if (out.length <= MAX_PASS_CHECK_ROUTE_POINTS) return out;

  const sampled: LatLng[] = [];
  const lastIndex = out.length - 1;
  const stride = lastIndex / (MAX_PASS_CHECK_ROUTE_POINTS - 1);
  for (let index = 0; index < MAX_PASS_CHECK_ROUTE_POINTS; index += 1) {
    const point = out[Math.round(index * stride)];
    if (point) sampled.push(point);
  }
  return sampled;
}

export function routeGeometrySignature(days: TripDay[]): string {
  const route = flattenTripRoute(days);
  if (route.length === 0) return "";
  return route.map((point) => `${point.lat},${point.lng}`).join("|");
}

export interface ClosedPassWarningData {
  passes: MountainPass[];
  count: number;
}

/**
 * Keep the warning headline exact even when the backend caps the returned pass
 * rows. The rows remain useful for names/details; `closed_count` represents the
 * complete pre-cap match set.
 */
export function buildClosedPassWarning(
  response: CheckRouteForPassesResponse,
): ClosedPassWarningData {
  const passes = response.passes.filter((pass) => pass.status === "closed");
  return {
    passes,
    count: Math.max(response.closed_count, passes.length),
  };
}

/**
 * Adapt a backend `Trip` into the shape the shared `tripToGpx` renderer
 * expects. Sorting days by `day_number` matches the on-screen order so
 * the exported GPX walks day 1 → day N regardless of how the API
 * happened to return them.
 */
export function tripToGpxInput(trip: Trip): TripGpxInput {
  const orderedDays = [...trip.days].sort(
    (a, b) => a.day_number - b.day_number,
  );
  return {
    name: trip.title,
    ...(trip.region != null ? { description: trip.region } : {}),
    days: orderedDays.map((day) => ({
      dayNumber: day.day_number,
      ...(day.title != null ? { title: day.title } : {}),
      waypoints: [...day.waypoints]
        .sort((a, b) => a.sequence - b.sequence)
        .map((w) => ({
          lat: w.lat,
          lng: w.lng,
          ...(w.name != null ? { name: w.name } : {}),
          type: w.waypoint_type,
        })),
      ...(Array.isArray(day.route_geometry)
        ? {
            routeGeometry: day.route_geometry.map(
              (p) => [p.lng, p.lat] as [number, number],
            ),
          }
        : {}),
    })),
  };
}

// Tiny adapter around the shared `haversineKm(lat1, lng1, lat2, lng2)` so
// the existing `(LatLng, LatLng)` call sites below stay readable. Mobile
// now resolves `@tarmoto/shared` via Metro's monorepo node_modules paths
// (US-20 added it as a runtime dep), so the previous "inlined to avoid
// pulling in shared" rationale no longer applies.
function haversineKm(a: LatLng, b: LatLng): number {
  return sharedHaversineKm(a.lat, a.lng, b.lat, b.lng);
}

/**
 * One fuel-to-fuel leg of a day's route. Names default to "Start" / "End"
 * / "Fuel" when the source waypoint has no label — the UI renders them
 * literally so callers can feed them straight into JSX.
 *
 * `suggestedStops` carries live fuel-station POIs that fall *inside*
 * the leg — only populated when the rider has pulled stations via
 * `/poi/along-route` and the leg actually exceeds range, so the
 * warning card can render a "refuel here" hint without the rider
 * manually editing waypoints (US-36).
 */
export interface FuelLeg {
  fromName: string;
  toName: string;
  distanceKm: number;
  exceedsRange: boolean;
  suggestedStops?: FuelLegSuggestedStop[];
}

export interface FuelLegSuggestedStop {
  name: string;
  hint: string | null;
  /** Distance from the leg start to the station, km. */
  distanceFromLegStartKm: number;
  /** Shortest distance between the station and the route, km. */
  distanceFromRouteKm: number;
}

/**
 * A fuel station along the day's route — the shape of a single entry
 * from `/poi/along-route` once the UI has narrowed to fuel kinds. Kept
 * separate from the POI type so the helper module stays free of the
 * broader `Poi`/`AlongRoutePoi` imports and the unit tests can pass in
 * minimal fixtures.
 */
export interface FuelStationAnchor {
  name: string | null;
  hint: string | null;
  distanceAlongRouteKm: number;
  distanceFromRouteKm: number;
}

/**
 * Partition a day's route into legs bounded by fuel waypoints and surface
 * the ones that outrun the rider's declared fuel range (US-10).
 *
 * Algorithm:
 *   1. Pre-compute cumulative polyline distance at each geometry vertex.
 *   2. Snap every `fuel` waypoint to the nearest vertex (by haversine)
 *      and record its cumulative distance along the polyline.
 *   3. Sort those anchors along the route so two fuel stops listed in
 *      non-geographic order still yield monotonic legs.
 *   4. Prepend a virtual "Start" anchor at 0 km and append an "End"
 *      anchor at `totalKm`, then emit each consecutive pair as a leg.
 *
 * Returns `[]` for degenerate inputs (no geometry, fewer than two
 * points) — callers use that to short-circuit the warning card.
 *
 * Edge cases:
 *   - A fuel waypoint far from any vertex still snaps to its nearest;
 *     callers are expected to trust the waypoint is along the route.
 *   - `fuelRangeKm <= 0` disables the exceed flag so a misconfigured
 *     preference can never nag the rider about every leg.
 */
export function computeFuelRangeLegs(
  day: TripDay,
  fuelRangeKm: number,
): FuelLeg[] {
  const geom = day.route_geometry;
  if (!Array.isArray(geom) || geom.length < 2) return [];

  const cumKm: number[] = new Array(geom.length);
  cumKm[0] = 0;
  for (let i = 1; i < geom.length; i++) {
    const prev = geom[i - 1];
    const curr = geom[i];
    cumKm[i] =
      (cumKm[i - 1] ?? 0) + (prev && curr ? haversineKm(prev, curr) : 0);
  }
  const totalKm = cumKm[cumKm.length - 1] ?? 0;

  const sortedWaypoints = [...day.waypoints].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const anchors = sortedWaypoints
    .filter((w) => w.waypoint_type === "fuel")
    .map((w) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < geom.length; i++) {
        const point = geom[i];
        if (!point) continue;
        const d = haversineKm(w, point);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return {
        name: w.name ?? translate("Fuel"),
        cumKm: cumKm[bestIdx] ?? 0,
      };
    })
    .sort((a, b) => a.cumKm - b.cumKm);

  const start = sortedWaypoints.find((w) => w.waypoint_type === "start");
  const end = sortedWaypoints.find((w) => w.waypoint_type === "end");
  const points = [
    { name: start?.name ?? translate("Start"), cumKm: 0 },
    ...anchors,
    { name: end?.name ?? translate("End"), cumKm: totalKm },
  ];

  const legs: FuelLeg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (!from || !to) continue;
    const distanceKm = Math.max(0, to.cumKm - from.cumKm);
    legs.push({
      fromName: from.name,
      toName: to.name,
      distanceKm,
      exceedsRange: fuelRangeKm > 0 && distanceKm > fuelRangeKm,
    });
  }
  return legs;
}

/**
 * Aggregate view of a day's fuel-leg breakdown — convenient when the UI
 * just wants "is there a problem, and how bad is the worst leg?"
 *
 * When `stations` is supplied, exceeding legs are annotated with the
 * live fuel stations inside them so the warning card can offer a
 * "refuel at X" hint rather than just shouting about the distance
 * (US-36). Stations are only attached to over-range legs because a
 * within-range leg already doesn't need them and cluttering the card
 * with every pump on every leg defeats the purpose of the warning.
 */
export function summarizeFuelRange(
  day: TripDay,
  fuelRangeKm: number,
  stations: FuelStationAnchor[] = [],
): { legs: FuelLeg[]; longestLegKm: number; exceedingCount: number } {
  const rawLegs = computeFuelRangeLegs(day, fuelRangeKm);
  const legs = annotateLegsWithStations(rawLegs, day, stations);
  const longestLegKm = legs.reduce((m, l) => Math.max(m, l.distanceKm), 0);
  const exceedingCount = legs.filter((l) => l.exceedsRange).length;
  return { legs, longestLegKm, exceedingCount };
}

/**
 * Maximum suggested stops attached per exceeding leg. Keeps the warning
 * card scannable — a rider looking at 6 options on a single leg is a
 * planning-app job, not a glove-friendly alert.
 */
const MAX_SUGGESTED_STOPS_PER_LEG = 3;

/**
 * Display label for a fuel stop that carries no OSM name (common for
 * unmanned / automated pumps). Mirrors `fallbackAccommodationName`: a
 * plain data-level fallback so the pure helper stays free of i18n, and
 * so a nameless-but-real refuel option is never dropped from the warning.
 */
const UNNAMED_FUEL_STOP_LABEL = "Fuel stop";

/**
 * Re-project the leg breakdown onto the polyline's cumulative-km axis
 * so station positions (which arrive from the backend already indexed
 * by distance-along-route) can be bucketed into the right leg. We
 * re-compute the axis here rather than passing it down from
 * `computeFuelRangeLegs` because the leg list is the stable public
 * output; the vertex cumulative array is an implementation detail that
 * would otherwise have to leak out to callers that don't care about
 * stations.
 */
function annotateLegsWithStations(
  legs: FuelLeg[],
  day: TripDay,
  stations: FuelStationAnchor[],
): FuelLeg[] {
  if (stations.length === 0) return legs;
  if (!legs.some((l) => l.exceedsRange)) return legs;
  const geom = day.route_geometry;
  if (!Array.isArray(geom) || geom.length < 2) return legs;

  // Reproduce the cumulative axis and anchor positions so we know where
  // each leg starts along the route without changing the legs' public
  // API. Fast to rebuild — O(n) over the geometry — and only runs when
  // the caller has actually opted into stations.
  const cumKm: number[] = new Array(geom.length);
  cumKm[0] = 0;
  for (let i = 1; i < geom.length; i++) {
    const prev = geom[i - 1];
    const curr = geom[i];
    cumKm[i] =
      (cumKm[i - 1] ?? 0) + (prev && curr ? haversineKm(prev, curr) : 0);
  }
  const totalKm = cumKm[cumKm.length - 1] ?? 0;

  const sortedWaypoints = [...day.waypoints].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const fuelAnchorKms = sortedWaypoints
    .filter((w) => w.waypoint_type === "fuel")
    .map((w) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < geom.length; i++) {
        const point = geom[i];
        if (!point) continue;
        const d = haversineKm(w, point);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return cumKm[bestIdx] ?? 0;
    })
    .sort((a, b) => a - b);
  const legBoundaries = [0, ...fuelAnchorKms, totalKm];

  const sortedStations = [...stations].sort(
    (a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm,
  );

  return legs.map((leg, idx) => {
    if (!leg.exceedsRange) return leg;
    const startKm = legBoundaries[idx] ?? 0;
    const endKm = legBoundaries[idx + 1] ?? Infinity;
    const inside = sortedStations.filter(
      (s) => s.distanceAlongRouteKm > startKm && s.distanceAlongRouteKm < endKm,
    );
    if (inside.length === 0) return leg;

    const suggestedStops: FuelLegSuggestedStop[] = inside
      .slice(0, MAX_SUGGESTED_STOPS_PER_LEG)
      .map((s) => ({
        // Keep unnamed pumps — an unmanned fuel stop is still a real refuel
        // option (navigable via maps_url) — with a fallback label so the
        // warning card renders it instead of claiming there is no fuel.
        name: s.name?.trim() || translate(UNNAMED_FUEL_STOP_LABEL),
        hint: s.hint,
        distanceFromLegStartKm: s.distanceAlongRouteKm - startKm,
        distanceFromRouteKm: s.distanceFromRouteKm,
      }));
    return { ...leg, suggestedStops };
  });
}

/**
 * Pick the anchor point a day's accommodation suggestions should orbit
 * around (US-10). Riders need somewhere to sleep at the end of the day,
 * so we prefer an explicit itinerary anchor first: the planner's `end`
 * waypoint, then any non-synthetic hotel waypoint. Client-only suggested
 * stays are intentionally ignored here so they cannot re-anchor the next
 * accommodation fetch. If no explicit day-end anchor exists, fall back to
 * the last vertex of the route geometry; if that's missing too, use the
 * last non-suggested waypoint as a best-effort fallback.
 */
export function pickDayEndAnchor(day: TripDay): LatLng | null {
  const sorted = [...day.waypoints].sort((a, b) => a.sequence - b.sequence);
  const explicitEnd = [...sorted]
    .reverse()
    .find((waypoint) => waypoint.waypoint_type === "end");
  if (explicitEnd) return { lat: explicitEnd.lat, lng: explicitEnd.lng };

  const explicitHotel = [...sorted]
    .reverse()
    .find(
      (waypoint) =>
        waypoint.waypoint_type === "hotel" &&
        !isSuggestedOvernightWaypoint(waypoint),
    );
  if (explicitHotel) {
    return { lat: explicitHotel.lat, lng: explicitHotel.lng };
  }

  const geom = day.route_geometry;
  if (Array.isArray(geom) && geom.length > 0) {
    const last = geom[geom.length - 1];
    if (last) return last;
  }

  const lastNonSuggested = [...sorted]
    .reverse()
    .find((waypoint) => !isSuggestedOvernightWaypoint(waypoint));
  if (lastNonSuggested) {
    return { lat: lastNonSuggested.lat, lng: lastNonSuggested.lng };
  }

  return null;
}

/**
 * Whether a given day is the final day of a trip. The accommodation
 * suggestions card is hidden on the last day since the rider is expected
 * to be returning home, not looking for another bed.
 */
export function isLastDay(days: TripDay[], dayNumber: number): boolean {
  const first = days[0];
  if (!first) return false;
  const max = days.reduce(
    (m, d) => (d.day_number > m ? d.day_number : m),
    first.day_number,
  );
  return dayNumber === max;
}

/**
 * Build a coarse bounding box around a start point for the generator API.
 * The backend refines this based on the number of days, but it needs *some*
 * envelope so the initial solver doesn't grind over the entire continent.
 *
 * Per-day budget: a ~100 km radius per ride day, capped at 600 km so a
 * 14-day epic doesn't ask the server for a 1500 km square.
 */
export function bboxAroundPoint(
  lat: number,
  lng: number,
  numDays: number,
): string {
  const safeDays = Math.max(1, Math.min(14, Math.round(numDays || 1)));
  const radiusKm = Math.min(600, safeDays * 100);
  // 1 degree latitude ≈ 111 km, longitude scales by cos(lat).
  const latDelta = radiusKm / 111;
  const latRad = (lat * Math.PI) / 180;
  const lngDelta = radiusKm / (111 * Math.max(0.1, Math.cos(latRad)));
  const minLng = lng - lngDelta;
  const minLat = lat - latDelta;
  const maxLng = lng + lngDelta;
  const maxLat = lat + latDelta;
  // West, South, East, North — the OGC convention the backend consumes.
  return `${minLng.toFixed(4)},${minLat.toFixed(4)},${maxLng.toFixed(4)},${maxLat.toFixed(4)}`;
}

/**
 * Ordered list of URLs to try when a rider taps a POI row, most-useful
 * first: the venue's own website, a phone dialer, then the Google Maps
 * deep link (`maps_url` — photos / reviews / live hours), and finally a
 * bare OpenStreetMap coordinate pin. `maps_url` sits ahead of the OSM
 * fallback so contactless rows — which the backend now keeps precisely
 * because `maps_url` makes them navigable — still open a rich page.
 */
export function poiOpenCandidates(item: {
  website: string | null;
  phone: string | null;
  maps_url: string;
  lat: number;
  lng: number;
}): string[] {
  const website =
    item.website && /^https?:\/\//i.test(item.website.trim())
      ? item.website.trim()
      : null;
  return [
    website,
    item.phone ? `tel:${item.phone.replace(/\s+/g, "")}` : null,
    item.maps_url || null,
    `https://www.openstreetmap.org/?mlat=${item.lat}&mlon=${item.lng}#map=17/${item.lat}/${item.lng}`,
  ].filter((value): value is string => !!value);
}

function overnightFitScore(accommodation: Accommodation): number {
  const nameBonus = accommodation.name?.trim() ? 0.75 : 0;
  const starsBonus = (accommodation.stars ?? 0) * 0.6;
  const kindBonus = ACCOMMODATION_KIND_PRIORITY[accommodation.kind] ?? 0;
  const distancePenalty = accommodation.distance_km * 2.5;
  return nameBonus + starsBonus + kindBonus - distancePenalty;
}

function fallbackAccommodationName(kind: AccommodationKind): string {
  const labels: Record<AccommodationKind, EnglishMessageKey> = {
    hotel: "Hotel",
    motel: "Motel",
    hostel: "Hostel",
    guest_house: "Guest house",
    apartment: "Apartment",
    chalet: "Chalet",
    camp_site: "Camp site",
  };
  return translate(labels[kind]);
}
