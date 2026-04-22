/**
 * Pure formatting + shaping helpers for the Trip screens.
 *
 * Kept out of the screen modules so unit tests can exercise them without
 * pulling React Native or navigation into the module graph.
 */

import type {
  LatLng,
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

export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return "0 km";
  return `${Math.round(km)} km`;
}

/** "2h 30m" / "45m" — keep short for metric rows. */
export function formatDurationMin(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  // Round to whole minutes *first*, then split into h/m. Rounding the
  // modulo remainder independently can yield 60 (e.g. 59.5 → 60),
  // producing invalid strings like "60m" or "1h 60m".
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatStatus(status: TripStatus): string {
  return capitalize(status);
}

export function formatWaypointType(t: WaypointType): string {
  // "via" reads oddly capitalised — leave it lowercase so "Via" doesn't
  // appear as a proper noun in the UI.
  if (t === "via") return "Waypoint";
  return capitalize(t);
}

export const WAYPOINT_ICONS: Record<WaypointType, string> = {
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
export function summarizeWaypoints(waypoints: Waypoint[]): {
  fuelStops: Waypoint[];
  overnightStops: Waypoint[];
  otherStops: Waypoint[];
  start: Waypoint | null;
  end: Waypoint | null;
} {
  const sorted = [...waypoints].sort((a, b) => a.sequence - b.sequence);
  const fuelStops = sorted.filter((w) => w.waypoint_type === "fuel");
  const overnightStops = sorted.filter((w) => w.waypoint_type === "hotel");
  const otherStops = sorted.filter(
    (w) =>
      w.waypoint_type !== "fuel" &&
      w.waypoint_type !== "hotel" &&
      w.waypoint_type !== "start" &&
      w.waypoint_type !== "end",
  );
  const start = sorted.find((w) => w.waypoint_type === "start") ?? null;
  const end = sorted.find((w) => w.waypoint_type === "end") ?? null;
  return { fuelStops, overnightStops, otherStops, start, end };
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
 * Flatten every day's `route_geometry` into one polyline for the
 * pass-check API. Days are concatenated in `day_number` order so the
 * resulting line follows the actual trip sequence; days with fewer
 * than two points are skipped because PostGIS' `ST_MakeLine` would
 * collapse them into degenerate geometry. Returns an empty array when
 * no usable geometry exists, letting callers short-circuit the network
 * round-trip entirely.
 */
export function flattenTripRoute(days: TripDay[]): LatLng[] {
  const ordered = [...days].sort((a, b) => a.day_number - b.day_number);
  const out: LatLng[] = [];
  for (const day of ordered) {
    const geom = day.route_geometry;
    if (!Array.isArray(geom) || geom.length < 2) continue;
    out.push(...geom);
  }
  return out;
}

// Great-circle distance between two lat/lng pairs, in kilometres.
// Inlined here so the helper module stays free of runtime deps — the
// mobile app doesn't (yet) pull in `@tarmoto/shared` at build time.
const EARTH_RADIUS_KM = 6371;
function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
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
    cumKm[i] = cumKm[i - 1] + haversineKm(geom[i - 1], geom[i]);
  }
  const totalKm = cumKm[cumKm.length - 1];

  const sortedWaypoints = [...day.waypoints].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const anchors = sortedWaypoints
    .filter((w) => w.waypoint_type === "fuel")
    .map((w) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < geom.length; i++) {
        const d = haversineKm(w, geom[i]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return { name: w.name ?? "Fuel", cumKm: cumKm[bestIdx] };
    })
    .sort((a, b) => a.cumKm - b.cumKm);

  const start = sortedWaypoints.find((w) => w.waypoint_type === "start");
  const end = sortedWaypoints.find((w) => w.waypoint_type === "end");
  const points = [
    { name: start?.name ?? "Start", cumKm: 0 },
    ...anchors,
    { name: end?.name ?? "End", cumKm: totalKm },
  ];

  const legs: FuelLeg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const distanceKm = Math.max(0, points[i + 1].cumKm - points[i].cumKm);
    legs.push({
      fromName: points[i].name,
      toName: points[i + 1].name,
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
    cumKm[i] = cumKm[i - 1] + haversineKm(geom[i - 1], geom[i]);
  }
  const totalKm = cumKm[cumKm.length - 1];

  const sortedWaypoints = [...day.waypoints].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const fuelAnchorKms = sortedWaypoints
    .filter((w) => w.waypoint_type === "fuel")
    .map((w) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < geom.length; i++) {
        const d = haversineKm(w, geom[i]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return cumKm[bestIdx];
    })
    .sort((a, b) => a - b);
  const legBoundaries = [0, ...fuelAnchorKms, totalKm];

  const sortedStations = [...stations].sort(
    (a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm,
  );

  return legs.map((leg, idx) => {
    if (!leg.exceedsRange) return leg;
    const startKm = legBoundaries[idx];
    const endKm = legBoundaries[idx + 1];
    const inside = sortedStations
      .filter(
        (s) =>
          s.distanceAlongRouteKm > startKm && s.distanceAlongRouteKm < endKm,
      )
      .filter((s): s is FuelStationAnchor & { name: string } =>
        Boolean(s.name?.trim()),
      );
    if (inside.length === 0) return leg;

    const suggestedStops: FuelLegSuggestedStop[] = inside
      .slice(0, MAX_SUGGESTED_STOPS_PER_LEG)
      .map((s) => ({
        name: s.name,
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
 * so we prefer the last waypoint by sequence — typically a "hotel" or
 * "end" marker produced by the trip generator. If that's missing, fall
 * back to the last vertex of the route geometry; if neither exists,
 * return `null` so the UI can hide the card entirely.
 */
export function pickDayEndAnchor(day: TripDay): LatLng | null {
  if (day.waypoints.length > 0) {
    const sorted = [...day.waypoints].sort((a, b) => a.sequence - b.sequence);
    const last = sorted[sorted.length - 1];
    if (last) return { lat: last.lat, lng: last.lng };
  }
  const geom = day.route_geometry;
  if (Array.isArray(geom) && geom.length > 0) {
    return geom[geom.length - 1];
  }
  return null;
}

/**
 * Whether a given day is the final day of a trip. The accommodation
 * suggestions card is hidden on the last day since the rider is expected
 * to be returning home, not looking for another bed.
 */
export function isLastDay(days: TripDay[], dayNumber: number): boolean {
  if (days.length === 0) return false;
  const max = days.reduce(
    (m, d) => (d.day_number > m ? d.day_number : m),
    days[0].day_number,
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
