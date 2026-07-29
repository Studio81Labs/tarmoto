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

/** A pending stop, scoped to the rider who owns the ride — the backend filters
 *  stops by `user_id`, so a queued stop must only ever be retried with THAT
 *  rider's token (else it 404s under a different sign-in and is wrongly
 *  discarded). */
interface PendingStop {
  rideId: string;
  userId: string;
}

/** Ride ids whose backend stop is in flight, so a concurrent call reuses it. */
const inFlight = new Map<string, Promise<void>>();

function readPending(): PendingStop[] {
  const raw = storage.getString(PENDING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (v): v is PendingStop =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as PendingStop).rideId === "string" &&
          typeof (v as PendingStop).userId === "string",
      )
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

function writePending(entries: PendingStop[]): void {
  if (entries.length === 0) storage.remove(PENDING_KEY);
  else storage.set(PENDING_KEY, JSON.stringify(entries));
}

function addPending(entry: PendingStop): void {
  const entries = readPending();
  if (!entries.some((e) => e.rideId === entry.rideId)) {
    writePending([...entries, entry]);
  }
}

function removePending(rideId: string): void {
  const entries = readPending();
  if (entries.some((e) => e.rideId === rideId)) {
    writePending(entries.filter((e) => e.rideId !== rideId));
  }
}

/**
 * Only a response that PROVES the ride is already stopped or gone clears the
 * queue: 400 ("Ride is not active") or 404 (not found). An auth failure
 * (401/403 — e.g. a token refresh that failed) or any other status does NOT
 * establish the ride is stopped, so it must remain pending for a retry after
 * the rider re-authenticates. Network errors / timeouts / 5xx are transient too.
 */
function isProvenStopped(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 400 || error.status === 404)
  );
}

/**
 * Stop a backend ride, reconciled. Resolves when the ride is stopped OR already
 * not-active/gone (idempotent). On any other failure it persists the id (scoped
 * to `userId`) for a later drain and REJECTS, so the rider-initiated caller can
 * surface its retry UI while the background caller simply swallows.
 */
export function reconcileRideStop(
  rideId: string,
  userId: string,
): Promise<void> {
  const existing = inFlight.get(rideId);
  if (existing) return existing;

  const run = (async () => {
    try {
      await api.stopRide(rideId);
      removePending(rideId);
    } catch (error) {
      if (isProvenStopped(error)) {
        // Already completed / gone — the end state we wanted.
        removePending(rideId);
        return;
      }
      // Transient / auth — keep the id so a foreground drain (with the owning
      // rider's token) can retry it.
      addPending({ rideId, userId });
      throw error;
    } finally {
      inFlight.delete(rideId);
    }
  })();

  inFlight.set(rideId, run);
  return run;
}

/**
 * Cancel a queued stop — the ride is NOT being ended after all. Used when a
 * rider's stop fails, they choose "Keep riding", and recording continues: the
 * entry must be dropped or a later foreground/sign-in drain would complete the
 * backend ride mid-recording (early `ended_at`, inconsistent data).
 */
export function cancelPendingRideStop(rideId: string): void {
  removePending(rideId);
}

/**
 * Retry the persisted pending stops OWNED by `currentUserId` (the signed-in
 * rider), EXCLUDING `activeRideId` — the ride that is still recording locally.
 *
 * A rider-initiated stop that fails transiently is persisted while GPS/sensors
 * KEEP recording (the ride only ends once the stop succeeds or the rider
 * commits via the alert). Draining that entry in the background — e.g. on a
 * foreground while the alert is still open — would complete the backend ride
 * mid-recording (early `ended_at`, inconsistent telemetry). So skip the entry
 * whose ride is still the local active ride; it drains once the rider actually
 * ends it (which clears `activeRide`) or an incident kill ends the session.
 * Entries owned by a different rider are left untouched too — draining them
 * with the current token would 404 and wrongly discard that rider's ride.
 * Best-effort; failures stay queued.
 */
export async function drainPendingRideStops(
  currentUserId: string,
  activeRideId?: string | null,
): Promise<void> {
  const mine = readPending().filter(
    (e) => e.userId === currentUserId && e.rideId !== activeRideId,
  );
  for (const entry of mine) {
    await reconcileRideStop(entry.rideId, entry.userId).catch(() => undefined);
  }
}

/** Test hook — swap the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
  inFlight.clear();
}

/** Test/diagnostic — the currently-persisted pending stops. */
export function __getPendingRideStopsForTest(): PendingStop[] {
  return readPending();
}
