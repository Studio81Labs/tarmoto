import { create } from "zustand";
import {
  appendPlannerWaypointToDay,
  createPlannerDraftTrip,
  ensurePlannerDays,
  rebuildPlannerDay,
} from "@/lib/trip-planner-builder";
import type { RoutePreviewSegment, Trip, Waypoint } from "@/lib/types";

interface TripState {
  trips: Trip[];
  activeTrip: Trip | null;
  isGenerating: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // Sidebar focus state consumed by the map layer (#79) and the
  // RoadPreviewCard components in the planner sidebar (US-33).
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;

  setTrips: (trips: Trip[]) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (generating: boolean) => void;

  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;

  // Waypoint management
  addWaypoint: (dayIndex: number, waypoint: Waypoint) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    location: { lng: number; lat: number },
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: Waypoint) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  reorderWaypoints: (
    dayIndex: number,
    fromIndex: number,
    toIndex: number,
  ) => void;
  undo: () => void;
  redo: () => void;
}

interface TripStoreHistory {
  undoStack: Array<Trip | null>;
  redoStack: Array<Trip | null>;
}

export const useTripStore = create<TripState & TripStoreHistory>((set) => ({
  trips: [],
  activeTrip: null,
  isGenerating: false,
  canUndo: false,
  canRedo: false,
  focusedSegmentId: null,
  hoveredSegmentId: null,
  undoStack: [],
  redoStack: [],

  setTrips: (trips) => set({ trips }),
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
        days[dayIndex] = rebuildPlannerDay(
          { ...day, waypoints: [...day.waypoints, waypoint] },
          activeTrip.parameters,
        );
        return {
          ...activeTrip,
          days,
          updatedAt: new Date().toISOString(),
        };
      }),
    ),

  appendPlannerWaypoint: (dayIndex, location) =>
    set((state) =>
      commitTripChange(state, (activeTrip) => {
        const baseTrip =
          activeTrip ?? createPlannerDraftTrip(new Date().toISOString());
        const days = ensurePlannerDays(baseTrip.days, dayIndex + 1);
        const day = days[dayIndex]!;
        days[dayIndex] = rebuildPlannerDay(
          appendPlannerWaypointToDay(day, location),
          baseTrip.parameters,
        );
        return {
          ...baseTrip,
          days,
          parameters: { ...baseTrip.parameters, days: days.length },
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
        days[dayIndex] = rebuildPlannerDay(
          { ...day, waypoints },
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
        days[dayIndex] = rebuildPlannerDay(
          {
            ...day,
            waypoints: day.waypoints.filter((w) => w.id !== waypointId),
          },
          activeTrip.parameters,
        );
        return {
          ...activeTrip,
          days,
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
        days[dayIndex] = rebuildPlannerDay(
          { ...day, waypoints },
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
      const previous = state.undoStack[state.undoStack.length - 1];
      if (previous === undefined) return state;
      const undoStack = state.undoStack.slice(0, -1);
      const redoStack = [...state.redoStack, state.activeTrip];
      return {
        activeTrip: previous,
        undoStack,
        redoStack,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      };
    }),

  redo: () =>
    set((state) => {
      const next = state.redoStack[state.redoStack.length - 1];
      if (next === undefined) return state;
      const redoStack = state.redoStack.slice(0, -1);
      const undoStack = [...state.undoStack, state.activeTrip];
      return {
        activeTrip: next,
        undoStack,
        redoStack,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      };
    }),
}));

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
  const undoStack = [...state.undoStack, state.activeTrip];
  return {
    activeTrip: nextTrip,
    undoStack,
    redoStack: [],
    canUndo: undoStack.length > 0,
    canRedo: false,
  };
}
