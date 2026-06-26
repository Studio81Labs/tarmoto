import { create } from "zustand";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import type { RouteResponse } from "@/lib/api";
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
    title: `Day ${dayNumber}`,
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
    name: "New Trip",
    status: "draft",
    num_days: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    parameters: { ...parameters },
    collaborators: [{ userId: "u-owner", displayName: "You", role: "owner" }],
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
  const endIndex = waypoints.findIndex((w) => w.type === "end");

  if (waypoints.length === 0) {
    waypoints.push({ id, name: "Start", location, type: "start" });
  } else if (endIndex === -1) {
    waypoints.push({ id, name: "Finish", location, type: "end" });
  } else {
    const viaCount =
      waypoints.filter(
        (w) =>
          w.type === "via" ||
          w.type === "fuel" ||
          w.type === "rest" ||
          w.type === "photo" ||
          w.type === "accommodation",
      ).length + 1;
    waypoints.splice(endIndex, 0, {
      id,
      name: `Via ${viaCount}`,
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

  setTrips: (trips: TripSummary[], ownerId?: string | null) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (generating: boolean) => void;
  /** Set routeDirty to true. Called by user-facing controls that change routing inputs. */
  markRouteDirty: () => void;
  /** Mirror the planner controls' parameters for context-menu draft creation. */
  setDraftPlannerParameters: (parameters: TripParameters) => void;

  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;

  // Waypoint management
  addWaypoint: (dayIndex: number, waypoint: Waypoint) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    location: { lng: number; lat: number },
    parameters?: Trip["parameters"],
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: Waypoint) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
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
  ) => void;

  /**
   * Change the type of a waypoint on the active planner day (day 0).
   */
  setWaypointType: (waypointId: string, type: Waypoint["type"]) => void;

  /**
   * Remove a waypoint by id from the active planner day (day 0).
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
    name?: string;
    type: BackendWaypointType;
  }[];

  /**
   * Write server-side route geometry + stats into the active planner day.
   * Geometry now ONLY comes from this action — synthetic rebuild is no
   * longer invoked by the placeWaypoint path.
   */
  applyRouteResult: (result: RouteResponse) => void;

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
  | "start"
  | "via"
  | "end"
  | "fuel"
  | "food"
  | "coffee"
  | "hotel"
  | "photo";

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

function activePlannerSaveWaypoints(
  waypoints: Waypoint[],
): { lat: number; lng: number; name?: string; type: BackendWaypointType }[] {
  return waypoints.map((w) => ({
    lat: w.location.lat,
    lng: w.location.lng,
    name: w.name,
    type: LOCAL_TO_BACKEND_WAYPOINT_TYPE[w.type] ?? "via",
  }));
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
    draftPlannerParameters: null,
    focusedSegmentId: null,
    hoveredSegmentId: null,
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
        focusedSegmentId: null,
        hoveredSegmentId: null,
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      }),
    setGenerating: (isGenerating) => set({ isGenerating }),
    markRouteDirty: () => set({ routeDirty: true }),
    setDraftPlannerParameters: (parameters) =>
      set({ draftPlannerParameters: parameters }),

    focusSegment: (segmentId) => set({ focusedSegmentId: segmentId }),
    hoverSegment: (segmentId) => set({ hoveredSegmentId: segmentId }),

    addWaypoint: (dayIndex, waypoint) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
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
        }),
        // Adding a waypoint (e.g. a suggested overnight stay from
        // TripStopsPanel) is a route edit — mark dirty so Save route enables.
        routeDirty: true,
      })),

    appendPlannerWaypoint: (dayIndex, location, parameters) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
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
        }),
        routeDirty: true,
      })),

    insertWaypointBeforeEnd: (dayIndex, waypoint) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[dayIndex];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          const waypoints = [...day.waypoints];
          const endIndex = waypoints.findIndex(
            (existing) => existing.type === "end",
          );
          const insertionIndex = endIndex >= 0 ? endIndex : waypoints.length;
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
        routeDirty: true,
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
            day.waypoints.filter((w) => w.id !== waypointId),
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
          days[dayIndex] = updatePlannerDayRoute(
            day,
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
        // return the same state reference from commitTripChange).
        if (result === state) return state;
        return { ...result, routeDirty: true };
      }),

    reorderWaypoints: (dayIndex, fromIndex, toIndex) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
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
            waypoints,
            activeTrip.parameters,
          );
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
        routeDirty: true,
      })),

    undo: () =>
      set((state) => {
        if (state.undoStack.length === 0) return state;
        const previous = state.undoStack[state.undoStack.length - 1]!;
        const undoStack = state.undoStack.slice(0, -1);
        const redoStack = trimHistory([
          ...state.redoStack,
          { trip: state.activeTrip, dirty: state.routeDirty },
        ]);
        return {
          activeTrip: previous.trip,
          // Restore the dirty flag captured with this snapshot so undoing back
          // to the loaded route also clears routeDirty (re-disabling Save).
          routeDirty: previous.dirty,
          focusedSegmentId: null,
          hoveredSegmentId: null,
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
          { trip: state.activeTrip, dirty: state.routeDirty },
        ]);
        return {
          activeTrip: next.trip,
          routeDirty: next.dirty,
          focusedSegmentId: null,
          hoveredSegmentId: null,
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
        };
      }),

    // ── Task 9: server-driven route geometry + context-menu waypoint actions ──

    placeWaypoint: (coords, action, parameters) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          const baseTrip =
            activeTrip ??
            createPlannerDraftTrip(new Date().toISOString(), parameters);
          const days = ensurePlannerDays(baseTrip.days, 1);
          const day = days[0]!;
          const waypoints = [...day.waypoints];

          const newWaypoint: Waypoint = {
            id: `planner-0-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            location: { lng: coords.lng, lat: coords.lat },
            type: "via",
          };

          if (action === "set-start" || action === "set-new-start") {
            const startIndex = waypoints.findIndex((w) => w.type === "start");
            if (startIndex >= 0) {
              waypoints[startIndex] = {
                ...waypoints[startIndex]!,
                location: { lng: coords.lng, lat: coords.lat },
              };
            } else {
              waypoints.unshift({
                ...newWaypoint,
                type: "start",
                name: "Start",
              });
            }
          } else if (action === "set-end" || action === "set-new-end") {
            const endIndex = waypoints.findIndex((w) => w.type === "end");
            if (endIndex >= 0) {
              waypoints[endIndex] = {
                ...waypoints[endIndex]!,
                location: { lng: coords.lng, lat: coords.lat },
              };
            } else {
              waypoints.push({ ...newWaypoint, type: "end", name: "Finish" });
            }
          } else {
            // add-via: insert before end, or append if no end
            const endIndex = waypoints.findIndex((w) => w.type === "end");
            const insertAt = endIndex >= 0 ? endIndex : waypoints.length;
            waypoints.splice(insertAt, 0, { ...newWaypoint, type: "via" });
          }

          days[0] = { ...day, waypoints };
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
        }),
        routeDirty: true,
      })),

    setWaypointType: (waypointId, type) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[0];
          if (!day) return activeTrip;
          const waypointIndex = day.waypoints.findIndex(
            (w) => w.id === waypointId,
          );
          if (waypointIndex < 0) return activeTrip;
          const waypoints = [...day.waypoints];
          waypoints[waypointIndex] = { ...waypoints[waypointIndex]!, type };
          const days = [...activeTrip.days];
          days[0] = { ...day, waypoints };
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
        routeDirty: true,
      })),

    removeWaypointById: (waypointId) =>
      set((state) => ({
        ...commitTripChange(state, (activeTrip) => {
          if (!activeTrip) return activeTrip;
          const day = activeTrip.days[0];
          if (!day) return activeTrip;
          const days = [...activeTrip.days];
          days[0] = {
            ...day,
            waypoints: day.waypoints.filter((w) => w.id !== waypointId),
          };
          return {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
        routeDirty: true,
      })),

    routingWaypoints: () => {
      const { activeTrip } = get();
      if (!activeTrip) return [];
      const day = activeTrip.days[0];
      if (!day) return [];
      return activePlannerRoutingWaypoints(day.waypoints);
    },

    saveWaypoints: () => {
      const { activeTrip } = get();
      if (!activeTrip) return [];
      const day = activeTrip.days[0];
      if (!day) return [];
      return activePlannerSaveWaypoints(day.waypoints);
    },

    applyRouteResult: (result) =>
      set((state) => {
        const { activeTrip } = state;
        if (!activeTrip) return state;
        const day = activeTrip.days[0];
        if (!day) return state;
        const days = [...activeTrip.days];
        days[0] = {
          ...day,
          routeGeometry: {
            type: "LineString",
            coordinates: result.geometry.map((p) => [p.lng, p.lat]),
          },
          distanceKm: result.distance_km,
          durationMinutes: result.duration_min,
          avgQuality: result.avg_quality ?? 0,
          elevationGain: result.elevation_gain_m,
        };
        return {
          ...state,
          activeTrip: {
            ...activeTrip,
            days,
            updatedAt: new Date().toISOString(),
          },
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
        focusedSegmentId: null,
        hoveredSegmentId: null,
        undoStack: [],
        redoStack: [],
      }),
  }),
);

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
    { trip: state.activeTrip, dirty: state.routeDirty },
  ]);
  return {
    activeTrip: nextTrip,
    undoStack,
    redoStack: [],
    canUndo: undoStack.length > 0,
    canRedo: false,
  };
}

function updatePlannerDayRoute(
  day: Trip["days"][number],
  waypoints: Waypoint[],
  _parameters: Trip["parameters"],
) {
  // Geometry is driven exclusively by applyRouteResult (live routing hook).
  // We never synthesize geometry here — just update the waypoint list and
  // leave the existing routeGeometry in place until the hook recomputes it.
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
