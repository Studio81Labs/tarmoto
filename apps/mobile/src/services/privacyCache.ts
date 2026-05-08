/**
 * Mobile-side privacy preferences cache (#279 / #501).
 *
 * The backend is the source of truth for every privacy toggle, but
 * the sensor uploader needs a fast synchronous answer for "may I
 * stream readings?" before each upload — round-tripping `GET
 * /account/privacy` per upload would burn battery and bandwidth on
 * an opt-out rider whose payloads we're going to suppress anyway.
 *
 * This module stashes the most recent fetch in MMKV and exposes a
 * synchronous `getCachedPreferences()`. Callers (today: the sensor
 * upload path; tomorrow: any analytics SDK we wire) refresh in the
 * background and read from cache on the hot path.
 *
 * Defaults are FAIL-OPEN here: if no cache row exists yet (fresh
 * install before the first refresh, or MMKV corruption) we return
 * the canonical defaults from `@tarmoto/shared`. That matches the
 * server-side `mergeWithDefaults` posture and means a brand-new
 * install behaves identically to a long-running one — both honour
 * `road_data_contribution: true` until the rider explicitly opts
 * out and that opt-out is persisted on the server.
 *
 * The fail-open posture here is symmetric with the backend gate at
 * `SensorService.processUpload` (`apps/backend/src/modules/sensor/
 * sensor.service.ts`). Even if the mobile cache is stale and lets
 * an opted-out payload through, the backend drops the readings on
 * receive — belt-and-suspenders, exactly as the issue spec calls
 * out.
 */

import {
  DEFAULT_PRIVACY_PREFERENCES,
  shouldContributeRoadData,
  type PrivacyPreferences,
} from "@tarmoto/shared";

interface CacheStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PRIVACY_STORAGE_ID = "tarmoto-privacy";
const PRIVACY_KEY = "preferences";

function createPrivacyStorage(): CacheStorage {
  try {
    // Lazy require so this module can be imported under jest without
    // pulling the native MMKV binding (mirrors the offlineQueue
    // pattern — see services/offlineQueue.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: PRIVACY_STORAGE_ID });
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

let storage: CacheStorage = createPrivacyStorage();

/**
 * Read the cached preferences. Returns canonical defaults when no
 * row has been persisted yet so callers don't need a separate
 * "uninitialised" branch.
 */
export function getCachedPreferences(): PrivacyPreferences {
  const raw = storage.getString(PRIVACY_KEY);
  if (!raw) return { ...DEFAULT_PRIVACY_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPrivacyPreferences(parsed)) {
      // Corrupt blob (older shape, hand-edited storage). Drop it
      // and fall back to defaults so the rider isn't stuck on a
      // stale opt-out from a previous schema.
      storage.remove(PRIVACY_KEY);
      return { ...DEFAULT_PRIVACY_PREFERENCES };
    }
    return parsed;
  } catch {
    // Malformed JSON — same eviction rule as the wrong-shape branch
    // above so a corrupt write doesn't keep tripping the parse on
    // every read.
    storage.remove(PRIVACY_KEY);
    return { ...DEFAULT_PRIVACY_PREFERENCES };
  }
}

/** Persist the most recent server-side preferences. */
export function setCachedPreferences(prefs: PrivacyPreferences): void {
  storage.set(PRIVACY_KEY, JSON.stringify(prefs));
}

/** Clear the cache — used on logout so a different rider doesn't
 *  inherit the previous one's toggles. */
export function clearCachedPreferences(): void {
  storage.remove(PRIVACY_KEY);
}

/**
 * Convenience wrapper for the sensor upload hot path. Mirrors the
 * server-side gate posture in `SensorService.processUpload` so the
 * mobile and backend agree on the boolean for an identical
 * preferences row.
 */
export function canContributeRoadData(): boolean {
  return shouldContributeRoadData(getCachedPreferences());
}

function isPrivacyPreferences(value: unknown): value is PrivacyPreferences {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PrivacyPreferences>;
  return (
    typeof v.profile_visibility === "string" &&
    typeof v.default_ride_sharing === "string" &&
    typeof v.road_data_contribution === "boolean" &&
    typeof v.location_retention === "string" &&
    typeof v.analytics_consent === "boolean" &&
    typeof v.personalized_recommendations_consent === "boolean"
  );
}

/** Test hook — swaps the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
}
