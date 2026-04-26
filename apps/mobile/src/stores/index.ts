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
  TripSummary,
  LatLng,
} from "@/types";
import type { ClassificationResult } from "@/services/sensors";
import type { LocationUpdate } from "@/services/location";
import type {
  OfflineRegion,
  OfflineRegionSpec,
  RegionStatus,
} from "@/services/offlineRegions";
import {
  DEFAULT_FUEL_RANGE_KM,
  MIN_QUALITY_BOUNDS,
  clampFuelRangeKm,
} from "@/theme";

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
  /**
   * Local wall-clock timestamp (ms since epoch) when the current ride
   * started. The root-level `RideDurationTicker` derives `duration`
   * from this so the count keeps advancing even when the live HUD
   * isn't mounted (e.g. the rider backed out to the history list
   * mid-ride). `null` when no ride is active.
   */
  startedAtMs: number | null;

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
  setActiveRide: (ride: RideDetail | null) => void;
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
  startedAtMs: null,
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
      // Anchor for the root-level duration ticker. Picking a fresh
      // timestamp on every startRide also resets `duration` to 0
      // implicitly — the ticker reads `(Date.now() - startedAtMs)`
      // not the previous duration field.
      startedAtMs: Date.now(),
      distance: 0,
      duration: 0,
      segmentCount: 0,
      currentQuality: null,
    }),
  stopRide: () =>
    set({
      isRiding: false,
      activeRide: null,
      startedAtMs: null,
      currentQuality: null,
      currentSpeed: 0,
    }),
  setActiveRide: (activeRide) => set({ activeRide }),
  updateSpeed: (currentSpeed) => set({ currentSpeed }),
  updateQuality: (currentQuality) => set({ currentQuality }),
  updateLocation: (location) => set({ location }),
  updateDistance: (distance) => set({ distance }),
  updateDuration: (duration) => set({ duration }),
  incrementSegments: () => set((s) => ({ segmentCount: s.segmentCount + 1 })),
  setRecentRides: (recentRides) => set({ recentRides }),
}));

// ── Crash Alert Store ──
//
// Holds the live state of an in-progress crash alert (US-12). Three
// states: idle (no alert), countdown (overlay visible, rider can
// cancel), dispatched (sendCrashAlert posted). The store is mutated
// by the crash detector runner and read by `CrashAlertOverlay` so the
// UI can render the same source of truth from anywhere in the tree.

export type CrashAlertPhase =
  | "idle"
  | "countdown"
  | "dispatching"
  | "dispatched"
  | "failed";

/**
 * RFC 4122 v4 UUID — used as the per-incident idempotency key for
 * `POST /safety/crash-alert`. `Math.random` is good enough here: a
 * collision would only mean the backend treats two unrelated alerts
 * as the same one, and the chance over the entire user base is
 * astronomical (~5e-39 per call). React Native doesn't polyfill
 * `crypto.randomUUID` on every supported version, so a small
 * inline generator avoids a native dependency.
 */
function makeIncidentId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface CrashAlertSnapshot {
  /**
   * Stable per-incident UUIDv4 used as the backend idempotency key.
   * Generated once in `startCountdown` and reused for every dispatch
   * attempt of the same incident, so a network retry can replay the
   * original outcome instead of re-notifying contacts. Cleared on
   * `cancel`/`reset` along with the rest of the snapshot.
   */
  alertId: string;
  /** Trigger location at the moment of detection. May be null if GPS is offline. */
  lat: number | null;
  lng: number | null;
  /** Active ride id captured at trigger time, if any. */
  rideId: string | null;
  /** Speed (km/h) recorded just before the impact spike. */
  speedAtImpact: number | null;
  /** Trigger wall-clock timestamp (ms). */
  triggeredAt: number;
}

interface CrashState {
  phase: CrashAlertPhase;
  alert: CrashAlertSnapshot | null;
  /** Error message from the last failed dispatch, if any. */
  errorMessage: string | null;
  /**
   * Begin the cancellable countdown for a fresh incident. The store
   * stamps a stable `alertId` (UUIDv4) on the snapshot so every
   * dispatch attempt for this incident — including manual RETRY taps
   * — uses the same backend idempotency key. Callers do not need to
   * provide one.
   */
  startCountdown: (snapshot: Omit<CrashAlertSnapshot, "alertId">) => void;
  /**
   * Move into the dispatching phase. Once here the rider can no longer
   * silently cancel: the POST is already in flight (or about to be) and
   * the backend may have notified contacts, so flipping back to idle
   * would create a false sense of "cancelled" while a real alert went
   * out. UI hides the cancel button in this phase.
   */
  beginDispatch: () => void;
  /** Rider cancelled within the countdown — silent, no contacts notified. */
  cancel: () => void;
  markDispatched: () => void;
  markFailed: (message: string) => void;
  /**
   * Generate a fresh `alertId` on the current snapshot. Used by the
   * overlay's RETRY button after a permanent backend failure (e.g.
   * every contact's send rejected): without rotating the key, the
   * next attempt would short-circuit to the recorded failure replay
   * instead of actually re-dispatching, leaving the rider unable to
   * recover in a safety-critical flow.
   */
  rotateIncidentId: () => void;
  /** Dismiss after dispatched / failed terminal state. */
  reset: () => void;
}

export const useCrashStore = create<CrashState>((set) => ({
  phase: "idle",
  alert: null,
  errorMessage: null,
  startCountdown: (snapshot) =>
    set({
      phase: "countdown",
      alert: { ...snapshot, alertId: makeIncidentId() },
      errorMessage: null,
    }),
  beginDispatch: () =>
    set((s) =>
      s.phase === "countdown"
        ? { phase: "dispatching", errorMessage: null }
        : s,
    ),
  cancel: () =>
    set((s) =>
      // Only honour cancel while the countdown is running. Once dispatch
      // has started, the backend may already have notified contacts —
      // pretending we cancelled would mislead the rider. Use `reset()`
      // to dismiss the dispatched/failed terminal screens instead.
      s.phase === "countdown"
        ? { phase: "idle", alert: null, errorMessage: null }
        : s,
    ),
  markDispatched: () => set({ phase: "dispatched", errorMessage: null }),
  markFailed: (errorMessage) => set({ phase: "failed", errorMessage }),
  rotateIncidentId: () =>
    set((s) =>
      s.alert ? { alert: { ...s.alert, alertId: makeIncidentId() } } : s,
    ),
  reset: () => set({ phase: "idle", alert: null, errorMessage: null }),
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
  // Trips tab list uses the lightweight summary shape returned by
  // `/trips`; `activeTrip` holds the full `Trip` (with days + waypoints)
  // populated by TripDetailScreen from `/trips/:id`.
  trips: TripSummary[];
  activeTrip: Trip | null;
  setTrips: (trips: TripSummary[]) => void;
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
  showPassesOverlay: boolean;
  showFunZonesOverlay: boolean;
  setCenter: (center: LatLng) => void;
  setZoom: (zoom: number) => void;
  toggleQuality: () => void;
  toggleSurface: () => void;
  toggleHazards: () => void;
  togglePasses: () => void;
  toggleFunZones: () => void;
}

export const useMapStore = create<MapState>((set) => ({
  center: { lat: 49.82, lng: 18.26 }, // Ostrava default
  zoom: 12,
  showQualityOverlay: true,
  showSurfaceOverlay: false,
  showHazardOverlay: true,
  showPassesOverlay: true,
  // US-6: off by default so first-time users see the road-quality overlay
  // without competing fills. Opt-in discovery from the FAB column.
  showFunZonesOverlay: false,
  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  toggleQuality: () =>
    set((s) => ({ showQualityOverlay: !s.showQualityOverlay })),
  toggleSurface: () =>
    set((s) => ({ showSurfaceOverlay: !s.showSurfaceOverlay })),
  toggleHazards: () =>
    set((s) => ({ showHazardOverlay: !s.showHazardOverlay })),
  togglePasses: () => set((s) => ({ showPassesOverlay: !s.showPassesOverlay })),
  toggleFunZones: () =>
    set((s) => ({ showFunZonesOverlay: !s.showFunZonesOverlay })),
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
const FUEL_RANGE_KEY = "fuelRangeKm";

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

function loadPersistedFuelRange(): number {
  const raw = prefsStorage.getNumber(FUEL_RANGE_KEY);
  if (raw === undefined) return DEFAULT_FUEL_RANGE_KM;
  return clampFuelRangeKm(raw);
}

interface PreferencesState {
  /** Minimum road quality (1..5) the rider wants to see in planning. */
  minQuality: number;
  setMinQuality: (value: number) => void;
  /** Rider's usable fuel range in kilometres — US-10 long-leg warnings. */
  fuelRangeKm: number;
  setFuelRangeKm: (value: number) => void;
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  minQuality: loadPersistedMinQuality(),
  setMinQuality: (value) => {
    const clamped = clampMinQuality(value);
    prefsStorage.set(MIN_QUALITY_KEY, clamped);
    set({ minQuality: clamped });
  },
  fuelRangeKm: loadPersistedFuelRange(),
  setFuelRangeKm: (value) => {
    const clamped = clampFuelRangeKm(value);
    prefsStorage.set(FUEL_RANGE_KEY, clamped);
    set({ fuelRangeKm: clamped });
  },
  resetPreferences: () => {
    prefsStorage.set(MIN_QUALITY_KEY, DEFAULT_MIN_QUALITY);
    prefsStorage.set(FUEL_RANGE_KEY, DEFAULT_FUEL_RANGE_KM);
    set({
      minQuality: DEFAULT_MIN_QUALITY,
      fuelRangeKm: DEFAULT_FUEL_RANGE_KM,
    });
  },
}));

export const PREFERENCES_DEFAULTS = {
  minQuality: DEFAULT_MIN_QUALITY,
  fuelRangeKm: DEFAULT_FUEL_RANGE_KM,
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

// ── Offline Regions Store ──
// US-18 AC #1: "Download map regions for offline use". Keeps a durable list
// of regions the rider has asked to cache so the UI can show progress,
// retry failed tiles, and delete regions to reclaim space. Tile bytes
// themselves live under `DocumentDirectoryPath/offline-tiles/<id>/…` and
// are managed by `services/offlineRegions.ts` — this store only tracks
// metadata (spec + progress).

const OFFLINE_STORAGE_ID = "tarmoto-offline-regions";
const OFFLINE_REGIONS_KEY = "regions";

interface OfflineStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function createOfflineStorage(): OfflineStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: OFFLINE_STORAGE_ID });
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

const offlineStorage = createOfflineStorage();

function loadPersistedRegions(): OfflineRegion[] {
  const raw = offlineStorage.getString(OFFLINE_REGIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // A crashed write shouldn't brick the app on next launch. Everything
    // that fails the shape check gets dropped silently — the rider can
    // re-add the region; we never pretend a broken one is downloadable.
    return parsed.filter(isOfflineRegion).map((r) => ({
      // Any region that was in a transient state when the app died is
      // stuck there forever otherwise. "downloading" obviously needs to
      // flip out — no loop is running — but "pending" is equally bad:
      // if the app crashed between `addRegion` (persists pending) and
      // `beginDownload`, the rider would see a region with no Retry
      // affordance (Retry is only shown for failed/cancelled). Clamp
      // both to "failed" so there's always a way forward.
      ...r,
      status:
        r.status === "downloading" || r.status === "pending"
          ? ("failed" as RegionStatus)
          : r.status,
    }));
  } catch {
    return [];
  }
}

function isOfflineRegion(value: unknown): value is OfflineRegion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<OfflineRegion>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.minZoom === "number" &&
    typeof v.maxZoom === "number" &&
    typeof v.status === "string" &&
    typeof v.totalTiles === "number" &&
    typeof v.downloadedTiles === "number" &&
    typeof v.bbox === "object" &&
    v.bbox !== null
  );
}

function persistRegions(regions: OfflineRegion[]): void {
  if (regions.length === 0) {
    offlineStorage.remove(OFFLINE_REGIONS_KEY);
  } else {
    offlineStorage.set(OFFLINE_REGIONS_KEY, JSON.stringify(regions));
  }
}

interface OfflineState {
  regions: OfflineRegion[];
  /** Register a new region; initial state is "pending" until download starts. */
  addRegion: (spec: OfflineRegionSpec, totalTiles: number) => OfflineRegion;
  /** Mark the region as actively downloading. */
  beginDownload: (regionId: string) => void;
  /** Merge a progress tick into the region. Idempotent on duplicate reports. */
  updateProgress: (
    regionId: string,
    patch: {
      downloaded: number;
      failed: number;
      bytesOnDisk: number;
    },
  ) => void;
  /** Terminal state transition at the end of a download/retry. */
  finishDownload: (
    regionId: string,
    outcome: {
      status: Exclude<RegionStatus, "pending" | "downloading">;
      downloaded: number;
      failed: number;
      bytesOnDisk: number;
      error: string | null;
    },
  ) => void;
  /** Drop the region from state. Caller is responsible for FS cleanup. */
  removeRegion: (regionId: string) => void;
  /** Convenience selector used by screens and tests. */
  getRegion: (regionId: string) => OfflineRegion | undefined;
  /** Wipe all offline regions — used when the rider clears offline storage. */
  clearAll: () => void;
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  regions: loadPersistedRegions(),

  addRegion: (spec, totalTiles) => {
    // `lastUpdatedAt` is intentionally `null` on first add — it only
    // advances when real tile writes land, so the UI can tell "just
    // registered" from "download finished just now".
    const region: OfflineRegion = {
      ...spec,
      status: "pending",
      totalTiles,
      downloadedTiles: 0,
      failedTiles: 0,
      bytesOnDisk: 0,
      lastError: null,
      lastUpdatedAt: null,
    };
    set((s) => {
      // Replace any existing region with the same id — addRegion acts as
      // upsert so a retry from the "add" path (e.g. tapping "save current
      // area" twice on the same bounds) resets the counters instead of
      // stacking two entries pointing at the same on-disk tree.
      const without = s.regions.filter((r) => r.id !== region.id);
      const next = [...without, region];
      persistRegions(next);
      return { regions: next };
    });
    return region;
  },

  beginDownload: (regionId) => {
    set((s) => {
      const next = s.regions.map((r) =>
        r.id === regionId
          ? { ...r, status: "downloading" as RegionStatus, lastError: null }
          : r,
      );
      persistRegions(next);
      return { regions: next };
    });
  },

  updateProgress: (regionId, patch) => {
    // Intentionally does NOT persist. `onProgress` fires once per tile and a
    // region can hold up to MAX_TILES_PER_REGION (5000); serialising the
    // whole regions array to MMKV on every tick would burn ~5000 JSON
    // writes per download and choke the UI with re-renders. In-memory state
    // carries the live progress bar; durable state is refreshed on
    // `beginDownload` and `finishDownload` only. Crash recovery is safe:
    // `loadPersistedRegions` clamps any region left in "downloading" (or
    // "pending") to "failed" so the rider always sees a Retry affordance,
    // and the resume path re-uses tiles already on disk via `tileExists`.
    set((s) => ({
      regions: s.regions.map((r) => {
        if (r.id !== regionId) return r;
        return {
          ...r,
          downloadedTiles: patch.downloaded,
          failedTiles: patch.failed,
          bytesOnDisk: patch.bytesOnDisk,
          lastUpdatedAt: Date.now(),
        };
      }),
    }));
  },

  finishDownload: (regionId, outcome) => {
    set((s) => {
      const next = s.regions.map((r) => {
        if (r.id !== regionId) return r;
        return {
          ...r,
          status: outcome.status,
          downloadedTiles: outcome.downloaded,
          failedTiles: outcome.failed,
          bytesOnDisk: outcome.bytesOnDisk,
          lastError: outcome.error,
          lastUpdatedAt: Date.now(),
        };
      });
      persistRegions(next);
      return { regions: next };
    });
  },

  removeRegion: (regionId) => {
    set((s) => {
      const next = s.regions.filter((r) => r.id !== regionId);
      persistRegions(next);
      return { regions: next };
    });
  },

  getRegion: (regionId) => get().regions.find((r) => r.id === regionId),

  clearAll: () => {
    persistRegions([]);
    set({ regions: [] });
  },
}));

/**
 * Derive a 0-1 progress ratio for a region. Returns 1 when the tile count
 * is 0 (degenerate region) so the UI bar doesn't get stuck at 0 — the
 * download job will fail-fast on an empty spec anyway.
 */
export function regionProgress(region: OfflineRegion): number {
  if (region.totalTiles <= 0) return 1;
  const done = region.downloadedTiles + region.failedTiles;
  return Math.max(0, Math.min(1, done / region.totalTiles));
}
