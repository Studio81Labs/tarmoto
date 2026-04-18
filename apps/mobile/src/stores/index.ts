/**
 * Tarmoto State Stores (Zustand)
 */

import { create } from "zustand";
import type {
  User,
  RideSummary,
  RideDetail,
  Hazard,
  Trip,
  CommuteRoute,
  LatLng,
  QualityClass,
  SurfaceType,
} from "@/types";
import type { ClassificationResult, WindowFeatures } from "@/services/sensors";
import type { LocationUpdate } from "@/services/location";
import { MIN_QUALITY_BOUNDS } from "@/theme";

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
  rideType: "free" | "commute" | "trip";

  // Live data
  currentSpeed: number;
  currentQuality: ClassificationResult | null;
  location: LocationUpdate | null;
  distance: number;
  duration: number; // seconds
  segmentCount: number;

  // Actions
  startRide: (type?: "free" | "commute" | "trip") => void;
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
  rideType: "free",
  currentSpeed: 0,
  currentQuality: null,
  location: null,
  distance: 0,
  duration: 0,
  segmentCount: 0,
  recentRides: [],

  startRide: (type = "free") =>
    set({
      isRiding: true,
      rideType: type,
      distance: 0,
      duration: 0,
      segmentCount: 0,
      currentQuality: null,
    }),
  stopRide: () =>
    set({
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
  addHazard: (hazard) =>
    set((s) => ({ nearbyHazards: [hazard, ...s.nearbyHazards] })),
  removeHazard: (id) =>
    set((s) => ({
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
  toggleQuality: () =>
    set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleSurface: () =>
    set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  toggleHazards: () =>
    set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
}));

// ── Preferences Store ──
// Rider-level preferences that shape what gets surfaced in planning and
// rides. Currently scoped to the US-5 minimum-quality filter; other
// preferences will land here as they ship.
//
// Persistence uses MMKV when available (device). In Jest the native module
// isn't linked, so the guarded require falls back to an in-memory shim —
// tests can freely reset state without touching disk.

const PREFS_STORAGE_ID = "tarmoto-prefs";
const MIN_QUALITY_KEY = "minQuality";
const DEFAULT_MIN_QUALITY = 3; // "Fair or better" — matches UserPreferences default

interface PrefsStorage {
  getNumber(key: string): number | undefined;
  set(key: string, value: number): void;
}

function createPrefsStorage(): PrefsStorage {
  try {
    // Lazy require so the store module stays importable in environments
    // without the native MMKV binding (e.g. jest).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: PREFS_STORAGE_ID });
    return {
      getNumber: (key) => mmkv.getNumber(key),
      set: (key, value) => mmkv.set(key, value),
    };
  } catch {
    const memory = new Map<string, number>();
    return {
      getNumber: (key) => memory.get(key),
      set: (key, value) => {
        memory.set(key, value);
      },
    };
  }
}

const prefsStorage = createPrefsStorage();

function clampMinQuality(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_QUALITY;
  const rounded = Math.round(value);
  return Math.max(
    MIN_QUALITY_BOUNDS.min,
    Math.min(MIN_QUALITY_BOUNDS.max, rounded),
  );
}

function loadPersistedMinQuality(): number {
  const raw = prefsStorage.getNumber(MIN_QUALITY_KEY);
  if (raw === undefined) return DEFAULT_MIN_QUALITY;
  return clampMinQuality(raw);
}

interface PreferencesState {
  /** Minimum road quality (1..5) the rider wants to see in planning. */
  minQuality: number;
  setMinQuality: (value: number) => void;
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  minQuality: loadPersistedMinQuality(),
  setMinQuality: (value) => {
    const clamped = clampMinQuality(value);
    prefsStorage.set(MIN_QUALITY_KEY, clamped);
    set({ minQuality: clamped });
  },
  resetPreferences: () => {
    prefsStorage.set(MIN_QUALITY_KEY, DEFAULT_MIN_QUALITY);
    set({ minQuality: DEFAULT_MIN_QUALITY });
  },
}));

export const PREFERENCES_DEFAULTS = {
  minQuality: DEFAULT_MIN_QUALITY,
} as const;

// ── Commute Store ──
// Per-route snapshot of hazard IDs the rider has already seen, used by
// US-15 to flag which hazards are NEW since their last check.
//
// We store the set as a comma-joined string (MMKV has no array primitive
// and strings dedupe free). The shim fallback keeps tests hermetic.

const COMMUTE_STORAGE_ID = "tarmoto-commute";
const SEEN_KEY_PREFIX = "seenHazards:";

interface CommuteStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function createCommuteStorage(): CommuteStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: COMMUTE_STORAGE_ID });
    return {
      getString: (key) => mmkv.getString(key),
      set: (key, value) => mmkv.set(key, value),
      remove: (key) => {
        mmkv.remove(key);
      },
    };
  } catch {
    const memory = new Map<string, string>();
    return {
      getString: (key) => memory.get(key),
      set: (key, value) => {
        memory.set(key, value);
      },
      remove: (key) => {
        memory.delete(key);
      },
    };
  }
}

const commuteStorage = createCommuteStorage();

function seenKey(routeId: string): string {
  return `${SEEN_KEY_PREFIX}${routeId}`;
}

function decodeSeen(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").filter(Boolean));
}

function encodeSeen(ids: Iterable<string>): string {
  return Array.from(new Set(ids)).join(",");
}

interface CommuteState {
  /** Map of routeId → set of hazard IDs last acknowledged by the rider. */
  seenHazardsByRoute: Record<string, Set<string>>;
  /** Return the hazard IDs last acknowledged on this route. */
  getSeenHazards: (routeId: string) => Set<string>;
  /** Mark the given hazard IDs as seen on this route, replacing prior set. */
  markHazardsSeen: (routeId: string, hazardIds: string[]) => void;
  /** Forget the snapshot for one route (e.g. route deleted server-side). */
  clearRoute: (routeId: string) => void;
}

export const useCommuteStore = create<CommuteState>((set, get) => ({
  seenHazardsByRoute: {},

  getSeenHazards: (routeId) => {
    // Pure read: return the in-memory cache if we have it, else decode
    // synchronously from MMKV. No store mutation here — callers can read
    // this from a useMemo during render without triggering a re-entrant
    // set(). Priming the in-memory cache is `markHazardsSeen`'s job.
    const cached = get().seenHazardsByRoute[routeId];
    if (cached) return cached;
    return decodeSeen(commuteStorage.getString(seenKey(routeId)));
  },

  markHazardsSeen: (routeId, hazardIds) => {
    const next = new Set(hazardIds);
    commuteStorage.set(seenKey(routeId), encodeSeen(next));
    set((s) => ({
      seenHazardsByRoute: { ...s.seenHazardsByRoute, [routeId]: next },
    }));
  },

  clearRoute: (routeId) => {
    commuteStorage.remove(seenKey(routeId));
    set((s) => {
      const next = { ...s.seenHazardsByRoute };
      delete next[routeId];
      return { seenHazardsByRoute: next };
    });
  },
}));

/**
 * Compute which hazard IDs are NEW since the rider's last check on a route.
 *
 * Pure function — the store and hook call this before any state mutation,
 * so the diff is deterministic and trivially unit-testable. Order follows
 * the input `currentHazardIds` so callers can trust a stable UI sort.
 */
export function diffNewHazards(
  currentHazardIds: string[],
  lastSeen: Set<string>,
): string[] {
  return currentHazardIds.filter((id) => !lastSeen.has(id));
}
