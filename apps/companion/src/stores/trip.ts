import { create } from "zustand";
import type { RoutePreviewSegment, Trip, Waypoint } from "@/lib/types";

interface TripState {
  trips: Trip[];
  activeTrip: Trip | null;
  isGenerating: boolean;

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
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: Waypoint) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  reorderWaypoints: (
    dayIndex: number,
    fromIndex: number,
    toIndex: number,
  ) => void;
}

export const useTripStore = create<TripState>((set) => ({
  trips: [],
  activeTrip: null,
  isGenerating: false,
  focusedSegmentId: null,
  hoveredSegmentId: null,

  setTrips: (trips) => set({ trips }),
  setActiveTrip: (activeTrip) =>
    set({ activeTrip, focusedSegmentId: null, hoveredSegmentId: null }),
  setGenerating: (isGenerating) => set({ isGenerating }),

  focusSegment: (segmentId) => set({ focusedSegmentId: segmentId }),
  hoverSegment: (segmentId) => set({ hoveredSegmentId: segmentId }),

  addWaypoint: (dayIndex, waypoint) =>
    set((state) => {
      if (!state.activeTrip) return state;
      const day = state.activeTrip.days[dayIndex];
      if (!day) return state;
      const days = [...state.activeTrip.days];
      days[dayIndex] = { ...day, waypoints: [...day.waypoints, waypoint] };
      return { activeTrip: { ...state.activeTrip, days } };
    }),

  insertWaypointBeforeEnd: (dayIndex, waypoint) =>
    set((state) => {
      if (!state.activeTrip) return state;
      const day = state.activeTrip.days[dayIndex];
      if (!day) return state;
      const days = [...state.activeTrip.days];
      const waypoints = [...day.waypoints];
      const endIndex = waypoints.findIndex(
        (existing) => existing.type === "end",
      );
      const insertionIndex = endIndex >= 0 ? endIndex : waypoints.length;
      waypoints.splice(insertionIndex, 0, waypoint);
      days[dayIndex] = { ...day, waypoints };
      return { activeTrip: { ...state.activeTrip, days } };
    }),

  removeWaypoint: (dayIndex, waypointId) =>
    set((state) => {
      if (!state.activeTrip) return state;
      const day = state.activeTrip.days[dayIndex];
      if (!day) return state;
      const days = [...state.activeTrip.days];
      days[dayIndex] = {
        ...day,
        waypoints: day.waypoints.filter((w) => w.id !== waypointId),
      };
      return { activeTrip: { ...state.activeTrip, days } };
    }),

  reorderWaypoints: (dayIndex, fromIndex, toIndex) =>
    set((state) => {
      if (!state.activeTrip) return state;
      const day = state.activeTrip.days[dayIndex];
      if (!day) return state;
      const days = [...state.activeTrip.days];
      const waypoints = [...day.waypoints];
      const moved = waypoints[fromIndex];
      if (!moved) return state;
      waypoints.splice(fromIndex, 1);
      waypoints.splice(toIndex, 0, moved);
      days[dayIndex] = { ...day, waypoints };
      return { activeTrip: { ...state.activeTrip, days } };
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
