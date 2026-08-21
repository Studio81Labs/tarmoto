/**
 * Tarmoto State Stores (Zustand)
 */

import { create } from "zustand";
import type {
  User,
  RideSummary,
  RideResponse,
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
import { isSupportedLocale, type SupportedLocale } from "@tarmoto/shared";
import { withPreservedEntitlements } from "@/lib/entitlements";

// ── Auth Store ──

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** True once the cold-start `bootstrapAuth` has SETTLED (published, failed, or
   *  found no session). REACTIVE state (not a plain flag) so a screen that
   *  mounted before a sessionless bootstrap finished re-renders when it settles
   *  — e.g. the anonymous road-quality resolver only then fetches
   *  `/config/limits`. Distinct from `isLoading`, which the optimistic
   *  `setUser(cached)` clears early for a signed-in cached start. Sticky: once
   *  set it stays set (logout doesn't un-settle — bootstrap already ran). */
  bootstrapSettled: boolean;
  setUser: (user: User | null) => void;
  /** Publish a full profile response (preferences PATCH, avatar upload, etc.)
   *  WITHOUT touching the entitlement slices — those stay owned by the refresh
   *  path so an incidental profile write can't resurrect a revoked capability.
   *  Reads current state atomically inside `set`. See withPreservedEntitlements. */
  applyProfileUpdate: (incoming: User) => void;
  setLoading: (loading: boolean) => void;
  markBootstrapSettled: () => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  bootstrapSettled: false,
  setUser: (user) => set({ user, isAuthenticated: !!user, isLoading: false }),
  applyProfileUpdate: (incoming) =>
    set((state) => ({
      user: withPreservedEntitlements(state.user, incoming),
      isAuthenticated: true,
      isLoading: false,
    })),
  setLoading: (isLoading) => set({ isLoading }),
  markBootstrapSettled: () => set({ bootstrapSettled: true }),
  logout: () => set({ user: null, isAuthenticated: false }),
}));

// ── Ride Store ──

interface RideState {
  // Active ride. Stored as the slim `RideResponse` shape returned by
  // `/rides/start` / `/rides/stop` — detail-only fields (segments,
  // route_geometry, lean_distribution) only become available via
  // `api.getRide`, which the detail screen runs separately.
  activeRide: RideResponse | null;
  isRiding: boolean;
  /**
   * Id of the rider who OWNS this ride, captured at start. The backend filters
   * `/rides/:id/stop` by user, and the ride can outlive the auth session (the
   * rider backs out of the HUD and signs out while recording continues) — so a
   * `ride_tracking` kill / stop reconciliation must scope its queued retry to
   * THIS owner, not the possibly-cleared current auth state. `null` only before
   * a ride starts.
   */
  rideOwnerId: string | null;
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
  /**
   * Running maximum absolute lean angle observed by the orientation
   * filter so far this ride (US-19). Drives the live HUD's "Max lean"
   * tile so the rider gets feedback before the ride finishes — the
   * canonical post-ride value comes from the backend's per-ride
   * aggregation in `ride_stats.max_lean_angle`.
   */
  maxLeanDeg: number;
  /**
   * `true` while the orientation filter is in its initial calibration
   * window. The HUD greys out the lean tile until the offset has
   * locked in so the rider doesn't see flickering 0° / nonsense readings
   * from the first second.
   */
  leanCalibrating: boolean;

  // Actions
  startRide: (
    type?: "free" | "commute" | "trip",
    ownerId?: string | null,
  ) => void;
  stopRide: () => void;
  setActiveRide: (ride: RideResponse | null) => void;
  updateSpeed: (speed: number) => void;
  updateQuality: (quality: ClassificationResult) => void;
  updateLocation: (location: LocationUpdate) => void;
  updateDistance: (distance: number) => void;
  updateDuration: (duration: number) => void;
  incrementSegments: () => void;
  /**
   * Push a window-level max lean reading from the sensor service. The
   * store keeps the running per-ride maximum so the HUD can render it
   * without driving its own state.
   */
  reportLeanWindow: (params: {
    maxAbsLeanDeg: number;
    calibrating: boolean;
  }) => void;

  // History
  recentRides: RideSummary[];
  setRecentRides: (rides: RideSummary[]) => void;
}

export const useRideStore = create<RideState>((set) => ({
  activeRide: null,
  isRiding: false,
  rideOwnerId: null,
  rideType: "free",
  startedAtMs: null,
  currentSpeed: 0,
  currentQuality: null,
  location: null,
  distance: 0,
  duration: 0,
  segmentCount: 0,
  maxLeanDeg: 0,
  leanCalibrating: true,
  recentRides: [],

  startRide: (type = "free", ownerId = null) =>
    set({
      isRiding: true,
      rideOwnerId: ownerId,
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
      maxLeanDeg: 0,
      // Re-enter the calibration grey-out state. The sensor service's
      // own filter is reset by `sensorService.start()` in lockstep —
      // these two flags need to flip together so a stale "calibrated"
      // banner from the prior ride doesn't show on the first second
      // of the new one.
      leanCalibrating: true,
    }),
  stopRide: () =>
    set({
      isRiding: false,
      activeRide: null,
      rideOwnerId: null,
      startedAtMs: null,
      currentQuality: null,
      currentSpeed: 0,
      maxLeanDeg: 0,
      leanCalibrating: true,
    }),
  setActiveRide: (activeRide) => set({ activeRide }),
  updateSpeed: (currentSpeed) => set({ currentSpeed }),
  updateQuality: (currentQuality) => set({ currentQuality }),
  updateLocation: (location) => set({ location }),
  updateDistance: (distance) => set({ distance }),
  updateDuration: (duration) => set({ duration }),
  incrementSegments: () => set((s) => ({ segmentCount: s.segmentCount + 1 })),
  reportLeanWindow: ({ maxAbsLeanDeg, calibrating }) =>
    set((s) => ({
      // Only advance the running max when the filter has actually
      // settled — otherwise a transient 30° reading from the first
      // tilt before calibration locked in would dominate the rest of
      // the ride.
      maxLeanDeg:
        calibrating || !Number.isFinite(maxAbsLeanDeg)
          ? s.maxLeanDeg
          : Math.max(s.maxLeanDeg, maxAbsLeanDeg),
      leanCalibrating: calibrating,
    })),
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
  "idle" | "countdown" | "dispatching" | "dispatched" | "failed";

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

/**
 * What kind of failure landed us in the `failed` phase. Drives the
 * overlay's RETRY behavior: only `completed` failures (the backend
 * recorded the dispatch with `contacts_notified: 0`) need a fresh
 * `alertId` to re-attempt — for transient ones (network error,
 * timeout, in-flight bound exhausted) keeping the same id preserves
 * idempotency so an in-flight original can't double-notify.
 */
export type CrashFailureSource = "completed" | "transient";

interface CrashState {
  phase: CrashAlertPhase;
  alert: CrashAlertSnapshot | null;
  /** Error message from the last failed dispatch, if any. */
  errorMessage: string | null;
  /**
   * Source of the most recent `failed` transition. The overlay's
   * RETRY button reads this to decide whether to rotate the
   * incident id (only for `completed`) or keep it (for `transient`).
   */
  failureSource: CrashFailureSource | null;
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
  /**
   * Mark the dispatch as failed. `source` distinguishes a backend-
   * recorded permanent failure (`completed`) from a transient
   * client-side issue (`transient`); see `CrashFailureSource`.
   */
  markFailed: (message: string, source: CrashFailureSource) => void;
  /**
   * Generate a fresh `alertId` on the current snapshot. Used by the
   * overlay's RETRY button only when the previous failure was
   * `completed` — without rotating, the backend would short-circuit
   * to the recorded failure replay. For `transient` failures the id
   * is kept so a still-in-flight original can replay deterministically
   * instead of double-notifying contacts.
   */
  rotateIncidentId: () => void;
  /** Dismiss after dispatched / failed terminal state. */
  reset: () => void;
}

export const useCrashStore = create<CrashState>((set) => ({
  phase: "idle",
  alert: null,
  errorMessage: null,
  failureSource: null,
  startCountdown: (snapshot) =>
    set({
      phase: "countdown",
      alert: { ...snapshot, alertId: makeIncidentId() },
      errorMessage: null,
      failureSource: null,
    }),
  beginDispatch: () =>
    set((s) =>
      s.phase === "countdown"
        ? { phase: "dispatching", errorMessage: null, failureSource: null }
        : s,
    ),
  cancel: () =>
    set((s) =>
      // Only honour cancel while the countdown is running. Once dispatch
      // has started, the backend may already have notified contacts —
      // pretending we cancelled would mislead the rider. Use `reset()`
      // to dismiss the dispatched/failed terminal screens instead.
      s.phase === "countdown"
        ? {
            phase: "idle",
            alert: null,
            errorMessage: null,
            failureSource: null,
          }
        : s,
    ),
  markDispatched: () =>
    set({ phase: "dispatched", errorMessage: null, failureSource: null }),
  markFailed: (errorMessage, failureSource) =>
    set({ phase: "failed", errorMessage, failureSource }),
  rotateIncidentId: () =>
    set((s) =>
      s.alert ? { alert: { ...s.alert, alertId: makeIncidentId() } } : s,
    ),
  reset: () =>
    set({
      phase: "idle",
      alert: null,
      errorMessage: null,
      failureSource: null,
    }),
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
const WEATHER_ALERTS_ENABLED_KEY = "weatherAlertsEnabled";
const DEFAULT_WEATHER_ALERTS_ENABLED = true;
const VOICE_NAV_ENABLED_KEY = "voiceNavEnabled";
const DEFAULT_VOICE_NAV_ENABLED = true;
const VOICE_NAV_VOLUME_KEY = "voiceNavVolume";
const DEFAULT_VOICE_NAV_VOLUME = 1; // 0..1, applied per-utterance on Android
const VOICE_NAV_VERBOSE_KEY = "voiceNavVerbose";
const DEFAULT_VOICE_NAV_VERBOSE = true;
const VOICE_NAV_LANGUAGE_KEY = "voiceNavLanguage";
const DISTANCE_UNIT_KEY = "distanceUnit";
const UI_LOCALE_OVERRIDE_KEY = "uiLocaleOverride";
const PENDING_UI_LOCALE_SYNC_KEY = "pendingUiLocaleSync";
const PENDING_UI_LOCALE_SYNC_OWNER_KEY = "pendingUiLocaleSyncOwner";

/**
 * Voice-navigation locale preference. `auto` resolves at announcement
 * time from the device locale (with English fallback) so a CZ rider gets
 * Czech without reaching for Settings, while letting riders pin a
 * specific voice — e.g. an English-speaking visitor in CZ — by picking
 * a fixed locale.
 */
export type VoiceNavLanguage = "auto" | "en" | "cs" | "sk" | "de";
const VOICE_NAV_LANGUAGES: readonly VoiceNavLanguage[] = [
  "auto",
  "en",
  "cs",
  "sk",
  "de",
] as const;
const DEFAULT_VOICE_NAV_LANGUAGE: VoiceNavLanguage = "auto";

export type DistanceUnitPref = "metric" | "imperial";
const DISTANCE_UNITS: readonly DistanceUnitPref[] = [
  "metric",
  "imperial",
] as const;
const DEFAULT_DISTANCE_UNIT: DistanceUnitPref = "metric";

interface PrefsStorage {
  getNumber(key: string): number | undefined;
  set(key: string, value: number): void;
  getString(key: string): string | undefined;
  setString(key: string, value: string): void;
  remove(key: string): void;
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
      getString: (key) => mmkv.getString(key),
      setString: (key, value) => mmkv.set(key, value),
      remove: (key) => mmkv.remove(key),
    };
  } catch {
    const numbers = new Map<string, number>();
    const strings = new Map<string, string>();
    return {
      getNumber: (key) => numbers.get(key),
      set: (key, value) => {
        numbers.set(key, value);
      },
      getString: (key) => strings.get(key),
      setString: (key, value) => {
        strings.set(key, value);
      },
      remove: (key) => {
        numbers.delete(key);
        strings.delete(key);
      },
    };
  }
}

const prefsStorage = createPrefsStorage();

// Booleans ride on the same number-keyed shim — 1 = on, 0 = off, missing
// = use the supplied default. Keeps the storage interface tiny and
// matches MMKV's strongly-typed accessors.
function loadPersistedBool(key: string, fallback: boolean): boolean {
  const raw = prefsStorage.getNumber(key);
  if (raw === undefined) return fallback;
  return raw !== 0;
}

function persistBool(key: string, value: boolean): void {
  prefsStorage.set(key, value ? 1 : 0);
}

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

function clampVoiceVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_NAV_VOLUME;
  return Math.max(0, Math.min(1, value));
}

function loadPersistedVoiceVolume(): number {
  const raw = prefsStorage.getNumber(VOICE_NAV_VOLUME_KEY);
  if (raw === undefined) return DEFAULT_VOICE_NAV_VOLUME;
  return clampVoiceVolume(raw);
}

function loadPersistedVoiceLanguage(): VoiceNavLanguage {
  const raw = prefsStorage.getString(VOICE_NAV_LANGUAGE_KEY);
  if (
    raw !== undefined &&
    (VOICE_NAV_LANGUAGES as readonly string[]).includes(raw)
  ) {
    return raw as VoiceNavLanguage;
  }
  return DEFAULT_VOICE_NAV_LANGUAGE;
}

function loadPersistedDistanceUnit(): DistanceUnitPref {
  const raw = prefsStorage.getString(DISTANCE_UNIT_KEY);
  if (
    raw !== undefined &&
    (DISTANCE_UNITS as readonly string[]).includes(raw)
  ) {
    return raw as DistanceUnitPref;
  }
  return DEFAULT_DISTANCE_UNIT;
}

function loadPersistedUiLocalePreference(): {
  override: SupportedLocale | null;
  pending: PendingUiLocaleSync | null;
} {
  const overrideRaw = prefsStorage.getString(UI_LOCALE_OVERRIDE_KEY);
  const pendingRaw = prefsStorage.getString(PENDING_UI_LOCALE_SYNC_KEY);
  const pendingOwner =
    prefsStorage.getString(PENDING_UI_LOCALE_SYNC_OWNER_KEY) ?? null;
  const override =
    overrideRaw && isSupportedLocale(overrideRaw) ? overrideRaw : null;
  const pendingLocale =
    pendingRaw && isSupportedLocale(pendingRaw) ? pendingRaw : null;

  // The marker and override are written as one action. Treat a partial or
  // hand-corrupted pair as a local-only override rather than syncing a locale
  // that is no longer driving the UI.
  return {
    override,
    pending:
      pendingLocale && pendingLocale === override
        ? { locale: pendingLocale, ownerUserId: pendingOwner }
        : null,
  };
}

const persistedUiLocalePreference = loadPersistedUiLocalePreference();

export interface PendingUiLocaleSync {
  locale: SupportedLocale;
  /** Null only when a future signed-out selector creates the choice. */
  ownerUserId: string | null;
}

interface PreferencesState {
  /** Minimum road quality (1..5) the rider wants to see in planning. */
  minQuality: number;
  setMinQuality: (value: number) => void;
  /** Rider's usable fuel range in kilometres — US-10 long-leg warnings. */
  fuelRangeKm: number;
  setFuelRangeKm: (value: number) => void;
  /**
   * US-13: surface real-time route weather alerts in NavigationScreen.
   * On by default — riders opt out, not in.
   */
  weatherAlertsEnabled: boolean;
  setWeatherAlertsEnabled: (value: boolean) => void;
  /**
   * US-16: turn-by-turn voice navigation. The four prefs map 1:1 to the
   * Settings card (toggle, volume slider, language picker, verbose
   * toggle). The voice FAB on NavigationScreen is a session-scoped
   * override of `voiceNavEnabled` — it doesn't persist back here.
   */
  voiceNavEnabled: boolean;
  setVoiceNavEnabled: (value: boolean) => void;
  voiceNavVolume: number;
  setVoiceNavVolume: (value: number) => void;
  voiceNavLanguage: VoiceNavLanguage;
  setVoiceNavLanguage: (value: VoiceNavLanguage) => void;
  voiceNavVerbose: boolean;
  setVoiceNavVerbose: (value: boolean) => void;
  /**
   * Distance / speed unit preference shared across nav prompts and the
   * UI helpers in `@tarmoto/shared`. Backend persists in metric — this
   * is presentation-only.
   */
  distanceUnit: DistanceUnitPref;
  setDistanceUnit: (value: DistanceUnitPref) => void;
  /**
   * Explicit UI language stored on this device. The override is the immediate
   * source of truth and survives sign-out; the separate marker tracks whether
   * that choice still needs to reach the account.
   */
  uiLocaleOverride: SupportedLocale | null;
  pendingUiLocaleSync: PendingUiLocaleSync | null;
  selectUiLocale: (
    locale: SupportedLocale,
    ownerUserId?: string | null,
  ) => void;
  completeUiLocaleSync: (
    locale: SupportedLocale,
    ownerUserId?: string | null,
  ) => void;
  discardUiLocaleSync: (
    locale: SupportedLocale,
    ownerUserId?: string | null,
  ) => void;
  adoptAccountUiLocale: (locale: SupportedLocale) => void;
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
  weatherAlertsEnabled: loadPersistedBool(
    WEATHER_ALERTS_ENABLED_KEY,
    DEFAULT_WEATHER_ALERTS_ENABLED,
  ),
  setWeatherAlertsEnabled: (value) => {
    persistBool(WEATHER_ALERTS_ENABLED_KEY, value);
    set({ weatherAlertsEnabled: value });
  },
  voiceNavEnabled: loadPersistedBool(
    VOICE_NAV_ENABLED_KEY,
    DEFAULT_VOICE_NAV_ENABLED,
  ),
  setVoiceNavEnabled: (value) => {
    persistBool(VOICE_NAV_ENABLED_KEY, value);
    set({ voiceNavEnabled: value });
  },
  voiceNavVolume: loadPersistedVoiceVolume(),
  setVoiceNavVolume: (value) => {
    const clamped = clampVoiceVolume(value);
    prefsStorage.set(VOICE_NAV_VOLUME_KEY, clamped);
    set({ voiceNavVolume: clamped });
  },
  voiceNavLanguage: loadPersistedVoiceLanguage(),
  setVoiceNavLanguage: (value) => {
    prefsStorage.setString(VOICE_NAV_LANGUAGE_KEY, value);
    set({ voiceNavLanguage: value });
  },
  voiceNavVerbose: loadPersistedBool(
    VOICE_NAV_VERBOSE_KEY,
    DEFAULT_VOICE_NAV_VERBOSE,
  ),
  setVoiceNavVerbose: (value) => {
    persistBool(VOICE_NAV_VERBOSE_KEY, value);
    set({ voiceNavVerbose: value });
  },
  distanceUnit: loadPersistedDistanceUnit(),
  setDistanceUnit: (value) => {
    prefsStorage.setString(DISTANCE_UNIT_KEY, value);
    set({ distanceUnit: value });
  },
  uiLocaleOverride: persistedUiLocalePreference.override,
  pendingUiLocaleSync: persistedUiLocalePreference.pending,
  selectUiLocale: (locale, ownerUserId = null) => {
    prefsStorage.setString(UI_LOCALE_OVERRIDE_KEY, locale);
    prefsStorage.setString(PENDING_UI_LOCALE_SYNC_KEY, locale);
    if (ownerUserId) {
      prefsStorage.setString(PENDING_UI_LOCALE_SYNC_OWNER_KEY, ownerUserId);
    } else {
      prefsStorage.remove(PENDING_UI_LOCALE_SYNC_OWNER_KEY);
    }
    set({
      uiLocaleOverride: locale,
      pendingUiLocaleSync: { locale, ownerUserId },
    });
  },
  completeUiLocaleSync: (locale, ownerUserId = null) => {
    set((state) => {
      // A slower response for a superseded choice must not clear the newer
      // override or make the UI fall back to the stale account response.
      if (
        state.pendingUiLocaleSync?.locale !== locale ||
        state.pendingUiLocaleSync.ownerUserId !== ownerUserId
      ) {
        return state;
      }
      prefsStorage.remove(PENDING_UI_LOCALE_SYNC_KEY);
      prefsStorage.remove(PENDING_UI_LOCALE_SYNC_OWNER_KEY);
      return { pendingUiLocaleSync: null };
    });
  },
  discardUiLocaleSync: (locale, ownerUserId = null) => {
    set((state) => {
      if (
        state.pendingUiLocaleSync?.locale !== locale ||
        state.pendingUiLocaleSync.ownerUserId !== ownerUserId
      ) {
        return state;
      }
      prefsStorage.remove(PENDING_UI_LOCALE_SYNC_KEY);
      prefsStorage.remove(PENDING_UI_LOCALE_SYNC_OWNER_KEY);
      return { pendingUiLocaleSync: null };
    });
  },
  adoptAccountUiLocale: (locale) => {
    set((state) => {
      // An explicit unsynced device choice has authority until its PATCH
      // settles; a profile refresh from another device must not overwrite it.
      if (state.pendingUiLocaleSync) return state;
      prefsStorage.setString(UI_LOCALE_OVERRIDE_KEY, locale);
      return { uiLocaleOverride: locale };
    });
  },
  resetPreferences: () => {
    prefsStorage.set(MIN_QUALITY_KEY, DEFAULT_MIN_QUALITY);
    prefsStorage.set(FUEL_RANGE_KEY, DEFAULT_FUEL_RANGE_KM);
    persistBool(WEATHER_ALERTS_ENABLED_KEY, DEFAULT_WEATHER_ALERTS_ENABLED);
    persistBool(VOICE_NAV_ENABLED_KEY, DEFAULT_VOICE_NAV_ENABLED);
    prefsStorage.set(VOICE_NAV_VOLUME_KEY, DEFAULT_VOICE_NAV_VOLUME);
    prefsStorage.setString(VOICE_NAV_LANGUAGE_KEY, DEFAULT_VOICE_NAV_LANGUAGE);
    persistBool(VOICE_NAV_VERBOSE_KEY, DEFAULT_VOICE_NAV_VERBOSE);
    prefsStorage.setString(DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT);
    set({
      minQuality: DEFAULT_MIN_QUALITY,
      fuelRangeKm: DEFAULT_FUEL_RANGE_KM,
      weatherAlertsEnabled: DEFAULT_WEATHER_ALERTS_ENABLED,
      voiceNavEnabled: DEFAULT_VOICE_NAV_ENABLED,
      voiceNavVolume: DEFAULT_VOICE_NAV_VOLUME,
      voiceNavLanguage: DEFAULT_VOICE_NAV_LANGUAGE,
      voiceNavVerbose: DEFAULT_VOICE_NAV_VERBOSE,
      distanceUnit: DEFAULT_DISTANCE_UNIT,
    });
  },
}));

export const PREFERENCES_DEFAULTS = {
  minQuality: DEFAULT_MIN_QUALITY,
  fuelRangeKm: DEFAULT_FUEL_RANGE_KM,
  weatherAlertsEnabled: DEFAULT_WEATHER_ALERTS_ENABLED,
  voiceNavEnabled: DEFAULT_VOICE_NAV_ENABLED,
  voiceNavVolume: DEFAULT_VOICE_NAV_VOLUME,
  voiceNavLanguage: DEFAULT_VOICE_NAV_LANGUAGE,
  voiceNavVerbose: DEFAULT_VOICE_NAV_VERBOSE,
  distanceUnit: DEFAULT_DISTANCE_UNIT,
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
      // Rows written before packs were attributed (#1279) carry no owner.
      // Normalize to an explicit `null` so `isRegionUsableBy` has one shape to
      // read, and `adoptUnownedRegions` one condition to look for.
      ownerId: typeof r.ownerId === "string" ? r.ownerId : null,
      // Migrate pre-parity rows that persisted rendered English strings.
      // Their original diagnostic cannot be safely retranslated, so retain
      // the actionable generic failure reason.
      lastError: normalizeOfflineRegionError(
        (r as OfflineRegion & { lastError?: unknown }).lastError,
      ),
      status:
        r.status === "downloading" || r.status === "pending"
          ? ("failed" as RegionStatus)
          : r.status,
    }));
  } catch {
    return [];
  }
}

function normalizeOfflineRegionError(
  value: unknown,
): OfflineRegion["lastError"] {
  if (typeof value === "string") {
    return value.trim() ? { code: "download-failed" } : null;
  }
  if (!value || typeof value !== "object") return null;
  const error = value as Record<string, unknown>;
  if (error.code === "download-failed") return { code: "download-failed" };
  if (
    error.code === "tile-cap-exceeded" &&
    typeof error.limit === "number" &&
    typeof error.count === "number"
  ) {
    return {
      code: "tile-cap-exceeded",
      limit: error.limit,
      count: error.count,
    };
  }
  return null;
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
    v.bbox !== null &&
    // Absent on rows persisted before #1279; `loadPersistedRegions` fills it.
    (v.ownerId === undefined ||
      v.ownerId === null ||
      typeof v.ownerId === "string")
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
  /**
   * Claim every unowned pack for `riderId` (#1279) — the one-time backfill for
   * installs upgraded from a build that did not attribute downloads. No-op once
   * there is nothing left unowned, and for a signed-out app.
   */
  adoptUnownedRegions: (riderId: string) => void;
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
      error: OfflineRegion["lastError"];
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

  adoptUnownedRegions: (riderId) => {
    set((s) => {
      if (!s.regions.some((r) => r.ownerId === null)) return s;
      const next = s.regions.map((r) =>
        r.ownerId === null ? { ...r, ownerId: riderId } : r,
      );
      persistRegions(next);
      return { regions: next };
    });
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
