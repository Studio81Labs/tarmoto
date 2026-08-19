import { create } from "zustand";

/** Maximum number of days in a multi-day trip (companion mirror of the backend cap). */
export const MAX_TRIP_DAYS = 14;
import type { Position as GeoJSONPosition } from "geojson";
import { haversineKm } from "@tarmoto/shared";
import { filterRoutingWaypoints, isRoutingWaypoint } from "@/lib/trip-routing";
import { isLegacyGeneratedWaypointName } from "@/lib/planner/labels";
import type { RouteResponse } from "@/lib/api";
import type {
  DayPlan,
  PlanningMode,
  PoiCategory,
  RouteSegment,
  SplitStatus,
} from "@/lib/planner/types";
import type { PlacementActionId } from "@/lib/planner-context-menu";
import type {
  RoutePreviewSegment,
  Trip,
  TripDay,
  TripParameters,
  TripSummary,
  Waypoint,
} from "@/lib/types";

// ── Draft-trip structural helpers ─────────────────────────────────────────────
// Manage the shape and ordering of waypoints / days but produce NO synthetic
// route geometry — geometry comes exclusively from applyRouteResult.

const DEFAULT_PLANNER_PARAMETERS: TripParameters = {
  days: 1,
  dailyKmTarget: 250,
  roadPreference: "mixed",
  surfacePreference: ["asphalt"],
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
  minQuality: 3,
};

function createEmptyPlannerDay(dayNumber: number): TripDay {
  return {
    dayNumber,
    waypoints: [],
    distanceKm: 0,
    durationMinutes: 0,
    elevationGain: 0,
    avgQuality: 0,
    segments: [],
  };
}

function createPlannerDraftTrip(
  nowIso: string,
  parameters: TripParameters = DEFAULT_PLANNER_PARAMETERS,
): Trip {
  return {
    id: `planner-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`,
    // Empty is the semantic "not named yet" state. Presentation and save
    // boundaries resolve it through the active locale catalog.
    name: "",
    status: "draft",
    num_days: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    parameters: { ...parameters },
    collaborators: [{ userId: "u-owner", displayName: "", role: "owner" }],
    days: [createEmptyPlannerDay(1)],
  };
}

function ensurePlannerDays(days: TripDay[], requiredCount: number): TripDay[] {
  if (days.length >= requiredCount) return [...days];
  const next = [...days];
  for (let index = days.length; index < requiredCount; index++) {
    next.push(createEmptyPlannerDay(index + 1));
  }
  return next;
}

function appendPlannerWaypointToDay(
  day: TripDay,
  location: { lng: number; lat: number },
): TripDay {
  const waypoints = [...day.waypoints];
  const id = `planner-${day.dayNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // Insertion target relative to the day's finish (explicit end OR a terminal
  // accommodation). `length` means "no finish yet" → this click sets it.
  const insertAt = viaInsertIndex(waypoints);

  if (waypoints.length === 0) {
    waypoints.push({ id, location, type: "start" });
  } else if (insertAt === waypoints.length) {
    waypoints.push({ id, location, type: "end" });
  } else {
    waypoints.splice(insertAt, 0, {
      id,
      location,
      type: "via",
    });
  }

  return { ...day, waypoints };
}

// ─────────────────────────────────────────────────────────────────────────────

interface TripState {
  /**
   * Trip rows from the list endpoint. Typed as `TripSummary[]`
   * (no `days` / `parameters` / `collaborators`) — list consumers
   * must not reach for detail-only fields, and the compiler now
   * enforces it.
   */
  trips: TripSummary[];
  /**
   * The signed-in user-id whose trips currently live in the store.
   * Consumers (e.g. `useUserTrips`) read this and gate their
   * returned list on a match against the active session id, so an
   * A→B account switch doesn't briefly serve user A's trips
   * during user B's first render — the gate runs synchronously
   * during render, ahead of the post-commit `setTrips` clear.
   */
  tripsOwnerId: string | null;
  activeTrip: Trip | null;
  isGenerating: boolean;
  canUndo: boolean;
  canRedo: boolean;

  /**
   * True once the rider has edited the route since the trip was
   * loaded. Used by the planner page to gate live routing: Valhalla
   * is only called when the rider has made a change, OR when the
   * active day has no persisted geometry yet (a fresh draft).
   * Reset to false by setActiveTrip (load / replace / clear).
   * Set to true by any action that mutates the routing inputs.
   */
  routeDirty: boolean;

  /**
   * Set to true when a waypoint is renamed — a metadata-only edit that leaves
   * geometry untouched. Tracked separately from `routeDirty` so a late/auto
   * reverse-geocoded pin name arms Save via the name-only persist path
   * (PATCH /trips/:id/waypoints), never a re-route (#911). Cleared on save/load.
   */
  namesDirty: boolean;

  /**
   * Ids of the waypoints renamed since the last save/load — the exact set the
   * name-only PATCH sends. Sending *only* these (not every persisted waypoint)
   * keeps a collaborator's concurrent rename of a different stop from being
   * clobbered by this client re-submitting its stale name (#911). Mirrors
   * `namesDirty` (armed ⟺ non-empty), as `stalePreviewDays` mirrors `routeDirty`.
   */
  renamedWaypointIds: string[];

  /**
   * Waypoint names as of the last load / save-hydration — the server baseline
   * `renameWaypoint` diffs against. Renaming a waypoint back to its baseline
   * drops it from `renamedWaypointIds` (a NET-zero edit), so the name-only save
   * never PATCHes it and can't revert a collaborator's newer rename of that
   * same stop. Reset on every load/save; not snapshotted for undo/redo — it's
   * the server truth, and the trip + dirty set are restored together anyway.
   */
  savedWaypointNames: Record<string, string | null>;

  /**
   * Day numbers (1-based) whose route preview is stale — i.e. routing inputs
   * changed since the last `applyRouteResult` for that day. Replaces the
   * former boolean `routePreviewStale`. Empty means every day's preview is
   * fresh. Reset to `[]` on `setActiveTrip`; populated per-mutation as waypoint
   * edits are isolated to a specific day (Tasks 7–9 refine per-day targeting;
   * in Phase 1 / Task 6 we approximate with the selected day).
   */
  stalePreviewDays: number[];

  /** Index into `activeTrip.days` for the currently-selected planner day. */
  selectedDayIndex: number;

  /** Select a planner day by index. */
  setSelectedDay: (index: number) => void;

  /**
   * The planner controls' current parameters, mirrored from the page so the
   * map's context-menu `placeWaypoint` can seed a brand-new draft with the
   * rider's chosen days/km/avoid options instead of store defaults. Null until
   * the planner page syncs it.
   */
  draftPlannerParameters: TripParameters | null;

  // Sidebar focus state consumed by the map layer (#79) and the
  // RoadPreviewCard components in the planner sidebar (US-33).
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;

  /**
   * Quality segment selected in the Plan & inspect planner — set by a route
   * click on the map OR a flagged-section card in the panel, so the two
   * surfaces stay in sync. Ids live in the derived-quality-segment id space
   * (`deriveDayQualitySegments`), not `day.segments`.
   */
  selectedPlannerSegmentId: string | null;

  /**
   * Active POI categories (revision 4 §A) — ONE source of truth driving
   * BOTH the map-top POI chip bar and the STOPS-tab filters. Multi-select;
   * an empty set means no POI pins and no checked STOPS filters.
   */
  activePoiCategories: ReadonlySet<PoiCategory>;

  /**
   * Did the rider opt into day-planning (revision 2 §A)? 'single' means
   * no day concept exists anywhere: no day column, no daily-km, no split.
   */
  planningMode: PlanningMode;
  /**
   * Two-phase planner lifecycle (addendum): the route is LIVE; days are
   * computed on demand. Only meaningful in 'multiday'. 'none' = no days
   * yet; 'split' = dayPlans current; 'stale' = route/prefs changed since
   * the last split — days render dimmed until the rider re-splits.
   */
  splitStatus: SplitStatus;
  /** Day plans from the last split (kept for dimmed display while stale). */
  dayPlans: DayPlan[] | null;
  /** Manual day-break overrides (along-route km) that survive re-splits. */
  pinnedBreakKms: number[];

  /**
   * Flip the day-planning opt-in. Entering 'single' also drops any
   * existing split — days exist only inside the multi-day layer.
   */
  setPlanningMode: (mode: PlanningMode) => void;
  /** Store the splitter result and enter the 'split' state. */
  applySplit: (dayPlans: DayPlan[], pinnedBreakKms?: number[]) => void;
  /** Drop the split back to 'none' (route stays). */
  clearSplit: () => void;
  /** Pin/replace the manual break overrides (addendum §6). */
  setPinnedBreaks: (kms: number[]) => void;
  /**
   * Rewrite `activeTrip.days` from the current dayPlans so the existing
   * save contract persists the split: day k = boundary start + the
   * original vias/stops that fall inside + boundary finish, with the
   * route polyline sliced per day. No-op unless state is 'split'.
   */
  materializeSplit: () => void;

  setTrips: (trips: TripSummary[], ownerId?: string | null) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (generating: boolean) => void;
  /** Set routeDirty to true. Called by user-facing controls that change routing inputs. */
  markRouteDirty: () => void;
  /**
   * Day-scoped dirty: stales ONLY the given day's preview (by index).
   * For inputs that affect a single day (e.g. a LEG override) — the
   * global variant would stale every routable day, and since live
   * routing only reroutes the selected day, the others would wedge the
   * Save gate until each was visited.
   */
  markDayRouteDirty: (dayIndex: number) => void;
  /** Mirror the planner controls' parameters for context-menu draft creation. */
  setDraftPlannerParameters: (parameters: TripParameters) => void;

  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;
  selectPlannerSegment: (segmentId: string | null) => void;
  /** Toggle a POI category in the shared map-bar/STOPS filter set. */
  togglePoiCategory: (category: PoiCategory) => void;

  // Waypoint management
  addWaypoint: (dayIndex: number, waypoint: Waypoint) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    location: { lng: number; lat: number },
    parameters?: Trip["parameters"],
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: Waypoint) => void;
  /**
   * Insert a waypoint immediately before the waypoint with the given id
   * (route-order aware — used by "Reroute around this"). A null id, or an id
   * that isn't in the day, falls back to the finish boundary like
   * `insertWaypointBeforeEnd`. Never inserts before the day's start.
   */
  insertWaypointBefore: (
    dayIndex: number,
    beforeWaypointId: string | null,
    waypoint: Waypoint,
  ) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  /**
   * Rename a waypoint on the active planner day (reverse-geocoded pin
   * names, typed-search picks). Not a routing input — no dirty flag, no
   * undo entry, no split invalidation.
   */
  renameWaypoint: (waypointId: string, name: string) => void;
  /**
   * Rename the working trip (planner header dialog). Undo-able and
   * marks the draft dirty so the new name reaches the next save.
   */
  renameActiveTrip: (name: string) => void;
  moveWaypoint: (
    dayIndex: number,
    waypointId: string,
    location: { lng: number; lat: number },
    parameters?: Trip["parameters"],
  ) => void;
  reorderWaypoints: (
    dayIndex: number,
    fromIndex: number,
    toIndex: number,
  ) => void;
  undo: () => void;
  redo: () => void;

  // ── Task 9: server-driven route geometry + context-menu waypoint actions ──

  /**
   * Place a waypoint via a context-menu action on the active planner day.
   * Initialises the draft trip/day if none exists yet (same path as
   * `appendPlannerWaypoint`).
   */
  placeWaypoint: (
    coords: { lat: number; lng: number },
    action: PlacementActionId,
    parameters?: TripParameters,
    /**
     * POI provenance for pins placed from the map's POI popover: names
     * the waypoint and carries the category so the map renders the
     * glyph-in-circle pin (revision 4).
     */
    meta?: { name?: string; poiCategory?: PoiCategory },
  ) => void;

  /**
   * Change the type of a waypoint on the active planner day (selected day).
   */
  setWaypointType: (waypointId: string, type: Waypoint["type"]) => void;

  /**
   * Remove a waypoint by id from the active planner day (selected day).
   * Distinct from the existing `removeWaypoint(dayIndex, waypointId)`.
   */
  removeWaypointById: (waypointId: string) => void;

  /**
   * Ordered [start, ...vias, end] location tuples from the active planner day.
   * Drives the live routing hook.
   */
  routingWaypoints: () => { lat: number; lng: number }[];

  /**
   * Ordered typed waypoints for the save payload. Types are mapped to the
   * canonical backend vocabulary (LOCAL_TO_BACKEND_WAYPOINT_TYPE), so
   * `rest` → `"food"` and `accommodation` → `"hotel"`.
   */
  saveWaypoints: () => {
    lat: number;
    lng: number;
    name?: string | null;
    poi_category?: PoiCategory | null;
    type: BackendWaypointType;
  }[];

  /**
   * Per-day save payload for PUT /trips/:id/route. Empty days (no waypoints)
   * are dropped; remaining days are renumbered contiguously 1..M. Waypoint
   * types are mapped via `LOCAL_TO_BACKEND_WAYPOINT_TYPE`.
   */
  saveDays: () => {
    dayNumber: number;
    title: string | null;
    startLinked: boolean;
    waypoints: {
      lat: number;
      lng: number;
      name?: string | null;
      poi_category?: PoiCategory | null;
      type: BackendWaypointType;
    }[];
  }[];

  /**
   * Write server-side route geometry + stats into the day identified by
   * `dayNumber`. Clears that day's stale flag. The caller (live routing hook)
   * passes the day it routed so concurrent multi-day routing lands in the
   * correct slot regardless of `selectedDayIndex` at call time.
   */
  applyRouteResult: (
    dayNumber: number,
    result: RouteResponse,
    legBreaks?: Array<{ legId: string; startVertex: number }>,
  ) => void;

  /**
   * Store real per-segment surface quality for a committed day (#862), fetched
   * from `POST /roads/route-quality` after `applyRouteResult`. Guarded by the
   * geometry it was computed for: applied only while the day's `routeGeometry`
   * still matches `forGeometry`, so a late-resolving quality fetch can't paint
   * a line the rider has since re-routed. A no-op otherwise.
   */
  applyRouteQuality: (
    dayNumber: number,
    forGeometry: ReadonlyArray<{ lat: number; lng: number }>,
    segments: RouteSegment[],
  ) => void;

  /**
   * Append a new day to the active trip (capped at MAX_TRIP_DAYS). The new
   * day is linked to the previous day's end and is immediately selected.
   */
  addDay: () => void;

  /**
   * Remove the day at the given index from the active trip (min 1 day).
   * Renumbers all remaining days contiguously and re-evaluates the boundary
   * at the removed index so linked days stay consistent.
   */
  removeDay: (index: number) => void;

  /**
   * Re-link the day at `index` to the previous day's end so overnight
   * boundaries stay in sync. index must be ≥ 1.
   */
  relinkDayStart: (index: number) => void;

  /**
   * Reset to initial state — used only by tests.
   */
  resetForTest: () => void;
}

/**
 * One history snapshot. We capture `dirty` alongside the trip so undo/redo
 * restore the `routeDirty` flag that was in effect at that point — otherwise
 * undoing back to a freshly-loaded route would leave `routeDirty` stuck true
 * and keep Save route / live routing armed against the canonical geometry.
 */
interface TripHistoryEntry {
  trip: Trip | null;
  dirty: boolean;
  /** The exact `stalePreviewDays` at snapshot time, restored verbatim on undo/redo. */
  stale: number[];
}

interface TripStoreHistory {
  undoStack: Array<TripHistoryEntry>;
  redoStack: Array<TripHistoryEntry>;
}

const MAX_HISTORY_ENTRIES = 50;

// ── Task 9 helpers ────────────────────────────────────────────────────────────

function activePlannerRoutingWaypoints(
  waypoints: Waypoint[],
): { lat: number; lng: number }[] {
  return filterRoutingWaypoints(waypoints).map((w) => ({
    lat: w.location.lat,
    lng: w.location.lng,
  }));
}

/**
 * Canonical waypoint type vocabulary expected by PUT /trips/:id/route
 * (SaveRouteWaypointDto.type). Mirrors the backend enum.
 */
export type BackendWaypointType =
  "start" | "via" | "end" | "fuel" | "food" | "coffee" | "hotel" | "photo";

/**
 * Maps the companion's local waypoint type vocabulary to the canonical backend
 * vocabulary expected by PUT /trips/:id/route (SaveRouteWaypointDto.type).
 *
 * This is the inverse of WAYPOINT_TYPE_MAP in trip-from-detail.ts:
 *   food → rest, coffee → rest, hotel → accommodation (inbound)
 * So on the way out we choose the canonical representative for each collapsed
 * local type: rest → food (the canonical for the food/coffee pair),
 * accommodation → hotel.
 */
const LOCAL_TO_BACKEND_WAYPOINT_TYPE: Record<
  Waypoint["type"],
  BackendWaypointType
> = {
  start: "start",
  via: "via",
  end: "end",
  fuel: "fuel",
  photo: "photo",
  rest: "food",
  accommodation: "hotel",
};

type PlannerWaypointNameContext = {
  /** GPX/KML waypoint labels are source data, even when they resemble roles. */
  preserveLegacyLikeNames: boolean;
  /** Names explicitly changed since load are user data, not migration sentinels. */
  renamedWaypointIds: ReadonlySet<string>;
};

function isRoleMatchedLegacyGeneratedName(
  waypoint: Waypoint,
  routingOrder: number | undefined,
  routingCount: number,
): boolean {
  const name = waypoint.name?.trim();
  if (
    !name ||
    waypoint.poiCategory ||
    !isLegacyGeneratedWaypointName(name) ||
    routingOrder === undefined
  ) {
    return false;
  }
  if (name === "Start") {
    return waypoint.type === "start" && routingOrder === 0;
  }
  if (name === "Finish" || name === "End") {
    return (
      waypoint.type === "end" && routingOrder === Math.max(0, routingCount - 1)
    );
  }
  if (name === "Reroute via") return waypoint.type === "via";
  const viaNumber = /^Via (\d+)$/.exec(name);
  return (
    waypoint.type === "via" &&
    viaNumber !== null &&
    Number(viaNumber[1]) === routingOrder
  );
}

function activePlannerSaveWaypoints(
  waypoints: Waypoint[],
  nameContext: PlannerWaypointNameContext,
): {
  lat: number;
  lng: number;
  name?: string | null;
  poi_category?: PoiCategory | null;
  type: BackendWaypointType;
}[] {
  const routingWaypoints = waypoints.filter(isRoutingWaypoint);
  const routingOrder = new Map(
    routingWaypoints.map((waypoint, order) => [waypoint, order] as const),
  );
  return waypoints.map((w) => {
    const persistedName =
      typeof w.name === "string" && w.name.trim() ? w.name : null;
    const preserveLegacyLikeName =
      nameContext.preserveLegacyLikeNames ||
      nameContext.renamedWaypointIds.has(w.id) ||
      w.nameIsSource ||
      Boolean(w.poiCategory);
    const generatedLegacyName =
      !preserveLegacyLikeName &&
      isRoleMatchedLegacyGeneratedName(
        w,
        routingOrder.get(w),
        routingWaypoints.length,
      );
    return {
      lat: w.location.lat,
      lng: w.location.lng,
      // Always emit the `name` key (null for an unnamed/generated role) — the
      // save-route contract types it `string | null`. Legacy cleanup is
      // deliberately contextual so a real source label named "Start"/"End"
      // is never destroyed merely because it resembles old generated copy.
      name:
        persistedName !== null && !generatedLegacyName ? persistedName : null,
      poi_category: w.poiCategory ?? null,
      type: LOCAL_TO_BACKEND_WAYPOINT_TYPE[w.type] ?? "via",
    };
  });
}

function plannerWaypointNameContext(
  trip: Pick<Trip, "importSourceFormat">,
  renamedWaypointIds: readonly string[],
  savedWaypointNames: Readonly<Record<string, string | null>>,
): PlannerWaypointNameContext {
  const sourceNameWaypointIds = new Set(renamedWaypointIds);
  // With no historical provenance column, a non-blank server baseline is
  // ambiguous: it may be an old generated role or a genuine rider/source
  // label with the same spelling. Preserve it rather than destructively
  // guessing. Hydration marks those non-blank names as source-owned too, so
  // display and export make the same conservative choice as persistence.
  for (const [waypointId, name] of Object.entries(savedWaypointNames)) {
    if (name?.trim()) sourceNameWaypointIds.add(waypointId);
  }
  return {
    preserveLegacyLikeNames: Boolean(trip.importSourceFormat),
    renamedWaypointIds: sourceNameWaypointIds,
  };
}

/**
 * A generated multi-day trip ends each non-final day at an overnight stop typed
 * `accommodation` (backend `hotel`) rather than `end`. The manual save path
 * requires an `end`, so when a day has no explicit end but terminates in an
 * accommodation, re-type that terminal stop as the day's finish so it passes
 * the per-day start→end validation and routes to the overnight location.
 */
export function normalizeDayFinish(waypoints: Waypoint[]): Waypoint[] {
  const lastIdx = waypoints.length - 1;
  // A terminal accommodation IS the day's finish — even when an earlier explicit
  // `end` OR an earlier stay exists (a replacement overnight added after one).
  // Re-type the terminal stay to `end` and demote ANY earlier `end`/
  // `accommodation` to a via, so the day keeps exactly one finish and one
  // overnight: otherwise the stale earlier stay persists as `hotel` and
  // `tripFromDetail` would derive the overnight from it instead of the new one.
  if (waypoints[lastIdx]?.type !== "accommodation") return waypoints;
  return waypoints.map((w, i) => {
    if (i === lastIdx) return { ...w, type: "end" };
    if (w.type === "end" || w.type === "accommodation")
      return { ...w, type: "via" };
    return w;
  });
}

/**
 * The waypoint that finishes a day's route: a TERMINAL `accommodation` (a
 * generated overnight, or a stay added after an explicit end) takes precedence,
 * otherwise the explicit `end`. Returns `undefined` when the day has no finish.
 * Use this anywhere a predecessor's finish coordinates drive linked-start sync
 * so accommodation-terminated days behave like `end`-terminated ones.
 */
export function dayFinishWaypoint(waypoints: Waypoint[]): Waypoint | undefined {
  const last = waypoints[waypoints.length - 1];
  if (last?.type === "accommodation") return last;
  return waypoints.find((w) => w.type === "end");
}

/**
 * Role-from-index: among the ROUTING waypoints (start/via/end — stop types
 * like fuel or accommodation keep their type and don't participate), the
 * first is the start, the last is the finish, everything between is a via.
 * Called after any reorder/removal so dragging a via to the top makes it
 * the start (demoting the old start to a via), and deleting the start
 * promotes the next routing waypoint. Legacy auto-generated English names are
 * removed so the new role is translated at render time; custom names
 * (geocoded towns) are preserved.
 */
export function reassignWaypointRoles(waypoints: Waypoint[]): Waypoint[] {
  const routing = waypoints
    .map((waypoint, index) => ({ waypoint, index }))
    .filter(
      ({ waypoint }) =>
        waypoint.type === "start" ||
        waypoint.type === "via" ||
        waypoint.type === "end",
    );
  if (routing.length === 0) return waypoints;

  const next = [...waypoints];
  let changed = false;
  routing.forEach(({ waypoint, index }, order) => {
    const role: Waypoint["type"] =
      order === 0 ? "start" : order === routing.length - 1 ? "end" : "via";
    const clearLegacyName =
      !waypoint.nameIsSource &&
      !waypoint.poiCategory &&
      isLegacyGeneratedWaypointName(waypoint.name);
    if (waypoint.type === role && !clearLegacyName) return;
    changed = true;
    const updated = stripLegacyGeneratedWaypointName({
      ...waypoint,
      type: role,
    });
    next[index] = updated;
  });
  return changed ? next : waypoints;
}

function stripLegacyGeneratedWaypointName(waypoint: Waypoint): Waypoint {
  if (
    waypoint.nameIsSource ||
    waypoint.poiCategory ||
    !isLegacyGeneratedWaypointName(waypoint.name)
  ) {
    return waypoint;
  }
  const updated = { ...waypoint };
  delete updated.name;
  return updated;
}

/**
 * Index at which to insert a via so it lands BEFORE the day's finish (explicit
 * `end` or terminal `accommodation`). Returns `waypoints.length` (append) when
 * the day has no finish yet — keeping a generated overnight day's accommodation
 * terminal instead of stranding the via after it.
 */
function viaInsertIndex(waypoints: Waypoint[]): number {
  const finish = dayFinishWaypoint(waypoints);
  return finish ? waypoints.indexOf(finish) : waypoints.length;
}

// ── Task 8: linked-start sync helper ─────────────────────────────────────────

/**
 * A linked start represents the same place as the predecessor finish. Mirror
 * semantic POI metadata and genuine source names along with its coordinates so
 * the successor day keeps the same localizable identity after save/reload.
 */
function linkedStartFromFinish(finish: Waypoint, id: string): Waypoint {
  const sourceName =
    finish.nameIsSource && finish.name?.trim() ? finish.name : undefined;
  return {
    id,
    type: "start",
    ...(sourceName ? { name: sourceName, nameIsSource: true } : {}),
    ...(finish.poiCategory ? { poiCategory: finish.poiCategory } : {}),
    location: { ...finish.location },
  };
}

/**
 * After mutating day at `idx`, if it changed its `end`, push that end into the
 * next day's start when the next day is linked, marking both days stale.
 * Returns `{ days, stale }` — thread the returned stale array through.
 */
function syncLinkedStart(
  days: TripDay[],
  idx: number,
  staleDays: number[],
): { days: TripDay[]; stale: number[] } {
  const next = days[idx + 1];
  if (!next || !next.startLinked) return { days, stale: staleDays };
  const current = days[idx];
  if (!current) return { days, stale: staleDays };
  // A generated predecessor finishes at a terminal accommodation (overnight),
  // not an explicit `end` — treat that as the finish so moving it cascades.
  const end = dayFinishWaypoint(current.waypoints);
  const nextWaypoints = [...next.waypoints];
  const startIdx = nextWaypoints.findIndex((w) => w.type === "start");
  if (!end) {
    // The predecessor no longer has a finish to mirror (e.g. its terminal stay
    // was dragged off the end). The link is no longer valid: clear it so the
    // successor's start isn't suppressed as "linked" with nothing behind it,
    // and a later predecessor finish can't overwrite it. Don't re-stale — the
    // successor's existing start location is unchanged, only the flag.
    const cleared = [...days];
    cleared[idx + 1] = { ...next, startLinked: false };
    return { days: cleared, stale: staleDays };
  }
  // If the linked start already mirrors the predecessor's end identity, the
  // edit was unrelated to the boundary (e.g. a via change) — don't rewrite or
  // re-stale the successor, or it would sit in stalePreviewDays with unchanged
  // routing inputs and wedge the Save gate until the rider visits it.
  const existingStart = startIdx >= 0 ? nextWaypoints[startIdx] : undefined;
  const seededStart = linkedStartFromFinish(
    end,
    existingStart?.id ?? `link-${next.dayNumber}`,
  );
  if (
    existingStart &&
    existingStart.location.lng === end.location.lng &&
    existingStart.location.lat === end.location.lat &&
    existingStart.name === seededStart.name &&
    existingStart.nameIsSource === seededStart.nameIsSource &&
    existingStart.poiCategory === seededStart.poiCategory
  ) {
    return { days, stale: staleDays };
  }
  if (startIdx >= 0) nextWaypoints[startIdx] = seededStart;
  else nextWaypoints.unshift(seededStart);
  const updated = [...days];
  updated[idx + 1] = updatePlannerDayRoute(
    { ...next, waypoints: nextWaypoints },
    nextWaypoints,
    undefined,
  );
  return { days: updated, stale: markDayStale(staleDays, next.dayNumber) };
}

/**
 * Shared post-commit boilerplate for the context-menu mutations
 * (`placeWaypoint` / `setWaypointType` / `removeWaypointById`). Takes the
 * `commitTripChange` result (already confirmed `!== state`), marks the edited
 * day `idx` stale, runs `syncLinkedStart` to mirror the edited end into the next
 * linked day, and returns the `{ activeTrip, routeDirty, stalePreviewDays }`
 * slice to spread over the committed result. The single `committed` cast lives
 * here so the three callers don't each repeat it.
 */
function applyPostCommitSync(
  committed:
    Partial<TripState & TripStoreHistory> | (TripState & TripStoreHistory),
  state: TripState & TripStoreHistory,
  idx: number,
): {
  activeTrip: Trip | null;
  routeDirty: true;
  stalePreviewDays: number[];
} {
  const committedTrip = (committed as { activeTrip?: Trip | null }).activeTrip;
  const updatedDays = committedTrip?.days ?? [];
  const staleAfterCommit = markDayStale(
    state.stalePreviewDays,
    updatedDays[idx]?.dayNumber ?? 1,
  );
  const { days: syncedDays, stale: syncedStale } = syncLinkedStart(
    updatedDays,
    idx,
    staleAfterCommit,
  );
  return {
    activeTrip: committedTrip
      ? { ...committedTrip, days: syncedDays }
      : (committedTrip ?? null),
    routeDirty: true,
    stalePreviewDays: syncedStale,
  };
}

/**
 * Snapshot every waypoint's current name by id — the baseline a subsequent
 * rename is diffed against so only NET name changes stay dirty (#911).
 */
function waypointNameBaseline(
  trip: Trip | null,
): Record<string, string | null> {
  const baseline: Record<string, string | null> = {};
  for (const day of trip?.days ?? []) {
    for (const w of day.waypoints) baseline[w.id] = w.name ?? null;
  }
  return baseline;
}

/**
 * Re-apply the current renames onto a route snapshot being restored by
 * undo/redo. Waypoint names are metadata that live OUTSIDE route history (a
 * rename is not undoable), so a route undo/redo must not roll a name back to
 * its value at the snapshot — otherwise a rename that landed after that
 * snapshot (e.g. a late reverse-geocode) would be silently dropped (#911).
 */
function overlayRenamedNames(
  restored: Trip | null,
  current: Trip | null,
  renamedIds: string[],
): Trip | null {
  if (!restored || renamedIds.length === 0) return restored;
  const renamed = new Set(renamedIds);
  const currentNames = new Map<string, string | undefined>();
  for (const day of current?.days ?? []) {
    for (const w of day.waypoints) {
      if (renamed.has(w.id)) currentNames.set(w.id, w.name);
    }
  }
  if (currentNames.size === 0) return restored;
  return {
    ...restored,
    days: restored.days.map((day) =>
      day.waypoints.some((w) => currentNames.has(w.id))
        ? {
            ...day,
            waypoints: day.waypoints.map((w) =>
              currentNames.has(w.id)
                ? { ...w, name: currentNames.get(w.id) }
                : w,
            ),
          }
        : day,
    ),
  };
}

/**
 * Carry the current name-dirty state across a route undo/redo: overlay the
 * current renames onto the restored route, then PRUNE the tracked ids to
 * waypoints that still exist in it. Undo/redo can drop a waypoint whose rename
 * was still pending (e.g. a reverse-geocode on a just-added stop) — keeping its
 * id would leave Save armed with nothing to PATCH, falling through to the
 * re-routing save on an otherwise unchanged route (#911).
 */
function restoreNameStateOntoRoute(
  restored: Trip | null,
  current: Trip | null,
  renamedIds: string[],
): {
  activeTrip: Trip | null;
  renamedWaypointIds: string[];
  namesDirty: boolean;
} {
  const activeTrip = overlayRenamedNames(restored, current, renamedIds);
  const liveIds = new Set<string>();
  for (const day of activeTrip?.days ?? []) {
    for (const w of day.waypoints) liveIds.add(w.id);
  }
  const pruned = renamedIds.filter((id) => liveIds.has(id));
  return {
    activeTrip,
    renamedWaypointIds: pruned,
    namesDirty: pruned.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export const useTripStore = create<TripState & TripStoreHistory>(
  (set, get) => ({
    trips: [],
    tripsOwnerId: null,
    activeTrip: null,
    isGenerating: false,
    canUndo: false,
    canRedo: false,
    routeDirty: false,
    namesDirty: false,
    renamedWaypointIds: [],
    savedWaypointNames: {},
    stalePreviewDays: [],
    selectedDayIndex: 0,
    draftPlannerParameters: null,
    focusedSegmentId: null,
    hoveredSegmentId: null,
    selectedPlannerSegmentId: null,
    activePoiCategories: new Set<PoiCategory>(),
    planningMode: "single",
    splitStatus: "none",
    dayPlans: null,
    pinnedBreakKms: [],
    undoStack: [],
    redoStack: [],

    setTrips: (trips, ownerId) =>
      set((state) =>
        ownerId === undefined ? { trips } : { trips, tripsOwnerId: ownerId },
      ),
    setActiveTrip: (activeTrip) =>
      set({
        activeTrip,
        routeDirty: false,
        namesDirty: false,
        renamedWaypointIds: [],
        savedWaypointNames: waypointNameBaseline(activeTrip),
        stalePreviewDays: [],
        selectedDayIndex: 0,
        focusedSegmentId: null,
        hoveredSegmentId: null,
        selectedPlannerSegmentId: null,
        // A loaded multi-day trip is already "split" — show its days in
        // the day column; a fresh draft/single-day trip starts in single
        // mode with no day concept at all (revision 2 §A).
        planningMode:
          activeTrip && activeTrip.days.length > 1 ? "multiday" : "single",
        splitStatus:
          activeTrip && activeTrip.days.length > 1 ? "split" : "none",
        dayPlans:
          activeTrip && activeTrip.days.length > 1
            ? dayPlansFromTripDays(activeTrip.days)
            : null,
        pinnedBreakKms: [],
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      }),
    setSelectedDay: (index) => set({ selectedDayIndex: index }),
    setGenerating: (isGenerating) => set({ isGenerating }),
    markRouteDirty: () =>
      set((s) => ({
        routeDirty: true,
        // Routing inputs changed — a computed split no longer matches the
        // route. Keep the plans for dimmed display, but flag them stale.
        ...(s.splitStatus === "split"
          ? { splitStatus: "stale" as SplitStatus }
          : {}),
        // Avoid-option toggles are trip-level, but only mark ROUTABLE days
        // (>=2 routing waypoints) stale. Empty/under-specified days can't be
        // re-routed by the live hook (it bails for <2 routing waypoints), so
        // marking them would leave a stale flag that never clears and wedges
        // the Save gate (which requires stalePreviewDays to be empty).
        // Normalize a terminal accommodation to its finish first, so generated
        // overnight days (start + accommodation) are correctly routable and get
        // re-previewed — otherwise Save could persist an unpreviewed reroute.
        stalePreviewDays: (s.activeTrip?.days ?? [])
          .filter(
            (d) =>
              filterRoutingWaypoints(normalizeDayFinish(d.waypoints)).length >=
              2,
          )
          .map((d) => d.dayNumber),
      })),
    markDayRouteDirty: (dayIndex) =>
      set((s) => {
        const day = s.activeTrip?.days[dayIndex];
        const routable =
          day &&
          filterRoutingWaypoints(normalizeDayFinish(day.waypoints)).length >= 2;
        return {
          routeDirty: true,
          ...(s.splitStatus === "split"
            ? { splitStatus: "stale" as SplitStatus }
            : {}),
          // Same routability rule as markRouteDirty: never stale a day the
          // live hook can't re-route, or the flag wedges the Save gate.
          ...(routable
            ? {
                stalePreviewDays: s.stalePreviewDays.includes(day.dayNumber)
                  ? s.stalePreviewDays
                  : [...s.stalePreviewDays, day.dayNumber],
              }
            : {}),
        };
      }),
    setDraftPlannerParameters: (parameters) =>
      set({ draftPlannerParameters: parameters }),

    focusSegment: (segmentId) => set({ focusedSegmentId: segmentId }),
    hoverSegment: (segmentId) => set({ hoveredSegmentId: segmentId }),
    selectPlannerSegment: (segmentId) =>
      set({ selectedPlannerSegmentId: segmentId }),

    togglePoiCategory: (category) =>
      set((state) => {
        const next = new Set(state.activePoiCategories);
        if (next.has(category)) next.delete(category);
        else next.add(category);
        return { activePoiCategories: next };
      }),

    renameActiveTrip: (name) =>
      set((state) => {
        const trimmed = name.trim();
        if (!trimmed || !state.activeTrip || state.activeTrip.name === trimmed)
          return state;
        const committed = commitTripChange(state, (activeTrip) =>
          activeTrip
            ? {
                ...activeTrip,
                name: trimmed,
                updatedAt: new Date().toISOString(),
              }
            : activeTrip,
        );
        if (committed === state) return state;
        // A rename is a METADATA edit: never routeDirty. Arming the
        // route save for it would re-route the whole trip (unpreviewed,
        // with whatever options sit in the sidebar) just to carry a
        // title — persisted trips PATCH the title directly instead.
        return committed;
      }),

    renameWaypoint: (waypointId, name) =>
      set((state) => {
        const trip = state.activeTrip;
        if (!trip) return state;
        let changed = false;
        const days = trip.days.map((day) => {
          if (!day.waypoints.some((w) => w.id === waypointId)) return day;
          changed = true;
          return {
            ...day,
            waypoints: day.waypoints.map((w) =>
              w.id === waypointId ? { ...w, name, nameIsSource: true } : w,
            ),
          };
        });
        if (!changed) return state;
        // Metadata-only edit (no geometry change): track the id so the
        // name-only save (#911) sends just this stop, not a re-route. Diff
        // against the loaded/last-saved baseline rather than appending — a
        // rename back to the baseline name is a NET-zero edit and drops out, so
        // it never PATCHes (which would revert a collaborator's newer rename).
        const nextIds = new Set(state.renamedWaypointIds);
        if (name === (state.savedWaypointNames[waypointId] ?? null)) {
          nextIds.delete(waypointId);
        } else {
          nextIds.add(waypointId);
        }
        return {
          activeTrip: { ...trip, days },
          namesDirty: nextIds.size > 0,
          renamedWaypointIds: [...nextIds],
        };
      }),

    setPlanningMode: (mode) =>
      set(
        // Leaving multi-day drops the day concept entirely — splits only
        // exist inside the opt-in layer (revision 2 §A).
        mode === "single"
          ? {
              planningMode: mode,
              splitStatus: "none",
              dayPlans: null,
              pinnedBreakKms: [],
            }
          : { planningMode: mode },
      ),

    applySplit: (dayPlans, pinnedBreakKms) =>
      set((state) => ({
        dayPlans,
        // Running a split IS acting on the multi-day section.
        planningMode: "multiday",
        splitStatus: "split",
        pinnedBreakKms: pinnedBreakKms ?? state.pinnedBreakKms,
        // A split is a save-worthy change on its own: without this a
        // clean loaded route could be split but never saved (the save
        // gate keys on routeDirty), so materializeSplit would never run.
        routeDirty: true,
      })),
    clearSplit: () =>
      set({ splitStatus: "none", dayPlans: null, pinnedBreakKms: [] }),
    setPinnedBreaks: (kms) => set({ pinnedBreakKms: kms }),

    materializeSplit: () =>
      set((state) => {
        const trip = state.activeTrip;
        const plans = state.dayPlans;
        if (
          !trip ||
          !plans ||
          plans.length === 0 ||
          state.splitStatus !== "split" ||
          // Working-day model only: a loaded multi-day trip already has
          // materialized days; re-slicing from day 1's geometry alone
          // would corrupt them.
          trip.days.length !== 1
        ) {
          return state;
        }
        const routeDay = trip.days[0];
        const coordinates = routeDay?.routeGeometry?.coordinates;
        if (!routeDay || !coordinates || coordinates.length < 2) return state;

        const kmAt = cumulativeKm(coordinates);
        const totalKm = kmAt[kmAt.length - 1] ?? 0;
        if (totalKm <= 0) return state;
        // Along-route position of every original waypoint (nearest vertex).
        const waypointKms = routeDay.waypoints.map((waypoint) =>
          nearestVertexKm(coordinates, kmAt, waypoint.location),
        );

        const days: TripDay[] = plans.map((plan, index) => {
          const fromKm = index === 0 ? 0 : (plans[index - 1]?.endKm ?? 0);
          const toKm = index === plans.length - 1 ? totalKm : plan.endKm;
          const sliced = sliceCoordinatesByKm(coordinates, kmAt, fromKm, toKm);
          const startCoord = sliced[0]!;
          const endCoord = sliced[sliced.length - 1]!;

          const interior = routeDay.waypoints.filter((waypoint, wIndex) => {
            if (waypoint.type === "start" || waypoint.type === "end")
              return false;
            const km = waypointKms[wIndex]!;
            return km > fromKm + 0.5 && km < toKm - 0.5;
          });

          const existingStart = routeDay.waypoints.find(
            (waypoint) => waypoint.type === "start",
          );
          const startWaypoint: Waypoint =
            index === 0 && existingStart
              ? stripLegacyGeneratedWaypointName(existingStart)
              : index === 0
                ? {
                    id: `split-start-${plan.dayNumber}`,
                    location: { lng: startCoord[0]!, lat: startCoord[1]! },
                    type: "start",
                  }
                : {
                    id: `split-start-${plan.dayNumber}`,
                    ...(plan.startNameIsSource && plan.startTown
                      ? { name: plan.startTown, nameIsSource: true }
                      : {}),
                    ...(plan.startPoiCategory
                      ? { poiCategory: plan.startPoiCategory }
                      : {}),
                    location: { lng: startCoord[0]!, lat: startCoord[1]! },
                    type: "start",
                  };
          const existingEnd = routeDay.waypoints.find(
            (waypoint) => waypoint.type === "end",
          );
          const endWaypoint: Waypoint =
            index === plans.length - 1 && existingEnd
              ? stripLegacyGeneratedWaypointName(existingEnd)
              : index === plans.length - 1
                ? {
                    id: `split-end-${plan.dayNumber}`,
                    location: { lng: endCoord[0]!, lat: endCoord[1]! },
                    type: "end",
                  }
                : {
                    id: `split-end-${plan.dayNumber}`,
                    ...(plan.endNameIsSource && plan.endTown
                      ? { name: plan.endTown, nameIsSource: true }
                      : {}),
                    ...(plan.endPoiCategory
                      ? { poiCategory: plan.endPoiCategory }
                      : {}),
                    location: { lng: endCoord[0]!, lat: endCoord[1]! },
                    type: "end",
                  };

          const share = totalKm > 0 ? (toKm - fromKm) / totalKm : 0;
          return {
            dayNumber: plan.dayNumber,
            waypoints: [startWaypoint, ...interior, endWaypoint],
            routeGeometry: { type: "LineString", coordinates: sliced },
            distanceKm: plan.distanceKm,
            durationMinutes: plan.timeMin,
            elevationGain: Math.round(routeDay.elevationGain * share),
            avgQuality: plan.quality.score ?? 0,
            segments: [],
            startLinked: index > 0,
          };
        });

        return {
          activeTrip: {
            ...trip,
            days,
            num_days: days.length,
            updatedAt: new Date().toISOString(),
          },
        };
      }),

    addWaypoint: (dayIndex, waypoint) =>
      set((state) => {
        const committed = commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          days[dayIndex] = updatePlannerDayRoute(
            day,
            [...day.waypoints, waypoint],
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        });
        if (committed === state) return state;
        // Adding a waypoint (e.g. a suggested overnight stay from
        // TripStopsPanel) is a route edit — mark dirty + stale, AND cascade
        // through syncLinkedStart so adding a terminal accommodation re-seeds
        // and re-stales the linked successor's start (else Save persists a
        // boundary the backend will clear for mismatched coordinates).
        return {
          ...committed,
          ...applyPostCommitSync(committed, state, dayIndex),
        };
      }),

    appendPlannerWaypoint: (dayIndex, location, parameters) =>
      set((state) => {
        const committed = commitTripChange(state, (activeTrip) => {
          const baseTrip =
            activeTrip ??
            createPlannerDraftTrip(new Date().toISOString(), parameters);
          const days = ensurePlannerDays(baseTrip.days, dayIndex + 1);
          const day = days[dayIndex]!;
          const nextParameters = mergePlannerParameters(
            baseTrip.parameters,
            parameters,
            days.length,
          );
          // Geometry is now driven exclusively by applyRouteResult (live
          // routing). Just append the waypoint; do NOT synthesize geometry.
          days[dayIndex] = appendPlannerWaypointToDay(day, location);
          return {
            ...baseTrip,
            days,
            parameters: nextParameters,
            updatedAt: new Date().toISOString(),
          };
        });
        if (committed === state) return state;
        // Use the shared post-commit sync (like placeWaypoint/moveWaypoint) so
        // appending this day's finish cascades into the next linked day's
        // start — otherwise a successor added via "Add day" before the finish
        // existed stays empty and gets dropped on save.
        return {
          ...committed,
          ...applyPostCommitSync(committed, state, dayIndex),
        };
      }),

    insertWaypointBefore: (dayIndex, beforeWaypointId, waypoint) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          const waypoints = [...day.waypoints];
          const anchorIndex = beforeWaypointId
            ? waypoints.findIndex((w) => w.id === beforeWaypointId)
            : -1;
          // Missing anchor → finish boundary; found anchor → clamp so the
          // via can never land ahead of the day's start.
          const insertionIndex =
            anchorIndex >= 0
              ? Math.max(1, anchorIndex)
              : viaInsertIndex(waypoints);
          waypoints.splice(insertionIndex, 0, waypoint);
          days[dayIndex] = updatePlannerDayRoute(
            day,
            waypoints,
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
        // A reroute via is a route edit — arm Save and the live-routing hook.
        // Non-routing stops (fuel/rest/photo/mid-day accommodation) never
        // change the spine: they arm Save (they must persist) but must not
        // stale a day the live hook won't revisit, or Save wedges until the
        // rider manually reroutes an unchanged day.
        routeDirty: true,
        stalePreviewDays: !isRoutingWaypoint(waypoint)
          ? get().stalePreviewDays
          : markDayStale(
              get().stalePreviewDays,
              get().activeTrip?.days[dayIndex]?.dayNumber ?? 1,
            ),
      })),

    insertWaypointBeforeEnd: (dayIndex, waypoint) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          const waypoints = [...day.waypoints];
          // Insert before the day's finish (explicit end OR a terminal
          // accommodation), so a stop added to a generated overnight day keeps
          // the accommodation terminal instead of landing after it.
          const insertionIndex = viaInsertIndex(waypoints);
          waypoints.splice(insertionIndex, 0, waypoint);
          days[dayIndex] = updatePlannerDayRoute(
            day,
            waypoints,
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
        // POI stops (fuel/food/photo) inserted from TripStopsPanel are a route
        // edit — mark dirty so they enable Save route (gated on routeDirty).
        // But only ROUTING waypoints (vias) stale the preview: a stop never
        // changes the spine, and staling a day the live hook won't revisit
        // wedges Save until the rider manually reroutes an unchanged day.
        routeDirty: true,
        stalePreviewDays: !isRoutingWaypoint(waypoint)
          ? get().stalePreviewDays
          : markDayStale(
              get().stalePreviewDays,
              get().activeTrip?.days[dayIndex]?.dayNumber ?? 1,
            ),
      })),

    removeWaypoint: (dayIndex, waypointId) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          days[dayIndex] = updatePlannerDayRoute(
            day,
            // Deleting the start/finish promotes its neighbour (role from index).
            reassignWaypointRoles(
              day.waypoints.filter((w) => w.id !== waypointId),
            ),
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
      ),

    moveWaypoint: (dayIndex, waypointId, location, parameters) =>
      set((state) => {
        const result = commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const waypointIndex = day.waypoints.findIndex(
            (waypoint) => waypoint.id === waypointId,
          );
          if (waypointIndex < 0) return activeTrip;
          const previous = day.waypoints[waypointIndex]!;
          if (
            previous.location.lng === location.lng &&
            previous.location.lat === location.lat
          ) {
            return activeTrip;
          }
          const days = [...activeTrip.days];
          const waypoints = [...day.waypoints];
          waypoints[waypointIndex] = {
            ...previous,
            location: { lng: location.lng, lat: location.lat },
          };
          // When the page passes live sidebar plannerParams, fold them
          // into the trip so the parameters are current when the live
          // routing hook next calls applyRouteResult.
          const nextParameters = parameters
            ? mergePlannerParameters(
                activeTrip.parameters,
                parameters,
                activeTrip.days.length,
              )
            : activeTrip.parameters;
          // Dragging a linked successor's start (a marker visible only in focus
          // mode) breaks the link — same as placing a new start via the menu —
          // so a later predecessor-end edit won't overwrite the rider's chosen
          // start as if the link were intact.
          const breakLink =
            previous.type === "start" &&
            dayIndex >= 1 &&
            day.startLinked === true;
          days[dayIndex] = updatePlannerDayRoute(
            breakLink ? { ...day, startLinked: false } : day,
            waypoints,
            nextParameters,
          );
          return {
            ...activeTrip,
            days,
            parameters: nextParameters,
            updatedAt: new Date().toISOString(),
          };
        });
        // Only mark dirty if the move actually changed state (no-op moves
        // return the same state reference from commitTripChange). A real move
        // makes the DRAGGED day's geometry stale (not the selected day's — a
        // marker drag can target any day) and, if it moved an end, cascades the
        // new location into the next linked day's start. Reuse the shared
        // post-commit sync so the drag handler matches the context-menu edits.
        if (result === state) return state;
        return { ...result, ...applyPostCommitSync(result, state, dayIndex) };
      }),

    reorderWaypoints: (dayIndex, fromIndex, toIndex) =>
      set((state) => {
        const committed = commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          const waypoints = [...day.waypoints];
          const moved = waypoints[fromIndex];
          if (!moved) return activeTrip;
          waypoints.splice(fromIndex, 1);
          waypoints.splice(toIndex, 0, moved);
          days[dayIndex] = updatePlannerDayRoute(
            day,
            // Roles derive from position: dragging a via to the top makes
            // it the start; to the bottom, the finish.
            reassignWaypointRoles(waypoints),
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        });
        if (committed === state) return state;
        // Cascade through the shared post-commit sync: reordering can change the
        // day's effective finish (e.g. dragging a terminal accommodation before
        // the explicit end), which must re-seed AND re-stale the linked
        // successor's start — otherwise Save persists a broken boundary.
        return {
          ...committed,
          ...applyPostCommitSync(committed, state, dayIndex),
        };
      }),

    undo: () =>
      set((state) => {
        if (state.undoStack.length === 0) return state;
        const previous = state.undoStack[state.undoStack.length - 1]!;
        const undoStack = state.undoStack.slice(0, -1);
        const redoStack = trimHistory([
          ...state.redoStack,
          {
            trip: state.activeTrip,
            dirty: state.routeDirty,
            stale: state.stalePreviewDays,
          },
        ]);
        // Names live outside route history: keep the current renames (overlaid
        // onto the restored route) rather than rolling them back, but prune any
        // whose waypoint the undo removed.
        const restoredNames = restoreNameStateOntoRoute(
          previous.trip,
          state.activeTrip,
          state.renamedWaypointIds,
        );
        return {
          activeTrip: restoredNames.activeTrip,
          namesDirty: restoredNames.namesDirty,
          renamedWaypointIds: restoredNames.renamedWaypointIds,
          // Restore the route dirty flag so undoing back to the loaded route
          // clears it (re-disabling Save).
          routeDirty: previous.dirty,
          // Restore the EXACT stale set captured with this snapshot — not a
          // reconstruction from all routable days, which would over-stale
          // untouched days. Live routing only runs the selected day, so an
          // over-stale untouched day could never clear and would wedge Save.
          // (A clean snapshot captured an empty set, so this also re-disables
          // Save when undoing back to the loaded route.)
          stalePreviewDays: previous.stale,
          // Clamp the selection into the restored day range — undoing back to
          // fewer days must not leave selectedDayIndex past the end (which would
          // render "Day N of M<N" and make the next placement recreate a day).
          selectedDayIndex: Math.max(
            0,
            Math.min(
              state.selectedDayIndex,
              (previous.trip?.days.length ?? 1) - 1,
            ),
          ),
          focusedSegmentId: null,
          hoveredSegmentId: null,
          selectedPlannerSegmentId: null,
          ...(state.splitStatus === "split"
            ? { splitStatus: "stale" as SplitStatus }
            : {}),
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
        };
      }),

    redo: () =>
      set((state) => {
        if (state.redoStack.length === 0) return state;
        const next = state.redoStack[state.redoStack.length - 1]!;
        const redoStack = state.redoStack.slice(0, -1);
        const undoStack = trimHistory([
          ...state.undoStack,
          {
            trip: state.activeTrip,
            dirty: state.routeDirty,
            stale: state.stalePreviewDays,
          },
        ]);
        // Names are outside route history — carried across redo, pruned to the
        // restored route's waypoints (see undo).
        const restoredNames = restoreNameStateOntoRoute(
          next.trip,
          state.activeTrip,
          state.renamedWaypointIds,
        );
        return {
          activeTrip: restoredNames.activeTrip,
          namesDirty: restoredNames.namesDirty,
          renamedWaypointIds: restoredNames.renamedWaypointIds,
          routeDirty: next.dirty,
          // Restore the exact stale set captured with this snapshot (see undo).
          stalePreviewDays: next.stale,
          selectedDayIndex: Math.max(
            0,
            Math.min(state.selectedDayIndex, (next.trip?.days.length ?? 1) - 1),
          ),
          focusedSegmentId: null,
          hoveredSegmentId: null,
          selectedPlannerSegmentId: null,
          ...(state.splitStatus === "split"
            ? { splitStatus: "stale" as SplitStatus }
            : {}),
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
        };
      }),

    // ── Task 9: server-driven route geometry + context-menu waypoint actions ──

    placeWaypoint: (coords, action, parameters, meta) =>
      set((state) => {
        const committed = commitTripChange(state, (activeTrip) => {
          const isDraftCreation = activeTrip === null;
          const baseTrip =
            activeTrip ??
            createPlannerDraftTrip(new Date().toISOString(), parameters);
          // New drafts always start on day index 0. For an existing trip, target
          // the currently selected day so the rider's active day receives the edit.
          const idx = isDraftCreation ? 0 : state.selectedDayIndex;
          const days = ensurePlannerDays(baseTrip.days, idx + 1);
          const day = days[idx]!;
          const waypoints = [...day.waypoints];
          const sourceName = meta?.name?.trim();

          const newWaypoint: Waypoint = {
            id: `planner-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            location: { lng: coords.lng, lat: coords.lat },
            type: "via",
          };

          // Track whether we need to break the link (manual start placement on day ≥ 1)
          let breakLink = false;

          if (action === "set-start" || action === "set-new-start") {
            const startIndex = waypoints.findIndex((w) => w.type === "start");
            if (startIndex >= 0) {
              const updated: Waypoint = {
                ...waypoints[startIndex]!,
                location: { lng: coords.lng, lat: coords.lat },
              };
              // A re-placed start is a NEW place: refresh or drop the POI
              // provenance so a stale glyph never survives the move.
              if (meta?.poiCategory) updated.poiCategory = meta.poiCategory;
              else delete updated.poiCategory;
              if (sourceName) {
                updated.name = sourceName;
                updated.nameIsSource = true;
              } else {
                delete updated.name;
                delete updated.nameIsSource;
              }
              waypoints[startIndex] = updated;
            } else {
              waypoints.unshift({
                ...newWaypoint,
                type: "start",
                ...(sourceName ? { name: sourceName, nameIsSource: true } : {}),
                ...(meta?.poiCategory ? { poiCategory: meta.poiCategory } : {}),
              });
            }
            // Manual start placement on a non-first day breaks the overnight link.
            if (idx >= 1) breakLink = true;
          } else if (action === "set-end" || action === "set-new-end") {
            // Setting a new finish overrides the day's CURRENT finish in place —
            // an explicit `end` OR a terminal accommodation (generated
            // overnight) — and demotes any other explicit end to a via. Without
            // this, a `start → accommodation` day keeps the stale overnight and
            // appends a second finish after it.
            const finish = dayFinishWaypoint(waypoints);
            if (finish) {
              const finishIdx = waypoints.indexOf(finish);
              for (let i = 0; i < waypoints.length; i++) {
                if (i !== finishIdx && waypoints[i]!.type === "end") {
                  waypoints[i] = { ...waypoints[i]!, type: "via" };
                }
              }
              const updated: Waypoint = {
                ...finish,
                type: "end",
                location: { lng: coords.lng, lat: coords.lat },
              };
              if (sourceName) {
                updated.name = sourceName;
                updated.nameIsSource = true;
              } else {
                delete updated.name;
                delete updated.nameIsSource;
              }
              if (meta?.poiCategory) updated.poiCategory = meta.poiCategory;
              else delete updated.poiCategory;
              waypoints[finishIdx] = updated;
            } else {
              waypoints.push({
                ...newWaypoint,
                type: "end",
                ...(sourceName ? { name: sourceName, nameIsSource: true } : {}),
                ...(meta?.poiCategory ? { poiCategory: meta.poiCategory } : {}),
              });
            }
          } else {
            // add-via: insert before the day's finish (explicit end OR a
            // terminal accommodation on a generated overnight day), else append.
            const insertAt = viaInsertIndex(waypoints);
            waypoints.splice(insertAt, 0, {
              ...newWaypoint,
              type: "via",
              ...(sourceName ? { name: sourceName, nameIsSource: true } : {}),
              ...(meta?.poiCategory ? { poiCategory: meta.poiCategory } : {}),
            });
          }

          days[idx] = updatePlannerDayRoute(
            breakLink ? { ...day, startLinked: false } : day,
            waypoints,
            baseTrip.parameters,
          );
          // Keep the trip's parameters in sync with the planner controls the
          // rider set before this first placement (mirrors appendPlannerWaypoint)
          // so creating the draft here doesn't reset days/km/avoid options.
          const nextParameters = parameters
            ? mergePlannerParameters(
                baseTrip.parameters,
                parameters,
                days.length,
              )
            : baseTrip.parameters;
          return {
            ...baseTrip,
            days,
            parameters: nextParameters,
            updatedAt: new Date().toISOString(),
          };
        });

        if (committed === state) return state;

        // After writing days[idx], sync the linked start on the next day if applicable.
        // Use state.activeTrip (pre-commit) to determine if this was a draft creation.
        const idx = state.activeTrip === null ? 0 : state.selectedDayIndex;
        return { ...committed, ...applyPostCommitSync(committed, state, idx) };
      }),

    setWaypointType: (waypointId, type) =>
      set((state) => {
        const committed = commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const idx = state.selectedDayIndex;
          const day = activeTrip.days[idx];
          if (!day) return activeTrip;
          const waypointIndex = day.waypoints.findIndex(
            (w) => w.id === waypointId,
          );
          if (waypointIndex < 0) return activeTrip;
          const waypoints = [...day.waypoints];
          waypoints[waypointIndex] = { ...waypoints[waypointIndex]!, type };
          const days = [...activeTrip.days];
          // Promoting a waypoint to `start` on a non-first day is a manual
          // start override — break the overnight link so a later edit to the
          // predecessor's end doesn't silently overwrite the rider's choice
          // (same semantics as placeWaypoint's `breakLink`).
          const breakLink = type === "start" && idx >= 1;
          days[idx] = updatePlannerDayRoute(
            breakLink ? { ...day, startLinked: false } : day,
            waypoints,
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        });

        if (committed === state) return state;

        return {
          ...committed,
          ...applyPostCommitSync(committed, state, state.selectedDayIndex),
        };
      }),

    removeWaypointById: (waypointId) =>
      set((state) => {
        // The map renders every day's pins, so the id may belong to any
        // day — resolve its OWNING day instead of assuming the selected
        // one (a Day 2+ pin removal was a silent no-op otherwise).
        const idx =
          state.activeTrip?.days.findIndex((day) =>
            day.waypoints.some((w) => w.id === waypointId),
          ) ?? -1;
        if (idx < 0) return state;
        const committed = commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[idx];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          days[idx] = updatePlannerDayRoute(
            day,
            // Deleting the start/finish promotes its neighbour (role from index).
            reassignWaypointRoles(
              day.waypoints.filter((w) => w.id !== waypointId),
            ),
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        });

        if (committed === state) return state;

        return {
          ...committed,
          ...applyPostCommitSync(committed, state, idx),
        };
      }),

    routingWaypoints: () => {
      const { activeTrip, selectedDayIndex } = get();
      if (!activeTrip) return [];
      const day = activeTrip.days[selectedDayIndex];
      if (!day) return [];
      return activePlannerRoutingWaypoints(day.waypoints);
    },

    saveWaypoints: () => {
      const {
        activeTrip,
        selectedDayIndex,
        renamedWaypointIds,
        savedWaypointNames,
      } = get();
      if (!activeTrip) return [];
      const day = activeTrip.days[selectedDayIndex];
      if (!day) return [];
      return activePlannerSaveWaypoints(
        day.waypoints,
        plannerWaypointNameContext(
          activeTrip,
          renamedWaypointIds,
          savedWaypointNames,
        ),
      );
    },

    saveDays: () => {
      const { activeTrip, renamedWaypointIds, savedWaypointNames } = get();
      if (!activeTrip) return [];
      const days = activeTrip.days;
      const nameContext = plannerWaypointNameContext(
        activeTrip,
        renamedWaypointIds,
        savedWaypointNames,
      );
      const result: {
        dayNumber: number;
        title: string | null;
        startLinked: boolean;
        waypoints: ReturnType<typeof activePlannerSaveWaypoints>;
      }[] = [];
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (!d || d.waypoints.length === 0) continue; // drop empties
        // A link is only valid if the day's ORIGINAL immediate predecessor
        // survived the empty-day filter (and this isn't the new first day).
        // Otherwise the start was seeded from a dropped day's end and no longer
        // mirrors the new predecessor — persisting startLinked:true would make
        // the map hide its start marker and let a future predecessor-end edit
        // overwrite a start that was never linked to it.
        const predecessor = days[i - 1];
        const predecessorSurvived =
          i > 0 && !!predecessor && predecessor.waypoints.length > 0;
        result.push({
          dayNumber: result.length + 1, // renumber contiguously
          // Send the title with the day so it follows the day through
          // renumbering (the server can't map it back after a removal).
          title:
            // "Day N" is the invariant persisted default, not display copy.
            // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
            d.title?.trim().toLowerCase() === `day ${d.dayNumber}`
              ? null
              : (d.title ?? null),
          startLinked: predecessorSurvived ? (d.startLinked ?? false) : false,
          waypoints: activePlannerSaveWaypoints(
            normalizeDayFinish(d.waypoints),
            nameContext,
          ),
        });
      }
      return result;
    },

    applyRouteResult: (dayNumber, result, legBreaks) =>
      set((state) => {
        const { activeTrip } = state;
        if (!activeTrip) return state;
        const dayIndex = activeTrip.days.findIndex(
          (d) => d.dayNumber === dayNumber,
        );
        if (dayIndex < 0) return state;
        const day = activeTrip.days[dayIndex]!;
        const geometryUnchanged = geometryMatchesPoints(
          day.routeGeometry,
          result.geometry,
        );
        const days = [...activeTrip.days];
        days[dayIndex] = {
          ...day,
          routeGeometry: {
            type: "LineString",
            coordinates: result.geometry.map((p) => [p.lng, p.lat]),
          },
          distanceKm: result.distance_km,
          durationMinutes: result.duration_min,
          avgQuality: result.avg_quality ?? 0,
          elevationGain: result.elevation_gain_m,
          surfaceMix: result.surface_mix,
          // Always overwritten (or cleared) so a stale leg mapping can't
          // outlive the geometry it described. Client-only; never saved.
          legBreaks,
          // Preserve the expensive detailed overlay when a preference change
          // or save re-route returns the exact same polyline. Any vertex change
          // still invalidates it and falls back to no_data until hydration.
          qualitySegments: geometryUnchanged ? day.qualitySegments : undefined,
        };
        return {
          ...state,
          // Geometry now matches the current routing inputs — clear this day's stale flag.
          stalePreviewDays: clearDayStale(state.stalePreviewDays, dayNumber),
          activeTrip: {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          },
        };
      }),

    applyRouteQuality: (dayNumber, forGeometry, segments) =>
      set((state) => {
        const { activeTrip } = state;
        if (!activeTrip) return state;
        const dayIndex = activeTrip.days.findIndex(
          (d) => d.dayNumber === dayNumber,
        );
        if (dayIndex < 0) return state;
        const day = activeTrip.days[dayIndex]!;
        // Only apply while the day's line is still the one quality was computed
        // for — a re-route between the fetch and its resolution must win.
        if (!geometryMatchesPoints(day.routeGeometry, forGeometry))
          return state;
        const days = [...activeTrip.days];
        days[dayIndex] = { ...day, qualitySegments: segments };
        // The rider may have selected a baseline segment (`d{N}-s*`) before
        // quality resolved; real spans reuse the same id pattern, so a stale
        // selection for THIS day would silently resolve to a different span.
        // Clear it — the preview closes and re-clicking selects a real span.
        const staleSelection =
          state.selectedPlannerSegmentId != null &&
          dayNumberFromSegmentId(state.selectedPlannerSegmentId) === dayNumber;
        return {
          ...state,
          ...(staleSelection ? { selectedPlannerSegmentId: null } : {}),
          activeTrip: { ...activeTrip, days },
        };
      }),

    addDay: () =>
      set((state) => {
        const trip = state.activeTrip;
        if (!trip) return state;
        if (trip.days.length >= MAX_TRIP_DAYS) return state;
        const prev = trip.days[trip.days.length - 1];
        // A metadata-only server draft can have zero days (the create/promote
        // path mints the trip before any route day is saved). In that case
        // create day 1 — unlinked, no seeded start — instead of dereferencing
        // a missing predecessor.
        const newDay = createEmptyPlannerDay(prev ? prev.dayNumber + 1 : 1);
        if (prev) {
          // Only mark the new day linked once the predecessor actually has a
          // finish to mirror — an explicit `end` or a terminal accommodation.
          // Linking with no finish leaves an unseeded "linked" start; the next
          // map click would fill it WITHOUT clearing the link, so outside focus
          // the map would suppress it and a later predecessor finish overwrite
          // it. The rider can relink (button is gated the same way) once day N-1
          // has a finish.
          const prevEnd = dayFinishWaypoint(prev.waypoints);
          newDay.startLinked = !!prevEnd;
          if (prevEnd) {
            newDay.waypoints = [
              linkedStartFromFinish(prevEnd, `link-${newDay.dayNumber}`),
            ];
          }
        }
        // Route through commitTripChange so the addition is snapshotted onto
        // the undo stack AND the redo stack is cleared — otherwise a Redo left
        // over from a prior undo could be pressed and drop the new day.
        const committed = commitTripChange(state, (activeTrip) =>
          activeTrip
            ? {
                ...activeTrip,
                days: [...activeTrip.days, newDay],
                updatedAt: new Date().toISOString(),
              }
            : activeTrip,
        );
        return {
          ...committed,
          selectedDayIndex: trip.days.length, // select the new day
          routeDirty: true,
        };
      }),

    removeDay: (index) =>
      set((state) => {
        const trip = state.activeTrip;
        if (!trip || trip.days.length <= 1) return state; // min 1
        const days = trip.days
          .filter((_, i) => i !== index)
          .map((d, i) => {
            const dayNumber = i + 1;
            // Cached quality bakes in the old dayNumber and `dN-s*` segment ids;
            // a renumbered day would point callers that resolve by
            // `segment.dayNumber` (reroute-by-segment) at the wrong day and can
            // collide ids with another day. Drop it on renumber so the fetch
            // effect refills under the new number (#862).
            return d.dayNumber === dayNumber
              ? { ...d, dayNumber }
              : { ...d, dayNumber, qualitySegments: undefined };
          });
        // The new first day has no predecessor to mirror — a dangling
        // `startLinked` would let a future cascade re-seed from nothing, so
        // clear it. (Covers the index===0 removal case the boundary re-eval
        // below skips.)
        if (days[0]?.startLinked) {
          days[0] = { ...days[0], startLinked: false };
        }
        // Remap stale day numbers to the renumbered days: the removed day's
        // number (index + 1) drops out, and any stale day above it shifts down
        // by one. Without this, removing Day 2 while Day 3 is stale leaves an
        // orphaned `3` that no day can clear, wedging the Save gate.
        const stale = state.stalePreviewDays
          .filter((d) => d !== index + 1)
          .map((d) => (d > index + 1 ? d - 1 : d));
        // re-evaluate the boundary at `index`: if the day now at `index` is
        // linked, re-seed from its new predecessor — but only when that
        // predecessor actually has a finish. If it doesn't, the link is no
        // longer valid (syncLinkedStart would no-op and leave startLinked true,
        // hiding the successor's start and letting a later predecessor finish
        // overwrite it), so clear it.
        let result = { days, stale };
        if (index > 0 && index < days.length && days[index]!.startLinked) {
          if (dayFinishWaypoint(days[index - 1]!.waypoints)) {
            result = syncLinkedStart(days, index - 1, stale);
          } else {
            const cleared = [...days];
            cleared[index] = { ...cleared[index]!, startLinked: false };
            result = { days: cleared, stale };
          }
        }
        // Keep the SAME logical day selected: removing a day BEFORE the
        // selected one shifts it down by one. Then clamp into range (e.g. when
        // the selected day itself, or the last day, was removed).
        const shifted =
          index < state.selectedDayIndex
            ? state.selectedDayIndex - 1
            : state.selectedDayIndex;
        const selectedDayIndex = Math.max(
          0,
          Math.min(shifted, result.days.length - 1),
        );
        // Route through commitTripChange so the deletion is snapshotted onto
        // the undo stack (a populated day's waypoints/geometry are otherwise
        // unrecoverable until reload) and canUndo is updated.
        const committed = commitTripChange(state, (activeTrip) =>
          activeTrip
            ? {
                ...activeTrip,
                days: result.days,
                updatedAt: new Date().toISOString(),
              }
            : activeTrip,
        );
        return {
          ...committed,
          stalePreviewDays: result.stale,
          selectedDayIndex,
          routeDirty: true,
        };
      }),

    relinkDayStart: (index) =>
      set((state) => {
        const trip = state.activeTrip;
        if (!trip || index < 1) return state;
        // No predecessor end to mirror → can't form a valid link. Setting
        // startLinked:true would make the map hide this day's start with no
        // shared end drawn, and a later predecessor-finish edit would overwrite
        // the rider's manual start. Leave the link off until day N-1 has a
        // finish — an explicit `end` or a terminal accommodation (overnight).
        const prevEnd = dayFinishWaypoint(
          trip.days[index - 1]?.waypoints ?? [],
        );
        if (!prevEnd) return state;
        const days = trip.days.map((d, i) =>
          i === index ? { ...d, startLinked: true } : d,
        );
        const { days: synced, stale } = syncLinkedStart(
          days,
          index - 1,
          state.stalePreviewDays,
        );
        // Route through commitTripChange so the re-link (which restores the
        // start coordinate to the predecessor's end) is snapshotted onto the
        // undo stack — otherwise Undo can't recover the rider's manual start.
        const committed = commitTripChange(state, (activeTrip) =>
          activeTrip
            ? {
                ...activeTrip,
                days: synced,
                updatedAt: new Date().toISOString(),
              }
            : activeTrip,
        );
        return {
          ...committed,
          stalePreviewDays: stale,
          routeDirty: true,
        };
      }),

    resetForTest: () =>
      set({
        trips: [],
        tripsOwnerId: null,
        activeTrip: null,
        isGenerating: false,
        canUndo: false,
        canRedo: false,
        routeDirty: false,
        namesDirty: false,
        renamedWaypointIds: [],
        savedWaypointNames: {},
        stalePreviewDays: [],
        selectedDayIndex: 0,
        focusedSegmentId: null,
        hoveredSegmentId: null,
        selectedPlannerSegmentId: null,
        planningMode: "single",
        splitStatus: "none",
        dayPlans: null,
        pinnedBreakKms: [],
        undoStack: [],
        redoStack: [],
      }),
  }),
);

/**
 * Returns true when the given day number has a stale route preview (i.e. routing
 * inputs changed since the last `applyRouteResult` for that day). Use this
 * instead of reading `stalePreviewDays` directly to keep the check encapsulated.
 */
export function isDayStale(
  stalePreviewDays: number[],
  dayNumber: number,
): boolean {
  return stalePreviewDays.includes(dayNumber);
}

export function flattenSegments(trip: Trip | null): RoutePreviewSegment[] {
  if (!trip) return [];
  const all: RoutePreviewSegment[] = [];
  for (const day of trip.days) {
    if (!day.segments) continue;
    for (const seg of day.segments) all.push(seg);
  }
  return all;
}

function commitTripChange(
  state: TripState & TripStoreHistory,
  applyChange: (trip: Trip | null) => Trip | null,
): Partial<TripState & TripStoreHistory> | (TripState & TripStoreHistory) {
  const nextTrip = applyChange(state.activeTrip);
  if (!nextTrip || nextTrip === state.activeTrip) return state;
  // Snapshot the PRE-change trip + its dirty flag (the mutating actions set
  // routeDirty:true after this returns, so `state.routeDirty` here is the
  // value to restore on undo).
  const undoStack = trimHistory([
    ...state.undoStack,
    {
      trip: state.activeTrip,
      dirty: state.routeDirty,
      stale: state.stalePreviewDays,
    },
  ]);
  return {
    activeTrip: nextTrip,
    undoStack,
    redoStack: [],
    canUndo: undoStack.length > 0,
    canRedo: false,
    // Any waypoint mutation invalidates a computed split (addendum §3):
    // days dim until the rider explicitly re-splits.
    ...(state.splitStatus === "split"
      ? { splitStatus: "stale" as SplitStatus }
      : {}),
  };
}

function markDayStale(staleDays: number[], dayNumber: number): number[] {
  return staleDays.includes(dayNumber) ? staleDays : [...staleDays, dayNumber];
}

function clearDayStale(staleDays: number[], dayNumber: number): number[] {
  return staleDays.filter((n) => n !== dayNumber);
}

/**
 * Check that a stored day route line is still the exact polyline `points` were
 * derived from — every vertex, not just count + endpoints. Gates a
 * late-resolving route-quality fetch (`applyRouteQuality`) against an
 * intervening re-route that kept the same waypoints but took a different
 * interior path (e.g. a road-preference or avoidance change).
 */
/** Day number embedded in a segment/run id (`d{N}-s*`, `run:d{N}-…`). */
function dayNumberFromSegmentId(id: string): number | null {
  const match = id.replace(/^run:/, "").match(/^d(\d+)/);
  return match ? Number(match[1]) : null;
}

function geometryMatchesPoints(
  geometry: TripDay["routeGeometry"],
  points: ReadonlyArray<{ lat: number; lng: number }>,
): boolean {
  const coords = geometry?.coordinates;
  if (!coords || coords.length !== points.length || points.length === 0) {
    return false;
  }
  for (let index = 0; index < coords.length; index += 1) {
    const coordinate = coords[index]!;
    const point = points[index]!;
    if (coordinate[0] !== point.lng || coordinate[1] !== point.lat) {
      return false;
    }
  }
  return true;
}

function updatePlannerDayRoute(
  day: Trip["days"][number],
  waypoints: Waypoint[],
  _parameters?: Trip["parameters"],
): Trip["days"][number] {
  // Geometry is driven exclusively by applyRouteResult (live routing hook).
  // We never synthesize geometry here — just update the waypoint list and
  // leave the existing routeGeometry in place until the hook recomputes it...
  // UNLESS the set is no longer routable (<2 routing waypoints): the live hook
  // returns early without calling applyRouteResult, so we must clear the stale
  // route-derived fields here or the map/sidebar keep showing the old route.
  // Normalize a terminal accommodation first so a generated overnight day
  // (start + accommodation) counts as routable and keeps its geometry.
  if (filterRoutingWaypoints(normalizeDayFinish(waypoints)).length < 2) {
    const cleared: Trip["days"][number] = {
      ...day,
      waypoints,
      distanceKm: 0,
      durationMinutes: 0,
      avgQuality: 0,
      elevationGain: 0,
      segments: [],
      // Route-derived per-segment quality goes with the line it described (#862).
      qualitySegments: undefined,
    };
    // Clear any route-derived geometry: the live routing hook bails for <2
    // routing waypoints, so it won't recompute this day — drop the stale line.
    delete cleared.routeGeometry;
    return cleared;
  }
  return { ...day, waypoints };
}

function trimHistory(
  history: Array<TripHistoryEntry>,
): Array<TripHistoryEntry> {
  if (history.length <= MAX_HISTORY_ENTRIES) return history;
  return history.slice(history.length - MAX_HISTORY_ENTRIES);
}

function mergePlannerParameters(
  existing: Trip["parameters"],
  next: Trip["parameters"] | undefined,
  dayCount: number,
): Trip["parameters"] {
  if (!next) return { ...existing, days: dayCount };
  return {
    ...next,
    days: Math.max(next.days, dayCount),
  };
}

// ── Split materialization helpers (addendum §4) ──────────────────────────────

function cumulativeKm(coordinates: GeoJSONPosition[]): number[] {
  const kms: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [lng1, lat1] = coordinates[i - 1] ?? [];
    const [lng2, lat2] = coordinates[i] ?? [];
    const step =
      typeof lng1 === "number" &&
      typeof lat1 === "number" &&
      typeof lng2 === "number" &&
      typeof lat2 === "number"
        ? haversineKm(lat1, lng1, lat2, lng2)
        : 0;
    kms.push((kms[i - 1] ?? 0) + step);
  }
  return kms;
}

function nearestVertexKm(
  coordinates: GeoJSONPosition[],
  kmAt: number[],
  location: { lat: number; lng: number },
): number {
  let bestKm = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coordinates.length; i += 1) {
    const [lng, lat] = coordinates[i] ?? [];
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    const distance = haversineKm(lat, lng, location.lat, location.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKm = kmAt[i] ?? 0;
    }
  }
  return bestKm;
}

/**
 * The exact coordinate at `km` along the line — the vertex when one sits
 * there, linearly interpolated inside its segment otherwise.
 */
function pointAtKm(
  coordinates: GeoJSONPosition[],
  kmAt: number[],
  km: number,
): GeoJSONPosition | null {
  for (let i = 0; i < kmAt.length - 1; i += 1) {
    const k0 = kmAt[i] ?? 0;
    const k1 = kmAt[i + 1] ?? 0;
    if (km < k0 || km > k1 || k1 <= k0) continue;
    const [lng0, lat0] = coordinates[i] ?? [];
    const [lng1, lat1] = coordinates[i + 1] ?? [];
    if (
      typeof lng0 !== "number" ||
      typeof lat0 !== "number" ||
      typeof lng1 !== "number" ||
      typeof lat1 !== "number"
    ) {
      continue;
    }
    const t = (km - k0) / (k1 - k0);
    return [lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t];
  }
  return null;
}

function sliceCoordinatesByKm(
  coordinates: GeoJSONPosition[],
  kmAt: number[],
  fromKm: number,
  toKm: number,
): GeoJSONPosition[] {
  // Interpolated endpoints: a break usually falls BETWEEN vertices, and
  // dropping to the nearest one would leave a gap between consecutive
  // days' geometry (and their start/end waypoints). Both neighbours slice
  // at the same km, so they share the exact boundary coordinate.
  const startPoint = pointAtKm(coordinates, kmAt, fromKm);
  const endPoint = pointAtKm(coordinates, kmAt, toKm);
  const interior = coordinates.filter((_, index) => {
    const km = kmAt[index] ?? 0;
    return km > fromKm && km < toKm;
  });
  const sliced = [
    ...(startPoint ? [startPoint] : []),
    ...interior,
    ...(endPoint ? [endPoint] : []),
  ];
  return sliced.length >= 2
    ? sliced
    : coordinates.slice(0, Math.min(2, coordinates.length));
}

/**
 * Display DayPlans for a trip loaded WITH days (saved multi-day trips):
 * the day column shows them as an existing split. Segment/stay detail
 * isn't reconstructed — only what the column renders.
 */
function dayPlansFromTripDays(days: TripDay[]): DayPlan[] {
  let endKm = 0;
  return days.map((day) => {
    endKm += day.distanceKm;
    const start = day.waypoints.find((w) => w.type === "start");
    const finish = dayFinishWaypoint(day.waypoints);
    const startName = start?.name;
    const finishName = finish?.name;
    return {
      dayNumber: day.dayNumber,
      segmentIds: [],
      distanceKm: day.distanceKm,
      timeMin: day.durationMinutes,
      quality: {
        distanceKm: day.distanceKm,
        timeMin: day.durationMinutes,
        score: day.avgQuality || null,
        surfaceMix: [],
        flagged: [],
      },
      startTown: startName ?? "",
      endTown: finishName ?? "",
      ...(startName?.trim() ? { startNameIsSource: true } : {}),
      ...(finishName?.trim() ? { endNameIsSource: true } : {}),
      ...(start?.poiCategory ? { startPoiCategory: start.poiCategory } : {}),
      ...(finish?.poiCategory ? { endPoiCategory: finish.poiCategory } : {}),
      suggestedStays: [],
      endKm: Math.round(endKm * 10) / 10,
    };
  });
}
