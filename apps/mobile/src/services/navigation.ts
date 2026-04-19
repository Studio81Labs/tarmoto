/**
 * Turn-by-turn navigation helpers — US-16.
 *
 * Splits into two layers:
 *
 *   1. Pure geometry helpers — maneuver extraction from a polyline, point
 *      projection, distance math. Testable without React/native bindings.
 *
 *   2. `NavSession` — stateful per-tick consumer. Given the rider's live
 *      location it reports the upcoming maneuver, remaining distance, and
 *      which announcement (if any) should fire this tick. The screen layer
 *      renders from that state and forwards announcements to TTS.
 *
 * The polylines we navigate come from the trip planner (`TripDay`) — they
 * don't ship with maneuver metadata, so we infer turns from the polyline's
 * own heading changes. That's lossier than a proper routing engine but
 * keeps mobile-only navigation unblocked until a backend `/route/calculate`
 * endpoint lands.
 */
import type { LatLng } from "@/types";

// ── Maneuvers ─────────────────────────────────────────────────────────────

export type ManeuverType =
  | "depart"
  | "arrive"
  | "continue"
  | "turn-slight-left"
  | "turn-slight-right"
  | "turn-left"
  | "turn-right"
  | "turn-sharp-left"
  | "turn-sharp-right"
  | "uturn";

export interface Maneuver {
  type: ManeuverType;
  /** Vertex index in the source polyline. */
  vertexIndex: number;
  /** Cumulative distance along the polyline, in meters. */
  distanceFromStartM: number;
  /** Signed heading change at the vertex in degrees (+ right, - left). */
  headingChangeDeg: number;
  /** Optional road name ahead — sourced from the nearest waypoint. */
  roadName?: string;
}

// Heading-change thresholds (degrees). Tuned to the planner's polyline
// sampling: it simplifies to ~25m spacing so tiny zigzags below 25° almost
// always come from snapping noise, not real turns.
const THRESHOLD_SLIGHT = 25;
const THRESHOLD_TURN = 45;
const THRESHOLD_SHARP = 110;
const THRESHOLD_UTURN = 150;
// Turns within this distance of each other collapse into one — simplified
// polylines sometimes split a single real turn across two close vertices.
const TURN_DEDUPE_M = 25;

// ── Announcements ─────────────────────────────────────────────────────────

/**
 * Fired once when the rider crosses a distance-to-maneuver threshold. The
 * screen converts these into TTS prompts / visual highlights.
 */
export type NavAnnouncementType =
  | "depart"
  | "warning-far" // ~300 m out — motorcycle-appropriate early heads-up
  | "warning-near" // ~50 m out — commit to the turn
  | "execute" // at the maneuver — "turn now"
  | "off-route"
  | "on-route" // recovered from off-route
  | "arrived";

export interface NavAnnouncement {
  type: NavAnnouncementType;
  maneuver?: Maneuver;
  distanceM?: number;
  /**
   * Name of the road the rider is currently on, if known. Used by the
   * phrase builder to suppress "onto {roadName}" when the upcoming
   * maneuver stays on the same road — announcing "Turn left onto Main St"
   * while already on Main St is noise.
   */
  currentRoadName?: string;
}

export interface NavTick {
  /** The maneuver the rider is approaching next, or null if arrived. */
  nextManeuver: Maneuver | null;
  /** Meters from current position to `nextManeuver`. */
  distanceToNextM: number;
  /** Meters travelled along the planned polyline so far. */
  progressM: number;
  /** Meters of polyline still ahead. */
  remainingM: number;
  /** Perpendicular distance from the polyline, in meters. */
  offRouteDistanceM: number;
  /** True when `offRouteDistanceM` exceeds the off-route threshold. */
  offRoute: boolean;
  /** Announcements produced by THIS tick (fired at most once per maneuver). */
  announcements: NavAnnouncement[];
}

// Motorcycle-appropriate timing thresholds in meters. At 80 km/h (~22 m/s)
// 300 m is ~13 s of notice — enough to switch lanes / slow; 50 m is ~2 s,
// the commit point. We use distance rather than time so the behaviour is
// predictable while the rider is decelerating.
export const WARNING_FAR_M = 300;
export const WARNING_NEAR_M = 50;
export const EXECUTE_M = 12;
export const OFF_ROUTE_M = 50;
export const ARRIVED_M = 20;

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Haversine distance in meters. Inlined rather than imported: the mobile
 * app doesn't pull in `@tarmoto/shared` at RN build time (same precedent
 * as `haversineKm` in `TripScreens.helpers.ts`), and re-using the private
 * method on `locationService` would drag the whole Geolocation native
 * dep into jest / web preview builds of this module.
 */
export function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Great-circle initial bearing from a→b, in degrees [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed heading delta wrapped into (-180, 180]. + means a right turn. */
export function headingDelta(from: number, to: number): number {
  let d = ((to - from + 540) % 360) - 180;
  // The (-180, 180] convention treats an exact 180° rotation as "right",
  // which matches how we want to flag U-turns (sharp-right bias).
  if (d === -180) d = 180;
  return d;
}

function classifyHeadingChange(deg: number): ManeuverType | null {
  const mag = Math.abs(deg);
  if (mag < THRESHOLD_SLIGHT) return null;
  const isRight = deg > 0;
  if (mag >= THRESHOLD_UTURN) return "uturn";
  if (mag >= THRESHOLD_SHARP) {
    return isRight ? "turn-sharp-right" : "turn-sharp-left";
  }
  if (mag >= THRESHOLD_TURN) return isRight ? "turn-right" : "turn-left";
  return isRight ? "turn-slight-right" : "turn-slight-left";
}

/**
 * Cumulative haversine distances along a polyline, in meters.
 * `result[i]` is the distance from `polyline[0]` to `polyline[i]`; for an
 * empty polyline the result is `[]`. Exported so `NavSession` can cache
 * its route's distances once at construction instead of recomputing on
 * every GPS tick.
 */
export function buildCumulativeDistances(polyline: LatLng[]): number[] {
  if (polyline.length === 0) return [];
  const cumulative: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        haversineM(
          polyline[i - 1].lat,
          polyline[i - 1].lng,
          polyline[i].lat,
          polyline[i].lng,
        ),
    );
  }
  return cumulative;
}

/**
 * Extract maneuvers from a polyline. Returns a list always bracketed by
 * `depart` at index 0 and `arrive` at the last vertex, with inferred turns
 * in between. `roadNames` (if supplied, same length as the polyline) is
 * used to attach the name of the road ahead to each turn.
 *
 * `cumulativeDistances` is optional — hot callers (NavSession init) pass
 * the array they've already computed so we don't run haversines twice
 * against the same polyline.
 */
export function extractManeuvers(
  polyline: LatLng[],
  roadNames?: Array<string | undefined>,
  cumulativeDistances?: number[],
): Maneuver[] {
  if (polyline.length === 0) return [];
  const cumulative = cumulativeDistances ?? buildCumulativeDistances(polyline);

  const maneuvers: Maneuver[] = [];

  maneuvers.push({
    type: "depart",
    vertexIndex: 0,
    distanceFromStartM: 0,
    headingChangeDeg: 0,
    roadName: roadNames?.[0],
  });

  if (polyline.length >= 3) {
    for (let i = 1; i < polyline.length - 1; i++) {
      const prev = polyline[i - 1];
      const here = polyline[i];
      const next = polyline[i + 1];
      const inBearing = bearingDeg(prev, here);
      const outBearing = bearingDeg(here, next);
      const delta = headingDelta(inBearing, outBearing);
      const type = classifyHeadingChange(delta);
      if (!type) continue;

      const candidate: Maneuver = {
        type,
        vertexIndex: i,
        distanceFromStartM: cumulative[i],
        headingChangeDeg: delta,
        roadName: roadNames?.[i + 1] ?? roadNames?.[i],
      };

      // Collapse turns that snap together — pick the larger heading change
      // so the rendered icon matches the real maneuver rather than a
      // slight-left that immediately chains into a hard-left.
      const prevManeuver = maneuvers[maneuvers.length - 1];
      if (
        prevManeuver.type !== "depart" &&
        candidate.distanceFromStartM - prevManeuver.distanceFromStartM <
          TURN_DEDUPE_M
      ) {
        if (
          Math.abs(candidate.headingChangeDeg) >
          Math.abs(prevManeuver.headingChangeDeg)
        ) {
          maneuvers[maneuvers.length - 1] = candidate;
        }
        continue;
      }
      maneuvers.push(candidate);
    }
  }

  const lastIndex = polyline.length - 1;
  maneuvers.push({
    type: "arrive",
    vertexIndex: lastIndex,
    distanceFromStartM: cumulative[lastIndex],
    headingChangeDeg: 0,
    roadName: roadNames?.[lastIndex],
  });

  return maneuvers;
}

// ── Projection onto polyline ──────────────────────────────────────────────

export interface Projection {
  /** Index of the starting vertex of the closest segment. */
  segmentIndex: number;
  /** Closest point on that segment. */
  point: LatLng;
  /** Perpendicular distance from input to `point`, meters. */
  distanceM: number;
  /** Cumulative meters from polyline start to `point`. */
  progressM: number;
}

/**
 * Project a point onto a polyline via a local equirectangular approximation.
 * Exact haversine isn't worth it for the scales we navigate (tens of meters
 * per segment); the equirectangular projection loses <0.5% across any real
 * trip day. We also track cumulative distance as haversine meters so
 * progress stays consistent with maneuver offsets produced by
 * `extractManeuvers`.
 */
export function projectOnPolyline(
  polyline: LatLng[],
  point: LatLng,
  // Optional precomputed cumulative distances; callers on a hot path
  // (NavSession.update) pass the cached array so we don't rebuild O(n)
  // haversines on every GPS tick. When omitted we fall back to computing
  // them here so one-off callers (tests, UI helpers) stay ergonomic.
  cumulativeDistances?: number[],
): Projection | null {
  if (polyline.length === 0) return null;
  if (polyline.length === 1) {
    return {
      segmentIndex: 0,
      point: polyline[0],
      distanceM: haversineM(
        polyline[0].lat,
        polyline[0].lng,
        point.lat,
        point.lng,
      ),
      progressM: 0,
    };
  }

  const cumulative = cumulativeDistances ?? buildCumulativeDistances(polyline);

  let best: Projection | null = null;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const { point: closest, t } = closestOnSegment(a, b, point);
    const dist = haversineM(closest.lat, closest.lng, point.lat, point.lng);
    if (best === null || dist < best.distanceM) {
      const segmentLen = cumulative[i + 1] - cumulative[i];
      const progressM = cumulative[i] + t * segmentLen;
      best = { segmentIndex: i, point: closest, distanceM: dist, progressM };
    }
  }
  return best;
}

function closestOnSegment(
  a: LatLng,
  b: LatLng,
  p: LatLng,
): { point: LatLng; t: number } {
  // Equirectangular projection anchored at `a`, scaling longitude by the
  // cosine of the shared latitude so the tangent plane is roughly isotropic
  // across the segment.
  const latRef = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const rawScale = Math.cos(latRef);
  // Floor the scale away from zero so a segment sitting exactly on a pole
  // can't divide by zero when we unwind `cx / scale` below. The lower bound
  // is deliberately tiny — real rider polylines never sit near the poles,
  // but the guard keeps the projection total rather than letting NaN/Infinity
  // leak into `distanceM` and blow up the off-route check.
  const scale =
    Math.abs(rawScale) < 1e-12 ? (rawScale < 0 ? -1e-12 : 1e-12) : rawScale;
  const ax = a.lng * scale;
  const ay = a.lat;
  const bx = b.lng * scale;
  const by = b.lat;
  const px = p.lng * scale;
  const py = p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: a, t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { point: { lat: cy, lng: cx / scale }, t };
}

// ── Nav session ───────────────────────────────────────────────────────────

interface ManeuverThresholdState {
  farFired: boolean;
  nearFired: boolean;
  executeFired: boolean;
}

/**
 * Per-ride navigation state machine. Create one per NavigationScreen
 * mount, feed `update()` with location ticks, render from the returned
 * `NavTick`, and pipe `announcements` to TTS.
 */
export class NavSession {
  private readonly route: LatLng[];
  private readonly routeCumulative: number[];
  private readonly maneuvers: Maneuver[];
  private readonly totalM: number;
  private readonly thresholds: ManeuverThresholdState[];
  private arrivedFired = false;
  private departFired = false;
  private wasOffRoute = false;

  constructor(
    route: LatLng[],
    maneuvers: Maneuver[],
    cumulativeDistances?: number[],
  ) {
    this.route = route;
    // Compute the route's cumulative distances once and reuse on every tick.
    // `projectOnPolyline` would otherwise rebuild them per-call and rerun
    // O(n) haversines per GPS fix — a noticeable cost on dense polylines.
    // Callers that already computed the array (e.g. to feed into
    // `extractManeuvers`) pass it through so we don't repeat the work.
    this.routeCumulative =
      cumulativeDistances ?? buildCumulativeDistances(route);
    this.maneuvers = maneuvers;
    this.totalM =
      maneuvers.length > 0
        ? maneuvers[maneuvers.length - 1].distanceFromStartM
        : 0;
    this.thresholds = maneuvers.map(() => ({
      farFired: false,
      nearFired: false,
      executeFired: false,
    }));
  }

  update(location: LatLng): NavTick {
    const projection = projectOnPolyline(
      this.route,
      location,
      this.routeCumulative,
    );
    if (!projection) {
      return {
        nextManeuver: null,
        distanceToNextM: 0,
        progressM: 0,
        remainingM: 0,
        offRouteDistanceM: 0,
        offRoute: false,
        announcements: [],
      };
    }
    const announcements: NavAnnouncement[] = [];
    const offRoute = projection.distanceM > OFF_ROUTE_M;

    // Off-route transitions — fire both the leading and trailing edge so
    // the UI/TTS can toggle the "off route" banner without the screen
    // polling for the state. We gate announcements on actual transitions
    // so we don't spam every tick while the rider is off-route.
    if (offRoute && !this.wasOffRoute) {
      announcements.push({
        type: "off-route",
        distanceM: projection.distanceM,
      });
    } else if (!offRoute && this.wasOffRoute) {
      announcements.push({ type: "on-route" });
    }
    this.wasOffRoute = offRoute;

    // While off-route we still report the geometric next maneuver so the
    // UI keeps its header populated, but we don't progress the threshold
    // state (we'd rather re-fire "in 300 m, turn left" once the rider is
    // back on the route than silently swallow it).
    const { nextManeuver, nextIndex } = this.findNext(projection.progressM);
    const distanceToNextM =
      nextManeuver === null
        ? 0
        : Math.max(0, nextManeuver.distanceFromStartM - projection.progressM);

    // Road the rider is currently on — whichever most-recently-passed
    // maneuver carries a name. Threaded onto each announcement so the
    // phrase builder can suppress "onto {road}" when the upcoming turn
    // stays on the same road (common at minor intersections where the
    // heading change trips our threshold but the street name doesn't
    // change).
    const currentRoadName = this.getCurrentRoadName(projection.progressM);

    if (!offRoute) {
      if (!this.departFired) {
        announcements.push({
          type: "depart",
          maneuver: this.maneuvers[0],
          currentRoadName,
        });
        this.departFired = true;
      }

      if (nextManeuver && nextIndex !== null) {
        const state = this.thresholds[nextIndex];
        if (nextManeuver.type !== "depart" && nextManeuver.type !== "arrive") {
          // Fire at most ONE threshold per tick, picking the most urgent
          // one the rider has crossed. A cold-start fix can land inside
          // `WARNING_NEAR_M` — or even `EXECUTE_M` — with none of the
          // thresholds fired yet; stacked `if`s would emit all three
          // announcements back-to-back ("In 0 meters, turn left" …
          // "Turn left now"), which is exactly the kind of noise voice
          // nav is meant to avoid.
          //
          // Cascade-mark the farther thresholds as fired so they stay
          // suppressed on later ticks (the rider has already moved past
          // the "early warning" window, we don't want to rewind and
          // announce "in 300 meters" after we've been speaking at 45m).
          if (!state.executeFired && distanceToNextM <= EXECUTE_M) {
            state.executeFired = true;
            state.nearFired = true;
            state.farFired = true;
            announcements.push({
              type: "execute",
              maneuver: nextManeuver,
              distanceM: distanceToNextM,
              currentRoadName,
            });
          } else if (!state.nearFired && distanceToNextM <= WARNING_NEAR_M) {
            state.nearFired = true;
            state.farFired = true;
            announcements.push({
              type: "warning-near",
              maneuver: nextManeuver,
              distanceM: distanceToNextM,
              currentRoadName,
            });
          } else if (!state.farFired && distanceToNextM <= WARNING_FAR_M) {
            state.farFired = true;
            announcements.push({
              type: "warning-far",
              maneuver: nextManeuver,
              distanceM: distanceToNextM,
              currentRoadName,
            });
          }
        }
      }

      if (
        !this.arrivedFired &&
        this.totalM - projection.progressM <= ARRIVED_M
      ) {
        this.arrivedFired = true;
        announcements.push({ type: "arrived", currentRoadName });
      }
    }

    return {
      nextManeuver,
      distanceToNextM,
      progressM: projection.progressM,
      remainingM: Math.max(0, this.totalM - projection.progressM),
      offRouteDistanceM: projection.distanceM,
      offRoute,
      announcements,
    };
  }

  private findNext(progressM: number): {
    nextManeuver: Maneuver | null;
    nextIndex: number | null;
  } {
    // Smallest maneuver whose offset is still ahead of us (with a tiny
    // lookback so a maneuver we just executed doesn't flicker back in on
    // the next GPS settle). Skips `depart` since the rider's already
    // departed — we jump straight to the first real turn (or `arrive`
    // if the route is a single leg).
    for (let i = 0; i < this.maneuvers.length; i++) {
      const m = this.maneuvers[i];
      if (m.type === "depart") continue;
      if (m.distanceFromStartM > progressM - 5) {
        return { nextManeuver: m, nextIndex: i };
      }
    }
    return { nextManeuver: null, nextIndex: null };
  }

  /**
   * Name of the road the rider is currently on, inferred from the most
   * recently passed maneuver that carries a `roadName`. Maneuvers mark
   * the road AHEAD of them, so once the rider has rolled past a turn
   * onto "Main St", every subsequent fix is "on Main St" until the next
   * named turn.
   */
  private getCurrentRoadName(progressM: number): string | undefined {
    let currentName: string | undefined;
    for (const m of this.maneuvers) {
      if (m.distanceFromStartM > progressM) break;
      if (m.roadName !== undefined) currentName = m.roadName;
    }
    return currentName;
  }
}

// ── Phrase building for TTS ───────────────────────────────────────────────

const MANEUVER_PHRASE: Record<ManeuverType, string> = {
  depart: "Starting navigation",
  arrive: "You have arrived",
  continue: "Continue",
  "turn-slight-left": "Bear left",
  "turn-slight-right": "Bear right",
  "turn-left": "Turn left",
  "turn-right": "Turn right",
  "turn-sharp-left": "Sharp left",
  "turn-sharp-right": "Sharp right",
  uturn: "Make a U-turn",
};

function maneuverPhrase(m: Maneuver): string {
  return MANEUVER_PHRASE[m.type] ?? "Continue";
}

/**
 * Build the spoken phrase for a given announcement. Road name is appended
 * when available ("Turn left onto Hlavní") — we skip it when the maneuver's
 * roadName matches the rider's current road (case/whitespace insensitive)
 * to avoid "onto Hlavní" when the turn stays on the same street.
 */
export function phraseForAnnouncement(a: NavAnnouncement): string | null {
  switch (a.type) {
    case "depart":
      return "Starting navigation.";
    case "arrived":
      return "You have arrived.";
    case "off-route":
      return "You are off route.";
    case "on-route":
      return "Back on route.";
    case "warning-far": {
      if (!a.maneuver) return null;
      const base = maneuverPhrase(a.maneuver);
      const dist = Math.round((a.distanceM ?? 0) / 50) * 50;
      const onto = ontoPhrase(a.maneuver.roadName, a.currentRoadName);
      return `In ${dist} meters, ${base.toLowerCase()}${onto}.`;
    }
    case "warning-near": {
      if (!a.maneuver) return null;
      const base = maneuverPhrase(a.maneuver);
      const onto = ontoPhrase(a.maneuver.roadName, a.currentRoadName);
      return `${base} now${onto}.`;
    }
    case "execute":
      // The near-warning already covered the imperative; executing at zero
      // distance would otherwise yank the rider's attention mid-turn.
      return null;
    default:
      return null;
  }
}

function ontoPhrase(
  target: string | undefined,
  current: string | undefined,
): string {
  if (!target) return "";
  if (current && target.trim().toLowerCase() === current.trim().toLowerCase()) {
    return "";
  }
  return ` onto ${target}`;
}
