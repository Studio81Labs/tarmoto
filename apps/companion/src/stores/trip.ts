import { create } from 'zustand';
import type { Trip, Waypoint } from '@/lib/types';

interface TripState {
  trips: Trip[];
  activeTrip: Trip | null;
  isGenerating: boolean;

  setTrips: (trips: Trip[]) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (generating: boolean) => void;

  // Waypoint management
  addWaypoint: (dayIndex: number, waypoint: Waypoint) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  reorderWaypoints: (dayIndex: number, fromIndex: number, toIndex: number) => void;
}

export const useTripStore = create<TripState>((set) => ({
  trips: [],
  activeTrip: null,
  isGenerating: false,

  setTrips: (trips) => set({ trips }),
  setActiveTrip: (activeTrip) => set({ activeTrip }),
  setGenerating: (isGenerating) => set({ isGenerating }),

  addWaypoint: (dayIndex, waypoint) =>
    set((state) => {
      if (!state.activeTrip) return state;
      const day = state.activeTrip.days[dayIndex];
      if (!day) return state;
      const days = [...state.activeTrip.days];
      days[dayIndex] = { ...day, waypoints: [...day.waypoints, waypoint] };
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
