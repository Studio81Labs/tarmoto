/**
 * Mobile-side operator override cache — the client kill-switch fast path.
 *
 * Caches the PUBLIC `GET /config/flags` map (the full global feature-override
 * map, keyed by ANY flag, not only `sys_*`). Two families of operator kill
 * switch read it, both DEFAULT ON and killed only by an operator `force_off`:
 *
 *   - `sys_*` system switches — {@link isSystemSwitchEnabled}. Gate client-side
 *     subsystems the backend can't stop (e.g. `sys_accel_collection`, the raw
 *     50Hz sensor sampling).
 *   - FREE-tier feature kill switches — {@link isFeatureKillSwitchActive}. The
 *     "free for everyone" toggles (`crash_detection`, `ride_tracking`, …) exist
 *     so an operator can globally kill a misbehaving free feature. They can NOT
 *     ride on the per-user `/users/me` snapshot: the app has no login gate, so a
 *     signed-out rider (whose snapshot is absent) reaches these features, and a
 *     fail-closed snapshot read would wrongly disable them. The public
 *     `/config/flags` map is available regardless of sign-in, so it is the
 *     correct source.
 *
 * Both need a fast SYNCHRONOUS answer at a hot path (ride start, detector
 * subscribe), so we stash the latest `/config/flags` fetch in MMKV and read it
 * synchronously; `systemSwitchRefreshMonitor` keeps it fresh.
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
  resolveFeatureKillSwitch,
  resolveSystemSwitch,
  type FreeToggleFeatureKey,
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

// ── Change notification ──
// The refresh monitor writes the latest `/config/flags` into MMKV outside of
// React. MMKV writes don't trigger a re-render, so a component that mounted a
// kill-switchable surface while a switch read ENABLED (fresh install / cold
// start, before the first fetch) — especially an idle, root-mounted one with no
// changing selector, like `useCarPlayRideMirror` pre-ride — would never re-run
// its teardown when the fetch later lands a `force_off`. So consumers that gate
// a MOUNTED surface subscribe here (via `useFeatureKillSwitchActive`) and this
// module notifies them whenever a persist changes the map.
type StatesListener = () => void;
const stateListeners = new Set<StatesListener>();

/** Subscribe to override-map changes (for `useSyncExternalStore`). */
export function subscribeSystemSwitchStates(
  listener: StatesListener,
): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function notifyStateListeners(): void {
  for (const listener of stateListeners) listener();
}

/** Persist the most recent `/config/flags` override map. Notifies subscribers
 *  only when the serialized map actually changed, so an unchanged foreground
 *  refresh doesn't churn every mounted consumer. */
export function setCachedSystemSwitchStates(states: GlobalFeatureStates): void {
  const next = JSON.stringify(states);
  if (storage.getString(SYSTEM_SWITCH_KEY) === next) return;
  storage.set(SYSTEM_SWITCH_KEY, next);
  notifyStateListeners();
}

/** Clear the cache — used on logout so a stale operator flip can't linger. */
export function clearCachedSystemSwitchStates(): void {
  if (storage.getString(SYSTEM_SWITCH_KEY) === undefined) return;
  storage.remove(SYSTEM_SWITCH_KEY);
  notifyStateListeners();
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

/**
 * Synchronous answer for "is this FREE-tier feature still enabled?" — i.e. an
 * operator hasn't killed it. Reads the cached `/config/flags` map and resolves
 * against the shared default-ON rule, so an operator `force_off` disables the
 * feature globally while everything else stays ON. Fail SAFE — an unfetched /
 * corrupt cache reads ENABLED, so a free feature is never withheld just because
 * the map hasn't loaded (critical for signed-out riders and cold start).
 */
export function isFeatureKillSwitchActive(key: FreeToggleFeatureKey): boolean {
  return resolveFeatureKillSwitch(key, getCachedSystemSwitchStates()[key]);
}

/** Test hook — swaps the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
}
