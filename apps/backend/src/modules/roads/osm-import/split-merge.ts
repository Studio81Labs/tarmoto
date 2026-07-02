import type { LatLng } from './segmentation.js';

/**
 * OSM way split/merge reassignment (#781, ADR-0006).
 *
 * `road_segments` UUIDs — and the crowdsourced quality / reviews / hazards keyed
 * to them — are stable across re-imports via the `(osm_way_id, segment_index)`
 * upsert key (#751). But when OSM splits one way into two (or merges two) between
 * snapshots, that key changes for the affected stretch, so a plain upsert would
 * mint fresh UUIDs for the "new" segments and orphan the old rows — stranding
 * their history.
 *
 * This pure core decides, from geometry alone, which incoming segments should
 * INHERIT an existing row's identity (and thus its history) rather than be
 * inserted fresh, and which existing rows no longer correspond to anything and
 * are stale. It is side-effect-free and PostGIS-free (planar overlap on the
 * short ~100 m spans), so it's unit-testable from synthetic geometries; a later
 * slice loads the candidate existing segments and applies the plan.
 */

/** A carry-over requires MORE than this fraction of one segment to lie on the
 *  other (strict majority), so a short partial overlap of two mostly-different
 *  stretches never inherits identity. */
const DEFAULT_MIN_OVERLAP = 0.5;
/** A sampled point is "on" the other line if within this many metres of it.
 *  Tight, because an OSM re-split reuses the SAME node coordinates, so genuinely
 *  overlapping stretches are near-exact; a looser value would inflate a partial
 *  overlap past the majority cutoff. */
const DEFAULT_TOLERANCE_M = 5;
/** Spacing of the coverage samples taken along a segment. */
const DEFAULT_SAMPLE_M = 20;
/** A match at most this far apart over its overlap (as a fraction of the
 *  tolerance) counts as "exact" — essentially the same geometry — and is preferred
 *  over any looser within-tolerance parallel neighbour, so separated carriageways
 *  keep their own ids. Tight (a fifth of the tolerance ≈ 1 m): above resampling
 *  noise, well below a real lane gap, so a ~2 m parallel is NOT treated as exact. */
const EXACT_SEPARATION_FRACTION = 0.2;
/** Two segments only count as overlapping where they also run in nearly the same
 *  (or opposite) direction. Beyond this heading difference they are crossing, not
 *  sharing road — this rejects an acute crossing whose feet would otherwise advance
 *  smoothly along the other line. */
const HEADING_TOLERANCE_RAD = (20 * Math.PI) / 180;
/** Maximum separation (as a fraction of the tolerance) for a carry-over to be
 *  eligible AT ALL — not just to sort ahead. A genuine re-import or re-split reuses
 *  the same OSM nodes, so a true match is near-exact; a match offset by more than
 *  this is treated as a distinct PARALLEL road and inserted fresh rather than
 *  inheriting a stale id, even when it is the only candidate in the window. Half
 *  the tolerance (~2.5 m): tolerates modest node shifts, rejects a lane-gap
 *  neighbour. */
const MAX_CARRY_SEPARATION_FRACTION = 0.5;

export interface ExistingSegment {
  id: string;
  coords: LatLng[];
}

export interface ReassignmentOptions {
  minOverlap?: number;
  toleranceMeters?: number;
  sampleMeters?: number;
}

export interface ReassignmentPlan {
  /** Incoming segment (by index) inherits the existing row's id + history. */
  carryOver: Array<{
    existingId: string;
    incomingIndex: number;
    score: number;
  }>;
  /** Incoming segments with no existing match — inserted fresh. */
  inserts: number[];
  /** Existing rows no incoming segment matched — no longer in the snapshot. */
  stale: string[];
}

/** Shortest-arc longitude delta in (-180, 180], so an antimeridian-crossing
 *  edge (179.999° → -179.999°) is a short hop, not a ~40,000 km one. */
function wrapLngDelta(d: number): number {
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
}

/** Normalize a longitude back into (-180, 180] after interpolation. */
function normalizeLng(lng: number): number {
  if (lng > 180) return lng - 360;
  if (lng < -180) return lng + 360;
  return lng;
}

/** Equirectangular metres between two points — exact enough at ~100 m spans. */
function planarMeters(a: LatLng, b: LatLng): number {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = wrapLngDelta(b.lng - a.lng) * Math.cos(meanLatRad) * 111_320;
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy);
}

/** Total planar length of a polyline in metres. */
function polylineMeters(coords: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += planarMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

/** Perpendicular distance in metres from `p` to segment `a`–`b`. Longitudes are
 *  projected relative to `a` (shortest arc) so points straddling ±180° stay
 *  local rather than blowing up. */
function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const mx = Math.cos(meanLatRad) * 111_320;
  const project = (q: LatLng) => ({
    x: wrapLngDelta(q.lng - a.lng) * mx,
    y: q.lat * 111_320,
  });
  const P = project(p);
  const A = project(a);
  const B = project(b);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * abx), P.y - (A.y + t * aby));
}

/** Shortest distance in metres from `p` to any leg of `poly`. */
function pointToPolylineMeters(p: LatLng, poly: readonly LatLng[]): number {
  if (poly.length === 1) return planarMeters(p, poly[0]!);
  let min = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = pointToSegmentMeters(p, poly[i - 1]!, poly[i]!);
    if (d < min) min = d;
  }
  return min;
}

/** Distance in metres from `p` to segment `a`–`b`, plus how far along that leg
 *  (0..1) the closest point (the foot of the projection) lies. */
function footOnSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { dist: number; t: number } {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const mx = Math.cos(meanLatRad) * 111_320;
  const project = (q: LatLng) => ({
    x: wrapLngDelta(q.lng - a.lng) * mx,
    y: q.lat * 111_320,
  });
  const P = project(p);
  const A = project(a);
  const B = project(b);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return { dist: Math.hypot(P.x - A.x, P.y - A.y), t: 0 };
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return {
    dist: Math.hypot(P.x - (A.x + t * abx), P.y - (A.y + t * aby)),
    t,
  };
}

/** Geographic bearing of `a`→`b` in radians (0 = due east, CCW). Used to compare
 *  the direction two segments run at a shared point — absolute, so bearings from
 *  different legs/segments are directly comparable. */
function bearing(a: LatLng, b: LatLng): number {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = wrapLngDelta(b.lng - a.lng) * Math.cos(meanLatRad);
  const dy = b.lat - a.lat;
  return Math.atan2(dy, dx);
}

/** Do two bearings run along the same line — same OR opposite direction — within
 *  `tolRad`? Uses |cos(Δ)| so 0° and 180° both count as aligned. */
function bearingsAlign(b1: number, b2: number, tolRad: number): boolean {
  return Math.abs(Math.cos(b1 - b2)) >= Math.cos(tolRad);
}

/** Closest point on `poly` to `p`: its distance in metres, the ARC-LENGTH position
 *  (metres from `poly`'s start) of that foot, and the BEARING of the leg the foot
 *  lies on. The arc position tells whether successive points travel ALONG `poly`
 *  (a real overlap) or fold onto one spot (a touch/crossing); the bearing tells
 *  whether they run in the same direction (a real overlap) or across it at an
 *  angle (an acute crossing). */
function footOnPolyline(
  p: LatLng,
  poly: readonly LatLng[],
): { dist: number; arcPos: number; legBearing: number } {
  let best = { dist: Infinity, arcPos: 0, legBearing: 0 };
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const legLen = planarMeters(a, b);
    const { dist, t } = footOnSegment(p, a, b);
    if (dist < best.dist) {
      best = { dist, arcPos: acc + t * legLen, legBearing: bearing(a, b) };
    }
    acc += legLen;
  }
  return best;
}

/** Points along `coords` spaced FINELY relative to the tolerance (~128 samples,
 *  but no coarser than the tolerance and no finer than 0.5 m) so overlap and
 *  exactness measures don't miss a short match sitting between coarse ticks. */
function denseSamples(coords: readonly LatLng[], tolM: number): LatLng[] {
  const len = polylineMeters(coords);
  if (len === 0) return coords.length >= 1 ? [coords[0]!] : [];
  const step = Math.min(tolM, Math.max(0.5, len / 128));
  return sampleAlong(coords, step);
}

/**
 * Length in metres of the stretch where `a` genuinely runs ALONG `b` — a real,
 * bend-tolerant overlap, as opposed to a mere endpoint touch or a crossing.
 *
 * Sampled proximity alone can't tell these apart once both segments are shorter
 * than the tolerance (every point is then trivially within tolerance of the
 * other), and a straight-chord projection underestimates a genuinely unchanged
 * but BENT segment. So this walks `a`'s arc-length samples and takes the smaller
 * of two quantities:
 *  - how much of `a`'s own length lies within `tolM` of `b`, and
 *  - the span of `b`'s ARC that those feet sweep across CONTIGUOUSLY.
 *
 * "Contiguously" is the crucial part: the swept span sums only steps where the
 * foot advances by about one sample spacing (± tolerance) AND `a` runs in nearly
 * the same direction as `b`. When `a` genuinely runs along `b`, moving one step
 * along `a` moves the foot a comparable step along `b` on a same-heading leg. A
 * perpendicular touch/crossing pins every foot to one spot; an ACUTE crossing
 * glides the foot smoothly but on an off-heading leg; and a chord across a hairpin
 * whose two ends are within tolerance JUMPS the foot from one arc end to the other.
 * All three are excluded, so the swept span (and thus the min) collapses to ~0.
 *
 * `a` is sampled FINELY (independent of the coarse coverage spacing) so that
 * quantization stays well under the tolerance: the boundary intervals of a real
 * overlap are captured, and a short `b` between coarse ticks is not missed. The
 * measure is one-directional (it samples `a`); callers max it with the reverse
 * direction so a short segment contained in a long one is measured from its own
 * dense samples.
 */
function realOverlapMeters(
  a: readonly LatLng[],
  b: readonly LatLng[],
  tolM: number,
): number {
  if (a.length < 2 || b.length < 2) return 0;
  const aLen = polylineMeters(a);
  if (aLen === 0) return 0;
  const samples = denseSamples(a, tolM);
  if (samples.length < 2) return 0;
  const stepArcA = aLen / (samples.length - 1);
  // A foot step longer than one sample spacing plus tolerance is a jump between
  // disconnected places on `b`, not travel along it — don't count it as overlap.
  const maxContiguousStep = stepArcA + tolM;
  let matched = 0;
  let swept = 0;
  // The immediately preceding matched sample: its foot arc position and its point,
  // so the next step's own heading can be compared to `b`'s heading there.
  let prev: { arcPos: number; point: LatLng } | null = null;
  for (const p of samples) {
    const foot = footOnPolyline(p, b);
    if (foot.dist <= tolM) {
      matched++;
      if (prev !== null) {
        const gap = Math.abs(foot.arcPos - prev.arcPos);
        // Count the step only if it advances contiguously AND `a` runs in nearly
        // the same direction as `b` here — so an acute crossing, whose foot glides
        // smoothly along `b` but at an angle, contributes no swept length.
        const contiguous = gap <= maxContiguousStep;
        const aligned = bearingsAlign(
          bearing(prev.point, p),
          foot.legBearing,
          HEADING_TOLERANCE_RAD,
        );
        if (contiguous && aligned) swept += gap;
      }
      prev = { arcPos: foot.arcPos, point: p };
    } else {
      prev = null; // a gap in coverage breaks contiguity
    }
  }
  // Each matched sample stands for one step of `a`'s length, which includes the
  // partial boundary intervals at each end of the matched run.
  const coveredArcA = matched * stepArcA;
  return Math.min(coveredArcA, swept);
}

/** How far apart two polylines run where they best correspond — the SMALLER of the
 *  two directed mean point-to-line distances (each over the samples within `tolM`
 *  of the other line). ~0 for (near-)identical geometry — including a short segment
 *  lying exactly on part of a long one, whose own samples all sit on it — and ~the
 *  gap for a parallel neighbour, whose samples are offset in both directions. The
 *  MIN (not max) avoids the long→short direction being inflated by samples that
 *  fall just past the short segment's ends but still within tolerance. Uses DENSE
 *  samples so a short exact overlap between coarse ticks is still seen. Used to
 *  prefer the exact match; returns Infinity when nothing overlaps. */
function separationMeters(
  a: readonly LatLng[],
  b: readonly LatLng[],
  tolM: number,
): number {
  const directedMean = (
    from: readonly LatLng[],
    to: readonly LatLng[],
  ): number => {
    let sum = 0;
    let count = 0;
    for (const p of denseSamples(from, tolM)) {
      const d = pointToPolylineMeters(p, to);
      if (d <= tolM) {
        sum += d;
        count++;
      }
    }
    return count === 0 ? Infinity : sum / count;
  };
  return Math.min(directedMean(a, b), directedMean(b, a));
}

/** The point at arc-length `atM` along `coords` (clamped to the ends). */
function pointAtLength(coords: readonly LatLng[], atM: number): LatLng {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const legLen = planarMeters(a, b);
    if (legLen === 0) continue;
    if (acc + legLen >= atM) {
      const t = (atM - acc) / legLen;
      const dLng = wrapLngDelta(b.lng - a.lng);
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: normalizeLng(a.lng + dLng * t),
      };
    }
    acc += legLen;
  }
  return coords[coords.length - 1]!;
}

/**
 * Sample points EVENLY by arc-length along `coords` (endpoints included), one
 * per ~`sampleM` of length. Even spacing (vs. per-leg stepping) means the
 * fraction of samples that lie on another line approximates the fraction of
 * *length* that overlaps — no double-counting near a leg boundary.
 */
function sampleAlong(coords: readonly LatLng[], sampleM: number): LatLng[] {
  if (coords.length < 2) return coords.length === 1 ? [coords[0]!] : [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += planarMeters(coords[i - 1]!, coords[i]!);
  }
  if (total === 0) return [coords[0]!];
  // At least 4 intervals (5 samples) so a short segment isn't judged on 2–3
  // coarse points where a single endpoint dominates the fraction.
  const steps = Math.max(4, Math.ceil(total / sampleM));
  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push(pointAtLength(coords, (total * i) / steps));
  }
  return out;
}

/** Fraction of `a`'s sampled points that lie within `tolM` of polyline `b`. */
function overlapFraction(
  a: readonly LatLng[],
  b: readonly LatLng[],
  tolM: number,
  sampleM: number,
): number {
  if (a.length < 2 || b.length < 2) return 0;
  const samples = sampleAlong(a, sampleM);
  if (samples.length === 0) return 0;
  let on = 0;
  for (const p of samples) {
    if (pointToPolylineMeters(p, b) <= tolM) on++;
  }
  return on / samples.length;
}

/**
 * Match incoming segments to existing rows by geometry overlap. Greedy by score:
 * each existing row is inherited by at most one incoming segment (the one that
 * best lies on it), so a 1→2 split carries history to the better-covered half
 * and the other half is a fresh insert, and a 2→1 merge inherits one old row's
 * history while the other goes stale. `incoming` segments are identified by their
 * index in the array.
 */
export function planReassignment(
  existing: readonly ExistingSegment[],
  incoming: readonly LatLng[][],
  opts: ReassignmentOptions = {},
): ReassignmentPlan {
  const minOverlap = opts.minOverlap ?? DEFAULT_MIN_OVERLAP;
  const tolM = opts.toleranceMeters ?? DEFAULT_TOLERANCE_M;
  const sampleM = opts.sampleMeters ?? DEFAULT_SAMPLE_M;

  // Guard the tuning knobs: a non-positive tolerance or sample spacing makes the
  // sampler's step 0 and its ceil(length / step) Infinity, which would push
  // samples forever. Fail fast with a clear message instead.
  if (!Number.isFinite(tolM) || tolM <= 0) {
    throw new Error(
      `toleranceMeters must be a positive finite number, got ${tolM}`,
    );
  }
  if (!Number.isFinite(sampleM) || sampleM <= 0) {
    throw new Error(
      `sampleMeters must be a positive finite number, got ${sampleM}`,
    );
  }
  if (!Number.isFinite(minOverlap) || minOverlap <= 0 || minOverlap >= 1) {
    throw new Error(
      `minOverlap must be a fraction in (0, 1), got ${minOverlap}`,
    );
  }

  const pairs: Array<{
    existingIdx: number;
    incomingIndex: number;
    score: number;
    overlap: number;
    separation: number;
  }> = [];
  for (let e = 0; e < existing.length; e++) {
    for (let n = 0; n < incoming.length; n++) {
      // The real, bend-tolerant shared length (follows the arc; collapses to ~0
      // for a touch, crossing, or abutting stub — see `realOverlapMeters`). This is
      // the SOLE overlap signal: it does not inflate for two segments that merely
      // lie within tolerance of each other, so it needs no separate endpoint-touch
      // length floor or near-1:1 bypass. Measured in BOTH directions and maxed, so
      // a short segment contained in a long one is captured from its own dense
      // samples rather than missed between the long side's ticks.
      const overlap = Math.max(
        realOverlapMeters(incoming[n]!, existing[e]!.coords, tolM),
        realOverlapMeters(existing[e]!.coords, incoming[n]!, tolM),
      );
      // A carry-over requires the real overlap to be a STRICT MAJORITY of the
      // SHORTER segment. Using the shorter length as the denominator lets a
      // genuinely contained split/merge piece qualify at ANY length (an 8 m child
      // of a 15 m parent overlaps ~100% of itself), while a mostly-different or
      // extended stretch — overlapping only a minority of the shorter side — is
      // inserted fresh rather than inheriting another road's reviews. Touches and
      // crossings have ~0 real overlap and never qualify.
      const shorterLen = Math.min(
        polylineMeters(incoming[n]!),
        polylineMeters(existing[e]!.coords),
      );
      if (shorterLen === 0 || overlap <= minOverlap * shorterLen) continue;
      // Exactness — how far the two run apart where they best correspond. A carry-
      // over must be near-exact (a genuine re-import/re-split reuses the same
      // nodes): a more-offset match is a distinct PARALLEL road and is inserted
      // fresh rather than inheriting a stale id, EVEN IF it is the only candidate
      // — the exactness ordering below is only a tie-break, so this gate is what
      // stops a lone parallel neighbour from silently absorbing another road's id.
      const separation = separationMeters(
        incoming[n]!,
        existing[e]!.coords,
        tolM,
      );
      if (separation > tolM * MAX_CARRY_SEPARATION_FRACTION) continue;
      // Confidence for the carried row: how completely the two cover each other.
      const score = Math.max(
        overlapFraction(incoming[n]!, existing[e]!.coords, tolM, sampleM),
        overlapFraction(existing[e]!.coords, incoming[n]!, tolM, sampleM),
      );
      pairs.push({
        existingIdx: e,
        incomingIndex: n,
        score,
        overlap,
        separation,
      });
    }
  }
  // Greedy order: EXACT same-geometry matches first — separation within a TIGHT
  // fraction of the tolerance, so a looser within-tolerance parallel neighbour
  // (even a longer one) can never outrank a true match and separated carriageways
  // keep their own ids. Then the longest real overlap (so the longer child of a
  // split inherits), then the more exact match, then index order as the final
  // deterministic tie-break so the plan is stable across runs on unchanged data.
  const exactSep = tolM * EXACT_SEPARATION_FRACTION;
  const tier = (p: { separation: number }): number =>
    p.separation <= exactSep ? 0 : 1;
  pairs.sort(
    (x, y) =>
      tier(x) - tier(y) ||
      y.overlap - x.overlap ||
      x.separation - y.separation ||
      x.existingIdx - y.existingIdx ||
      x.incomingIndex - y.incomingIndex,
  );

  const usedExisting = new Set<number>();
  const usedIncoming = new Set<number>();
  const carryOver: ReassignmentPlan['carryOver'] = [];
  for (const p of pairs) {
    if (usedExisting.has(p.existingIdx) || usedIncoming.has(p.incomingIndex)) {
      continue;
    }
    usedExisting.add(p.existingIdx);
    usedIncoming.add(p.incomingIndex);
    carryOver.push({
      existingId: existing[p.existingIdx]!.id,
      incomingIndex: p.incomingIndex,
      score: p.score,
    });
  }

  const inserts: number[] = [];
  for (let n = 0; n < incoming.length; n++) {
    if (!usedIncoming.has(n)) inserts.push(n);
  }
  const stale: string[] = [];
  for (let e = 0; e < existing.length; e++) {
    if (!usedExisting.has(e)) stale.push(existing[e]!.id);
  }
  return { carryOver, inserts, stale };
}
