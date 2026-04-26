import { haversineKm, REGIONS } from '@tarmoto/shared';
import {
  ALLOWED_SURFACES,
  type AllowedSurface,
  type TripGenerationOptionId,
} from './dto/generate-trip.dto.js';

/**
 * Bbox tuple: `[west, south, east, north]` in WGS84 lng/lat.
 * Same order the regions catalog uses, and the order PostGIS's
 * `ST_MakeEnvelope` expects.
 */
export type BBox = [number, number, number, number];

/**
 * Pure preset descriptor — kept here (not in the service) so
 * `chunkDistance` and `pickRouteForOption` stay deterministic and unit
 * tests don't need a TestingModule.
 */
export interface OptionPreset {
  id: TripGenerationOptionId;
  label: string;
  summary: string;
  /** Multiplier applied to the average daily km target. */
  distanceMultiplier: number;
  /** Weight on `quality_score` (0..1) when ranking OSRM alternatives. */
  qualityWeight: number;
  /** Weight on `curviness_score` (0..1) when ranking OSRM alternatives. */
  curvinessWeight: number;
  /** Weight on `scenic_score` (fun-zone overlap) when ranking. */
  scenicWeight: number;
  /** Weight on `1 / duration_min` so faster routes float up for `fastest`. */
  speedWeight: number;
}

export const OPTION_PRESETS: readonly OptionPreset[] = [
  {
    id: 'best-fit',
    label: 'Best fit',
    summary: 'Balanced route closest to your trip settings.',
    distanceMultiplier: 1.0,
    qualityWeight: 0.4,
    curvinessWeight: 0.3,
    scenicWeight: 0.2,
    speedWeight: 0.1,
  },
  {
    id: 'scenic',
    label: 'Scenic sweep',
    summary: 'Longer, twistier days with more fun-zone time.',
    distanceMultiplier: 1.12,
    qualityWeight: 0.25,
    curvinessWeight: 0.4,
    scenicWeight: 0.3,
    speedWeight: 0.05,
  },
  {
    id: 'fastest',
    label: 'Fastest line',
    summary: 'Shorter, more direct days that still keep good roads.',
    distanceMultiplier: 0.88,
    qualityWeight: 0.3,
    curvinessWeight: 0.1,
    scenicWeight: 0.05,
    speedWeight: 0.55,
  },
];

/** Approximate paved/road km per great-circle km for a typical mountain region. */
const ROAD_DETOUR_FACTOR = 1.35;

/**
 * Distance (km) between consecutive fuel waypoints. Conservative — most
 * adventure bikes have ~250–350 km of dependable range, so a 220 km cap
 * surfaces a fuel stop with margin even when the corridor's stations are
 * sparse. Edge case AC: when no candidate fuel stops exist within the
 * range, we omit the waypoint rather than placing a `null`-named one.
 */
export const FUEL_RANGE_KM = 220;

/**
 * Soft minimum so the generator never persists a row that the daily-km
 * card would render as a single dot. Below this, a "trip" really wants a
 * different feature (e.g. day ride).
 */
export const MIN_DAILY_KM = 30;

/** Soft maximum to keep estimated_time within a reasonable single-day window. */
export const MAX_DAILY_KM = 800;

/**
 * Compute per-day target distances (km) given the trip's bounds. The
 * result has length `numDays` and sums to roughly `numDays * avg`.
 *
 * Pure function exported for unit tests — the AC explicitly calls for
 * "unit tests for chunking".
 */
export function chunkDistance(
  numDays: number,
  dailyKmMin: number,
  dailyKmMax: number,
  multiplier: number,
): number[] {
  if (numDays <= 0) return [];
  const avg = (dailyKmMin + dailyKmMax) / 2;
  const target = clamp(avg * multiplier, MIN_DAILY_KM, MAX_DAILY_KM);
  return new Array<number>(numDays).fill(target);
}

/**
 * Resolve the working bbox for the generator. Order of preference:
 *  1. Caller-supplied `bboxString` (validated lng-first quartet)
 *  2. The trip's `region` if it matches a slug in the shared catalog
 *  3. A default ~150 km square around `start` (corner-on-corner ≈ 200 km)
 *
 * Pure helper — no I/O, no DB.
 */
export function resolveBBox(
  bboxString: string | undefined,
  region: string | null,
  start: { lat: number; lng: number },
): BBox {
  if (bboxString) {
    const parts = bboxString.split(',').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [w, s, e, n] = parts;
      if (w < e && s < n) return [w, s, e, n];
    }
  }
  if (region) {
    const slug = region.toLowerCase().replace(/\s+/g, '-');
    const match = REGIONS.find((r) => r.slug === slug || r.name === region);
    if (match) {
      const [w, s, e, n] = match.bbox;
      return [w, s, e, n];
    }
  }
  // Default: ~1.5° square (≈ 150 km at mid-latitudes) around start.
  const halfDeg = 0.75;
  return [
    start.lng - halfDeg,
    start.lat - halfDeg,
    start.lng + halfDeg,
    start.lat + halfDeg,
  ];
}

/**
 * Pick `count` distinct anchor points inside `bbox` to be the day-end
 * targets, ordered by distance from `start` (so the returned itinerary
 * has a coherent geographic flow rather than random teleports).
 *
 * `funZones` is an ordered list of zone centroids by composite_score
 * desc. We take up to `count` of them (preferring high-score zones),
 * then pad with compass-spread fallback points if the bbox doesn't
 * contain enough fun zones to fill the schedule.
 */
export function pickAnchors(
  start: { lat: number; lng: number },
  bbox: BBox,
  funZones: ReadonlyArray<{ lat: number; lng: number }>,
  count: number,
): { lat: number; lng: number }[] {
  if (count <= 0) return [];
  const anchors: { lat: number; lng: number }[] = [];

  // Take fun zones first (already sorted by composite_score desc).
  for (const fz of funZones) {
    if (anchors.length >= count) break;
    if (!isInsideBBox(fz, bbox)) continue;
    if (isTooClose(fz, start, 20) || isTooCloseToAny(fz, anchors, 20)) continue;
    anchors.push(fz);
  }

  // Fill the remainder with compass-spread points around `start`. We
  // step the compass at roughly 360°/count to keep adjacent anchors
  // geographically distinct rather than piling them on one bearing.
  if (anchors.length < count) {
    const fallbackDistKm = midpointFallbackDistanceKm(bbox, start);
    const stepDeg = 360 / count;
    let bearing = 0;
    while (anchors.length < count && bearing < 360) {
      const cand = pointAtBearing(start, bearing, fallbackDistKm);
      bearing += stepDeg;
      if (!isInsideBBox(cand, bbox)) continue;
      if (isTooCloseToAny(cand, anchors, 20)) continue;
      anchors.push(cand);
    }
  }

  // Sort by distance from start so the itinerary reads as a flowing
  // outward progression rather than zig-zagging back and forth across
  // the bbox.
  anchors.sort(
    (a, b) =>
      haversineKm(start.lat, start.lng, a.lat, a.lng) -
      haversineKm(start.lat, start.lng, b.lat, b.lng),
  );

  return anchors;
}

/**
 * Build the day-by-day endpoint chain from a list of anchors. The chain
 * always opens and closes at `start` so the trip is a loop (multi-day
 * trips returning to a single base camp). `anchors.length` is therefore
 * `numDays - 1` for a loop — the generator passes `numDays - 1` to
 * `pickAnchors`.
 */
export function buildDayChain(
  start: { lat: number; lng: number },
  anchors: ReadonlyArray<{ lat: number; lng: number }>,
  numDays: number,
): { from: { lat: number; lng: number }; to: { lat: number; lng: number } }[] {
  if (numDays <= 0) return [];
  if (numDays === 1) {
    // Loop the single day through whichever anchor is best — falls back
    // to start-on-start if no anchor was found, which OSRM will treat
    // as a degenerate request and the generator will then short-circuit
    // to a point-radius response. The caller is responsible for the
    // empty-anchor case; here we just emit the chain.
    const mid = anchors[0] ?? start;
    return [{ from: start, to: mid }];
  }

  const chain: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
  }[] = [];
  let cursor = start;
  for (let i = 0; i < numDays - 1; i++) {
    const next = anchors[i] ?? start;
    chain.push({ from: cursor, to: next });
    cursor = next;
  }
  chain.push({ from: cursor, to: start });
  return chain;
}

/**
 * Score one OSRM route alternative against a preset's weights. Higher
 * is better. All inputs are in normalised [0..1] space, except
 * `durationMin` which is converted to `1 / (1 + min/120)` so a 0-minute
 * route saturates at 1 and a 4-hour route lands near 0.5.
 *
 * Pure — exported for tests so the AC's "quality weighting" coverage
 * is straightforward to assert.
 */
export function scoreRoute(
  preset: OptionPreset,
  metrics: {
    avgQuality: number | null; // 0..5
    curvinessScore: number | null; // 0..100
    scenicScore: number | null; // 0..100
    durationMin: number; // > 0
  },
): number {
  const q = (metrics.avgQuality ?? 0) / 5; // 0..1
  const c = (metrics.curvinessScore ?? 0) / 100;
  const s = (metrics.scenicScore ?? 0) / 100;
  const speed = 1 / (1 + Math.max(metrics.durationMin, 0) / 120);
  return (
    preset.qualityWeight * q +
    preset.curvinessWeight * c +
    preset.scenicWeight * s +
    preset.speedWeight * speed
  );
}

/**
 * Resolve the final surface allow-list from the request DTO, applying
 * the implicit `avoid_unpaved` rule. Returns `null` when no filter
 * should be applied (i.e. all surfaces allowed).
 */
export function resolveSurfaceFilter(
  surfaces: AllowedSurface[] | undefined,
  avoidUnpaved: boolean | undefined,
): AllowedSurface[] | null {
  if (surfaces && surfaces.length > 0) {
    if (avoidUnpaved) {
      return surfaces.filter((s) => s !== 'gravel' && s !== 'dirt');
    }
    return [...surfaces];
  }
  if (avoidUnpaved) {
    return ALLOWED_SURFACES.filter((s) => s !== 'gravel' && s !== 'dirt');
  }
  return null;
}

/**
 * Indices into `route` (lat/lng polyline) where a fuel waypoint should
 * be planted, ignoring the start/end (they're modelled as `start`/`end`
 * waypoints by the service). Returns indices >= 1 and < route.length-1
 * spaced at `FUEL_RANGE_KM` cumulative kilometres.
 *
 * When the day's total distance is below `FUEL_RANGE_KM` the function
 * returns an empty array — covers the AC edge case "no fuel stops
 * within range".
 */
export function planFuelStopIndices(
  route: ReadonlyArray<{ lat: number; lng: number }>,
  totalDistanceKm: number,
): number[] {
  if (route.length < 3) return [];
  if (totalDistanceKm <= FUEL_RANGE_KM) return [];

  const indices: number[] = [];
  let cumKm = 0;
  let nextBoundary = FUEL_RANGE_KM;
  for (let i = 1; i < route.length; i++) {
    cumKm += haversineKm(
      route[i - 1].lat,
      route[i - 1].lng,
      route[i].lat,
      route[i].lng,
    );
    if (cumKm >= nextBoundary && i < route.length - 1) {
      indices.push(i);
      nextBoundary += FUEL_RANGE_KM;
    }
  }
  return indices;
}

// ── private helpers ──

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isInsideBBox(p: { lat: number; lng: number }, bbox: BBox): boolean {
  const [w, s, e, n] = bbox;
  return p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n;
}

function isTooClose(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  thresholdKm: number,
): boolean {
  return haversineKm(a.lat, a.lng, b.lat, b.lng) < thresholdKm;
}

function isTooCloseToAny(
  p: { lat: number; lng: number },
  others: ReadonlyArray<{ lat: number; lng: number }>,
  thresholdKm: number,
): boolean {
  return others.some((o) => isTooClose(p, o, thresholdKm));
}

/**
 * Distance to use for compass-spread fallback anchors when the bbox
 * holds fewer fun zones than the trip needs. We use 85% of the *minimum*
 * great-circle distance from `start` to any bbox edge midpoint — that
 * guarantees a compass-bearing point at this radius lands inside the
 * bbox along the cardinal directions, with a small margin so
 * intercardinal bearings (NE / SE / SW / NW) usually fit too.
 *
 * Floored at 40 km so a tiny bbox doesn't produce anchors stacked on
 * top of each other.
 */
function midpointFallbackDistanceKm(
  bbox: BBox,
  start: { lat: number; lng: number },
): number {
  const [w, s, e, n] = bbox;
  const minEdgeKm = Math.min(
    haversineKm(start.lat, start.lng, n, start.lng),
    haversineKm(start.lat, start.lng, s, start.lng),
    haversineKm(start.lat, start.lng, start.lat, e),
    haversineKm(start.lat, start.lng, start.lat, w),
  );
  return Math.max(40, minEdgeKm * 0.85);
}

/**
 * Project `start` along a great-circle bearing for the given distance.
 * Approximation good to a few metres at the few-km scale this is used at.
 */
function pointAtBearing(
  start: { lat: number; lng: number },
  bearingDeg: number,
  distanceKm: number,
): { lat: number; lng: number } {
  const R = 6371; // km
  const δ = distanceKm / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (start.lat * Math.PI) / 180;
  const λ1 = (start.lng * Math.PI) / 180;

  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return {
    lat: (φ2 * 180) / Math.PI,
    lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/** Re-exported so consumers don't need to reach back into `@tarmoto/shared`. */
export { ROAD_DETOUR_FACTOR };
