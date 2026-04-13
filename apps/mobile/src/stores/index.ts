/**
 * Tarmoto State Stores (Zustand)
 */

import { create } from 'zustand';
import type {
  User, RideSummary, RideDetail, Hazard, Trip, CommuteRoute,
  LatLng, QualityClass, SurfaceType,
} from '@/types';
import type { ClassificationResult, WindowFeatures } from '@/services/sensors';
import type { LocationUpdate } from '@/services/location';

// ── Auth Store ──

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  setUser: (user) => set({ user, isAuthenticated: !!user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  logout: () => set({ user: null, isAuthenticated: false }),
}));

// ── Ride Store ──

interface RideState {
  // Active ride
  activeRide: RideDetail | null;
  isRiding: boolean;
  rideType: 'free' | 'commute' | 'trip';

  // Live data
  currentSpeed: number;
  currentQuality: ClassificationResult | null;
  location: LocationUpdate | null;
  distance: number;
  duration: number; // seconds
  segmentCount: number;

  // Actions
  startRide: (type?: 'free' | 'commute' | 'trip') => void;
  stopRide: () => void;
  updateSpeed: (speed: number) => void;
  updateQuality: (quality: ClassificationResult) => void;
  updateLocation: (location: LocationUpdate) => void;
  updateDistance: (distance: number) => void;
  updateDuration: (duration: number) => void;
  incrementSegments: () => void;

  // History
  recentRides: RideSummary[];
  setRecentRides: (rides: RideSummary[]) => void;
}

export const useRideStore = create<RideState>((set) => ({
  activeRide: null,
  isRiding: false,
  rideType: 'free',
  currentSpeed: 0,
  currentQuality: null,
  location: null,
  distance: 0,
  duration: 0,
  segmentCount: 0,
  recentRides: [],

  startRide: (type = 'free') => set({
    isRiding: true,
    rideType: type,
    distance: 0,
    duration: 0,
    segmentCount: 0,
    currentQuality: null,
  }),
  stopRide: () => set({
    isRiding: false,
    activeRide: null,
    currentQuality: null,
    currentSpeed: 0,
  }),
  updateSpeed: (currentSpeed) => set({ currentSpeed }),
  updateQuality: (currentQuality) => set({ currentQuality }),
  updateLocation: (location) => set({ location }),
  updateDistance: (distance) => set({ distance }),
  updateDuration: (duration) => set({ duration }),
  incrementSegments: () => set((s) => ({ segmentCount: s.segmentCount + 1 })),
  setRecentRides: (recentRides) => set({ recentRides }),
}));

// ── Hazard Store ──

interface HazardState {
  nearbyHazards: Hazard[];
  routeHazards: Hazard[];
  setNearbyHazards: (hazards: Hazard[]) => void;
  setRouteHazards: (hazards: Hazard[]) => void;
  addHazard: (hazard: Hazard) => void;
  removeHazard: (id: string) => void;
}

export const useHazardStore = create<HazardState>((set) => ({
  nearbyHazards: [],
  routeHazards: [],
  setNearbyHazards: (nearbyHazards) => set({ nearbyHazards }),
  setRouteHazards: (routeHazards) => set({ routeHazards }),
  addHazard: (hazard) => set((s) => ({ nearbyHazards: [hazard, ...s.nearbyHazards] })),
  removeHazard: (id) => set((s) => ({
    nearbyHazards: s.nearbyHazards.filter((h) => h.id !== id),
  })),
}));

// ── Trip Store ──

interface TripState {
  trips: Trip[];
  activeTrip: Trip | null;
  setTrips: (trips: Trip[]) => void;
  setActiveTrip: (trip: Trip | null) => void;
}

export const useTripStore = create<TripState>((set) => ({
  trips: [],
  activeTrip: null,
  setTrips: (trips) => set({ trips }),
  setActiveTrip: (activeTrip) => set({ activeTrip }),
}));

// ── Map Store ──

interface MapState {
  center: LatLng;
  zoom: number;
  showQualityOverlay: boolean;
  showSurfaceOverlay: boolean;
  showHazardOverlay: boolean;
  setCenter: (center: LatLng) => void;
  setZoom: (zoom: number) => void;
  toggleQuality: () => void;
  toggleSurface: () => void;
  toggleHazards: () => void;
}

export const useMapStore = create<MapState>((set) => ({
  center: { lat: 49.82, lng: 18.26 }, // Ostrava default
  zoom: 12,
  showQualityOverlay: true,
  showSurfaceOverlay: false,
  showHazardOverlay: true,
  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  toggleQuality: () => set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleSurface: () => set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  toggleHazards: () => set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
}));
