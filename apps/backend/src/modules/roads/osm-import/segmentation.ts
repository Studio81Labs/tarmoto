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

/**
 * Default ~100 m segment target (§1 of the data reference).
 *
 * NOTE (tracked in #794): `FunZoneClusteringService` defaults
 * `minSegmentLengthM: 500` and `RoadsService.findBest` requires
 * `length_m >= BEST_ROADS_MIN_LENGTH_M`, so once the importer persists ~100 m
 * rows those consumers would filter them all out. Reconciling that (aggregate
 * neighbouring imported segments on read, and/or lower the clustering min) is a
 * separate consumer-side slice — NOT a property of this pure geometry core, and
 * NOT the upsert slice (nothing imports into a live job yet).
 */
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

/**
 * Linear interpolation between two points (fine at ~100 m scale). The
 * longitude delta is wrapped to the shortest arc so a way crossing the
 * antimeridian (e.g. 179.999° → -179.999°) interpolates the short way across
 * ±180° rather than halfway around the globe through 0°.
 */
function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  let dLng = b.lng - a.lng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  let lng = a.lng + dLng * t;
  if (lng > 180) lng -= 360;
  else if (lng < -180) lng += 360;
  return { lat: a.lat + (b.lat - a.lat) * t, lng };
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

/** Two points at the same location (zero-length leg between them). */
function coincident(a: LatLng, b: LatLng): boolean {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) === 0;
}

/** First point in `coords` (scanning from `fromEnd`) not coincident with
 *  `ref` — the neighbouring vertex just outside a segment's boundary, used
 *  ONLY to supply the boundary bearing (never as an interior vertex). */
function distinctNeighbour(
  coords: readonly LatLng[],
  ref: LatLng,
  fromEnd: boolean,
): LatLng | undefined {
  if (fromEnd) {
    for (let i = coords.length - 1; i >= 0; i--) {
      if (!coincident(coords[i], ref)) return coords[i];
    }
  } else {
    for (const p of coords) if (!coincident(p, ref)) return p;
  }
  return undefined;
}

/**
 * Drop consecutive zero-length legs (duplicate OSM nodes, or an exact
 * boundary duplicate from splitting). `bearingDeg` on identical points is
 * undefined (returns 0), which would otherwise inject phantom turns and
 * inflate curviness on an otherwise straight road.
 */
function withoutZeroLengthLegs(coords: readonly LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of coords) {
    const last = out[out.length - 1];
    if (!last || haversineMeters(last.lat, last.lng, p.lat, p.lng) > 0) {
      out.push(p);
    }
  }
  return out;
}

/** Sum of absolute heading changes (degrees) at the interior vertices. */
function totalHeadingChangeDeg(raw: readonly LatLng[]): number {
  const coords = withoutZeroLengthLegs(raw);
  let total = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    total += turnDeg(
      bearingDeg(coords[i - 1], coords[i]),
      bearingDeg(coords[i], coords[i + 1]),
    );
  }
  return total;
}

/**
 * Heading change attributable to a single SEGMENT: the turns at its own
 * interior vertices PLUS the turn at each of its boundary vertices, using the
 * neighbouring point (`before` / `after`) only to supply the incoming/outgoing
 * bearing. A corner sitting exactly on a boundary is counted in both adjacent
 * segments; a bend in the neighbour's interior (a vertex or more past the
 * boundary) is NOT — only this segment's own vertices contribute.
 */
function segmentTurnDeg(
  seg: readonly LatLng[],
  before: LatLng | undefined,
  after: LatLng | undefined,
): number {
  const coords = withoutZeroLengthLegs(seg);
  if (coords.length < 2) return 0;
  let total = totalHeadingChangeDeg(coords); // interior vertices
  const first = coords[0];
  const last = coords[coords.length - 1];
  // Turn at the start boundary vertex (incoming edge from `before`).
  if (before && !coincident(before, first)) {
    total += turnDeg(bearingDeg(before, first), bearingDeg(first, coords[1]));
  }
  // Turn at the end boundary vertex (outgoing edge to `after`).
  if (after && !coincident(after, last)) {
    total += turnDeg(
      bearingDeg(coords[coords.length - 2], last),
      bearingDeg(last, after),
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
 * over its OWN vertices: the turns at its interior vertices plus the turn at
 * each boundary vertex (using one neighbouring point for the incoming/outgoing
 * bearing — see `segmentTurnDeg`), normalised by the segment's own length. So a
 * corner that lands exactly on a split is counted in both adjacent segments
 * (never lost), while a bend in a neighbour's interior does NOT leak into an
 * otherwise straight segment.
 */
export function segmentWay(
  coords: readonly LatLng[],
  targetMeters: number = SEGMENT_TARGET_METERS,
): WaySegment[] {
  const segments = splitIntoSegments(coords, targetMeters);
  return segments.map((seg, i) => {
    const prev = segments[i - 1];
    const next = segments[i + 1];
    // One distinct neighbour on each side supplies the boundary bearing so the
    // turn AT this segment's boundary vertices is counted (a corner exactly on
    // a boundary lands in both adjacent segments). `segmentTurnDeg` only counts
    // this segment's OWN vertices, so a bend in the neighbour's interior never
    // leaks into a straight segment.
    const before = prev ? distinctNeighbour(prev, seg[0], true) : undefined;
    const after = next
      ? distinctNeighbour(next, seg[seg.length - 1], false)
      : undefined;
    const length_m = polylineLengthMeters(seg);
    return {
      coords: seg,
      length_m,
      curviness_score: scoreFromTurn(
        segmentTurnDeg(seg, before, after),
        length_m,
      ),
    };
  });
}
