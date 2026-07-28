/**
 * Mobile-side operator system-switch cache.
 *
 * Operator `sys_*` kill switches (served by the PUBLIC `GET /config/flags`) are
 * global toggles that DEFAULT ON and are killed only by an operator
 * `force_off`. Some subsystems they gate are purely client-side — e.g.
 * `sys_accel_collection` controls the phone's raw 50Hz accelerometer/gyro
 * sampling, which the backend can't stop. Those need a fast SYNCHRONOUS answer
 * at the hot path (ride start), so we stash the latest `/config/flags` fetch in
 * MMKV and read it synchronously; `systemSwitchRefreshMonitor` keeps it fresh.
 *
 * Fail SAFE: with no cached row yet (fresh install before the first refresh, or
 * MMKV corruption) every switch reads ENABLED. A kill switch must not disable a
 * working subsystem just because we haven't learned the operator's state — the
 * default is ON, and the resolver only turns a switch off on a confirmed
 * `force_off`. Mirrors `resolveSystemSwitch` in `@tarmoto/shared`.
 *
 * Structurally identical to `privacyCache` (the sensor-upload gate); see that
 * module for the MMKV lazy-require + in-memory-fallback rationale.
 */

import {
  isGlobalFeatureState,
  resolveSystemSwitch,
  type GlobalFeatureStates,
  type SystemFeatureKey,
} from "@tarmoto/shared";

interface CacheStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const SYSTEM_SWITCH_STORAGE_ID = "tarmoto-system-switches";
const SYSTEM_SWITCH_KEY = "flags";

function createSystemSwitchStorage(): CacheStorage {
  try {
    // Lazy require so this module imports under jest without the native MMKV
    // binding (mirrors privacyCache / offlineQueue).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: SYSTEM_SWITCH_STORAGE_ID });
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

let storage: CacheStorage = createSystemSwitchStorage();

/** Type-guard for a persisted override map (only `"force_off"`/`"force_on"`
 *  values survive; a corrupt/older-shape blob is dropped). */
function isGlobalFeatureStates(value: unknown): value is GlobalFeatureStates {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    isGlobalFeatureState,
  );
}

/**
 * Read the cached operator override map. Returns an empty map (→ every switch
 * default-ON) when no row has been persisted yet, so callers never need an
 * "uninitialised" branch.
 */
export function getCachedSystemSwitchStates(): GlobalFeatureStates {
  const raw = storage.getString(SYSTEM_SWITCH_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isGlobalFeatureStates(parsed)) {
      // Corrupt / older-shape blob → drop it and fail safe to defaults.
      storage.remove(SYSTEM_SWITCH_KEY);
      return {};
    }
    return parsed;
  } catch {
    storage.remove(SYSTEM_SWITCH_KEY);
    return {};
  }
}

/** Persist the most recent `/config/flags` override map. */
export function setCachedSystemSwitchStates(states: GlobalFeatureStates): void {
  storage.set(SYSTEM_SWITCH_KEY, JSON.stringify(states));
}

/** Clear the cache — used on logout so a stale operator flip can't linger. */
export function clearCachedSystemSwitchStates(): void {
  storage.remove(SYSTEM_SWITCH_KEY);
}

/**
 * Synchronous hot-path answer for "is this system switch enabled?". Reads the
 * cached override map and resolves against the shared default-ON rule, so an
 * operator `force_off` disables the subsystem while everything else stays ON.
 * Fail SAFE — an unfetched / corrupt cache reads ENABLED.
 */
export function isSystemSwitchEnabled(key: SystemFeatureKey): boolean {
  return resolveSystemSwitch(key, getCachedSystemSwitchStates()[key]);
}

/** Test hook — swaps the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
}
