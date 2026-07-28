/**
 * Ride-stop reconciler.
 *
 * `POST /rides/:id/stop` is non-idempotent (the backend 400s "Ride is not
 * active" once a ride is completed) and the backend enforces one active ride
 * per user — so a stop that never lands leaves the rider locked out of new
 * rides. Two callers stop a ride: the rider-initiated `stopAndExit` (HUD) and
 * the operator `ride_tracking` kill (`RideTrackingKillWatcher`). Both route
 * through here so a stop is:
 *
 *   - DEDUPED: concurrent stops for the same ride (the two paths racing) share
 *     one in-flight request; the loser never fires a second POST.
 *   - IDEMPOTENT: a 4xx "already stopped / not found" resolves as success
 *     rather than surfacing a spurious "Couldn't stop ride" — the ride is
 *     already completed, which is the desired end state.
 *   - RETRYABLE: a transient failure (offline, timeout, 5xx) PERSISTS the ride
 *     id so `drainPendingRideStops` (cold start + foreground) reconciles it
 *     later, instead of the id being discarded and the backend ride orphaned.
 *
 * Storage mirrors `systemSwitchCache`: MMKV with an in-memory fallback so the
 * module imports cleanly under jest.
 */

import { api, ApiError } from "./api";

interface CacheStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PENDING_STORAGE_ID = "tarmoto-ride-stop-pending";
const PENDING_KEY = "ids";

function createStorage(): CacheStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: PENDING_STORAGE_ID });
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

let storage: CacheStorage = createStorage();

/** Ride ids whose backend stop is in flight, so a concurrent call reuses it. */
const inFlight = new Map<string, Promise<void>>();

function readPending(): string[] {
  const raw = storage.getString(PENDING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((v): v is string => typeof v === "string")
    ) {
      return parsed;
    }
    storage.remove(PENDING_KEY);
    return [];
  } catch {
    storage.remove(PENDING_KEY);
    return [];
  }
}

function writePending(ids: string[]): void {
  if (ids.length === 0) storage.remove(PENDING_KEY);
  else storage.set(PENDING_KEY, JSON.stringify(ids));
}

function addPending(rideId: string): void {
  const ids = readPending();
  if (!ids.includes(rideId)) writePending([...ids, rideId]);
}

function removePending(rideId: string): void {
  const ids = readPending();
  if (ids.includes(rideId)) writePending(ids.filter((id) => id !== rideId));
}

/**
 * A 4xx means the ride can't be stopped because it's already completed (400
 * "Ride is not active") or gone (404) — the desired end state, so treat it as
 * reconciled and stop retrying. Network errors / timeouts / 5xx are transient.
 */
function isAlreadyReconciled(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * Stop a backend ride, reconciled. Resolves when the ride is stopped OR already
 * not-active/gone (idempotent). On a transient failure it persists the id for a
 * later drain and REJECTS, so the rider-initiated caller can surface its retry
 * UI while the background caller simply swallows.
 */
export function reconcileRideStop(rideId: string): Promise<void> {
  const existing = inFlight.get(rideId);
  if (existing) return existing;

  const run = (async () => {
    try {
      await api.stopRide(rideId);
      removePending(rideId);
    } catch (error) {
      if (isAlreadyReconciled(error)) {
        // Already completed / gone — the end state we wanted.
        removePending(rideId);
        return;
      }
      // Transient — keep the id so a foreground drain can retry it.
      addPending(rideId);
      throw error;
    } finally {
      inFlight.delete(rideId);
    }
  })();

  inFlight.set(rideId, run);
  return run;
}

/** Retry every persisted pending ride-stop. Best-effort; failures stay queued. */
export async function drainPendingRideStops(): Promise<void> {
  for (const rideId of readPending()) {
    await reconcileRideStop(rideId).catch(() => undefined);
  }
}

/** Test hook — swap the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
  inFlight.clear();
}

/** Test/diagnostic — the currently-persisted pending ride ids. */
export function __getPendingRideStopsForTest(): string[] {
  return readPending();
}
