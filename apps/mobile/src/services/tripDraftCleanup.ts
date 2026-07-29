/**
 * Trip-draft cleanup reconciler.
 *
 * When `trip_planning` is killed mid-create — the planner backend outage
 * scenario — `createTrip` has already persisted a `draft` that counts against
 * `max_active_trips` (see `OPEN_TRIP_STATUSES`). TripCreateScreen deletes that
 * orphan on the kill path, but the delete can fail for the SAME outage. There
 * is no delete-trip UI in the app, so a swallowed failure would strand the
 * draft in the rider's sole Free slot with no way to recover.
 *
 * So the delete routes through here: a failed cleanup PERSISTS the draft id and
 * a foreground/cold-start drain (`tripDraftCleanupMonitor`) retries it until the
 * backend confirms it's gone. Storage mirrors `rideStopReconciler`: MMKV with an
 * in-memory fallback so the module imports cleanly under jest, and an on-device
 * MMKV init failure is SURFACED (logged) rather than silently hiding lost
 * durability.
 */

import { api, ApiError } from "./api";

interface CacheStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PENDING_STORAGE_ID = "tarmoto-trip-draft-cleanup";
const PENDING_KEY = "ids";

const IS_TEST_ENV =
  typeof process !== "undefined" && !!process.env?.JEST_WORKER_ID;

function createMemoryStorage(): CacheStorage {
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
  } catch (error) {
    if (!IS_TEST_ENV) {
      console.warn(
        "[tripDraftCleanup] MMKV unavailable — orphaned trip drafts will NOT " +
          "survive a restart; falling back to in-memory storage",
        error,
      );
    }
    return createMemoryStorage();
  }
}

let storage: CacheStorage = createStorage();

/**
 * A pending cleanup, scoped to the rider who OWNS the draft. `DELETE /trips/:id`
 * deliberately 404s for a non-owner, so a queued delete must only ever be
 * retried with THAT rider's token — otherwise a different sign-in on the same
 * install would 404-and-discard the entry while the draft still consumes the
 * owner's slot.
 */
interface PendingDraft {
  tripId: string;
  ownerId: string;
}

/** Draft ids whose delete is in flight, so a concurrent call reuses it. */
const inFlight = new Map<string, Promise<void>>();

function readPending(): PendingDraft[] {
  const raw = storage.getString(PENDING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (v): v is PendingDraft =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as PendingDraft).tripId === "string" &&
          typeof (v as PendingDraft).ownerId === "string",
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

function writePending(entries: PendingDraft[]): void {
  if (entries.length === 0) storage.remove(PENDING_KEY);
  else storage.set(PENDING_KEY, JSON.stringify(entries));
}

function addPending(entry: PendingDraft): void {
  const entries = readPending();
  if (!entries.some((e) => e.tripId === entry.tripId)) {
    writePending([...entries, entry]);
  }
}

function removePending(tripId: string): void {
  const entries = readPending();
  if (entries.some((e) => e.tripId === tripId)) {
    writePending(entries.filter((e) => e.tripId !== tripId));
  }
}

/**
 * Only a response that PROVES the draft is gone clears the queue: a 204 (deleted)
 * or a 404 (already absent). An auth failure (401/403 — a token refresh that
 * failed, or the draft not being ours yet under a stale session) or any 5xx /
 * network error is transient, so it stays pending for a later retry.
 */
function isProvenGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Delete an orphaned trip draft, reconciled. Resolves when the draft is deleted
 * OR already gone (idempotent). On any other failure it PERSISTS the id for a
 * later drain and swallows — this is best-effort background cleanup with no UI
 * to surface an error to.
 */
export function reconcileTripDraftCleanup(
  tripId: string,
  ownerId: string,
): Promise<void> {
  const existing = inFlight.get(tripId);
  if (existing) return existing;

  const run = (async () => {
    try {
      await api.deleteTrip(tripId);
      removePending(tripId);
    } catch (error) {
      if (isProvenGone(error)) {
        removePending(tripId);
        return;
      }
      // Transient / auth — keep the id (scoped to its owner) so a foreground
      // drain with THAT rider's token retries it.
      addPending({ tripId, ownerId });
    } finally {
      inFlight.delete(tripId);
    }
  })();

  inFlight.set(tripId, run);
  return run;
}

/**
 * Retry the persisted orphaned-draft deletes OWNED by `currentUserId` — the
 * signed-in rider whose token the delete will carry. Entries owned by a
 * different rider are left untouched (deleting them with the current token 404s
 * for a non-owner and would wrongly discard that rider's entry). Best-effort;
 * failures stay queued.
 */
export async function drainTripDraftCleanups(
  currentUserId: string,
): Promise<void> {
  const mine = readPending().filter((e) => e.ownerId === currentUserId);
  for (const entry of mine) {
    await reconcileTripDraftCleanup(entry.tripId, entry.ownerId);
  }
}

/** Test hook — swap the in-memory storage so each test starts clean. */
export function __setStorageForTest(next: CacheStorage): void {
  storage = next;
  inFlight.clear();
}

/** Test/diagnostic — the currently-persisted orphaned draft entries. */
export function __getPendingTripDraftCleanupsForTest(): PendingDraft[] {
  return readPending();
}
