import { haversineMeters } from '@tarmoto/shared';

/**
 * Pure geometry core of the OSM → `road_segments` importer (#781): split an
 * OSM way into ~100 m segments and derive each segment's length + curviness.
 * No I/O — kept side-effect-free so it's unit-testable without a PBF parser
 * or the database (those are separate slices).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Default ~100 m segment target (§1 of the data reference). */
export const SEGMENT_TARGET_METERS = 100;

/**
 * Curviness calibration: `curviness_score` is on a 0–5 scale where the
 * fun-zone clustering treats **≥ 3.0** as "notably curvy". We derive it from
 * total heading change per km; this many degrees-of-turn per km maps to one
 * curviness point, so ~450 deg/km → 3.0 and ~750 deg/km saturates at 5.
 */
const DEG_PER_KM_PER_CURVINESS_POINT = 150;

/** Total length of a polyline in metres. */
export function polylineLengthMeters(coords: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(
      coords[i - 1].lat,
      coords[i - 1].lng,
      coords[i].lat,
      coords[i].lng,
    );
  }
  return total;
}

/** Linear interpolation between two points (fine at ~100 m scale). */
function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Split a way's coordinate list into consecutive segments of about
 * `targetMeters`, inserting interpolated split points on the boundaries so
 * each segment is a valid LineString that joins the next (the split point is
 * shared). A short final tail (< half the target) is merged into the previous
 * segment rather than left as a stub. Returns `[]` for < 2 points.
 */
export function splitIntoSegments(
  coords: readonly LatLng[],
  targetMeters: number = SEGMENT_TARGET_METERS,
): LatLng[][] {
  if (coords.length < 2 || targetMeters <= 0) return [];

  const segments: LatLng[][] = [];
  let current: LatLng[] = [coords[0]];
  let accrued = 0; // metres accumulated in the current segment

  for (let i = 1; i < coords.length; i++) {
    let a = current[current.length - 1];
    const b = coords[i];
    let edge = haversineMeters(a.lat, a.lng, b.lat, b.lng);

    // The edge a→b may span one or more target boundaries; split at each.
    while (edge > 0 && accrued + edge >= targetMeters) {
      const t = (targetMeters - accrued) / edge;
      const split = lerp(a, b, t);
      current.push(split);
      segments.push(current);
      current = [split];
      accrued = 0;
      a = split;
      edge = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    }

    current.push(b);
    accrued += edge;
  }

  if (current.length >= 2) {
    if (segments.length > 0 && accrued < targetMeters / 2) {
      // Merge the short tail into the previous segment (skip the shared start).
      segments[segments.length - 1].push(...current.slice(1));
    } else {
      segments.push(current);
    }
  }
  return segments;
}

/** Initial bearing a→b, degrees in [0, 360). */
function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute turn between two bearings, degrees in [0, 180]. */
function turnDeg(b1: number, b2: number): number {
  const diff = Math.abs(b2 - b1) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Sum of absolute heading changes (degrees) at the interior vertices. */
function totalHeadingChangeDeg(coords: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    total += turnDeg(
      bearingDeg(coords[i - 1], coords[i]),
      bearingDeg(coords[i], coords[i + 1]),
    );
  }
  return total;
}

/** Map heading-change-per-km to the 0–5 curviness scale (clamped, 2 dp). */
function scoreFromTurn(totalTurnDeg: number, lengthM: number): number {
  const km = lengthM / 1000;
  if (km <= 0) return 0;
  const score = totalTurnDeg / km / DEG_PER_KM_PER_CURVINESS_POINT;
  return Math.round(Math.min(5, score) * 100) / 100;
}

/**
 * Curviness of a standalone polyline on a 0–5 scale (straight ≈ 0, twisty ≥ 3)
 * — total heading change per km, calibrated by `DEG_PER_KM_PER_CURVINESS_POINT`
 * and clamped to 5. Tunable — callers threshold on the value, not its exact
 * magnitude. For per-segment scoring use `segmentWay`, which preserves the
 * turns at segment boundaries this function (on its own) can't see.
 */
export function curvinessScore(coords: readonly LatLng[]): number {
  if (coords.length < 3) return 0;
  return scoreFromTurn(
    totalHeadingChangeDeg(coords),
    polylineLengthMeters(coords),
  );
}

export interface WaySegment {
  coords: LatLng[];
  length_m: number;
  curviness_score: number;
}

/**
 * Split a way into ~`targetMeters` segments AND score each one's curviness
 * with **boundary context**: a bend that lands on (or near) a segment boundary
 * would otherwise be lost — each side becomes a straight 2-point segment. So a
 * segment's curviness is computed over its own coords plus the neighbouring
 * vertex just outside each end, while normalising by the segment's own length.
 * A boundary bend is therefore counted in both adjacent segments (both ~100 m
 * stretches around a corner are genuinely curvy), never dropped.
 */
export function segmentWay(
  coords: readonly LatLng[],
  targetMeters: number = SEGMENT_TARGET_METERS,
): WaySegment[] {
  const segments = splitIntoSegments(coords, targetMeters);
  return segments.map((seg, i) => {
    const prev = segments[i - 1];
    const next = segments[i + 1];
    // `prev`'s last point == `seg`'s first (shared boundary), so the neighbour
    // just outside this segment's start is `prev`'s second-to-last point;
    // similarly the point past the end is `next`'s second point.
    const before = prev ? prev[prev.length - 2] : undefined;
    const after = next ? next[1] : undefined;
    const context = [
      ...(before ? [before] : []),
      ...seg,
      ...(after ? [after] : []),
    ];
    const length_m = polylineLengthMeters(seg);
    return {
      coords: seg,
      length_m,
      curviness_score: scoreFromTurn(totalHeadingChangeDeg(context), length_m),
    };
  });
}
