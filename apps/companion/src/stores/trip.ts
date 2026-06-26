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

  // Sidebar focus state consumed by the map layer (#79) and the
  // RoadPreviewCard components in the planner sidebar (US-33).
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;

  setTrips: (trips: TripSummary[], ownerId?: string | null) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (generating: boolean) => void;

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
   * Ordered typed waypoints for the save payload.
   */
  saveWaypoints: () => {
    lat: number;
    lng: number;
    name?: string;
    type: Waypoint["type"];
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

interface TripStoreHistory {
  undoStack: Array<Trip | null>;
  redoStack: Array<Trip | null>;
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

function activePlannerSaveWaypoints(
  waypoints: Waypoint[],
): { lat: number; lng: number; name?: string; type: Waypoint["type"] }[] {
  return waypoints.map((w) => ({
    lat: w.location.lat,
    lng: w.location.lng,
    name: w.name,
    type: w.type,
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
        focusedSegmentId: null,
        hoveredSegmentId: null,
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      }),
    setGenerating: (isGenerating) => set({ isGenerating }),

    focusSegment: (segmentId) => set({ focusedSegmentId: segmentId }),
    hoverSegment: (segmentId) => set({ hoveredSegmentId: segmentId }),

    addWaypoint: (dayIndex, waypoint) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

    appendPlannerWaypoint: (dayIndex, location, parameters) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

    insertWaypointBeforeEnd: (dayIndex, waypoint) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

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
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
        }),
      ),

    reorderWaypoints: (dayIndex, fromIndex, toIndex) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

    undo: () =>
      set((state) => {
        if (state.undoStack.length === 0) return state;
        const previous = state.undoStack[state.undoStack.length - 1] ?? null;
        const undoStack = state.undoStack.slice(0, -1);
        const redoStack = trimHistory([...state.redoStack, state.activeTrip]);
        return {
          activeTrip: previous,
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
        const next = state.redoStack[state.redoStack.length - 1] ?? null;
        const redoStack = state.redoStack.slice(0, -1);
        const undoStack = trimHistory([...state.undoStack, state.activeTrip]);
        return {
          activeTrip: next,
          focusedSegmentId: null,
          hoveredSegmentId: null,
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
        };
      }),

    // ── Task 9: server-driven route geometry + context-menu waypoint actions ──

    placeWaypoint: (coords, action) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
          const baseTrip =
            activeTrip ?? createPlannerDraftTrip(new Date().toISOString());
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
          return {
            ...baseTrip,
            days,
            updatedAt: new Date().toISOString(),
          };
        }),
      ),

    setWaypointType: (waypointId, type) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

    removeWaypointById: (waypointId) =>
      set((state) =>
        commitTripChange(state, (activeTrip) => {
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
      ),

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
  const undoStack = trimHistory([...state.undoStack, state.activeTrip]);
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

function trimHistory(history: Array<Trip | null>): Array<Trip | null> {
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
