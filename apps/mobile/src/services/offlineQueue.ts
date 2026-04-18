/**
 * Offline sensor-upload queue — US-18 AC #4.
 *
 * Rides captured while the phone is offline (tunnel, rural area, airplane
 * mode) must not lose their sensor contributions. This module is a durable
 * FIFO buffer sitting between the ride-stop handler and the network layer:
 *
 *   1. Callers hand payloads to `submitSensorUpload(...)`.
 *   2. If the network is reachable the payload is POSTed immediately and
 *      any backlog is flushed in the same pass (oldest-first) so older
 *      rides aren't starved by the freshly-finished one.
 *   3. If the POST fails for network reasons the payload is enqueued and
 *      the call resolves as `queued` — the ride is already over, we don't
 *      want to bubble the error into UI that can't act on it.
 *   4. Retries happen on the next successful-looking call or an explicit
 *      `drainOfflineQueue()` (the Settings screen exposes a manual retry).
 *
 * Non-goals covered by other ACs/issues:
 *   - Offline tile packs and offline routing (US-18 AC #1-3)
 *   - Background triggers on connectivity change (needs @react-native-
 *     community/netinfo + a native background task; follow-up)
 *   - HTTP 4xx handling with exponential backoff (malformed payloads
 *     shouldn't block the queue forever — tracked separately; for now we
 *     drop 4xx items and keep going)
 */

import type { AxiosError } from "axios";
import type { SensorReading } from "@/types";

// ── Types ──

export interface PendingUpload {
  /** Stable id so tests / UI can reference an entry without position. */
  id: string;
  rideId: string;
  deviceModel: string;
  readings: SensorReading[];
  enqueuedAt: number;
  attempts: number;
}

export type SubmitStatus = "uploaded" | "queued";

export interface SubmitResult {
  status: SubmitStatus;
  /** Rows accepted by the backend on the most recent live upload. */
  accepted: number;
  /** Road segments touched by the most recent live upload. */
  segmentsUpdated: number;
  /** Count of entries still pending after this call. */
  pending: number;
}

export interface DrainResult {
  flushed: number;
  /** Entries that couldn't be flushed — either network-blocked or dropped. */
  remaining: number;
  /**
   * True only when the drain stopped because a retriable network error
   * told us the link is down. Callers gate "skip the live call" on this,
   * not on `remaining > 0`: a non-zero `remaining` could equally be a
   * poison pill waiting to be retried — in that case the network is
   * fine and fresh payloads should still go live.
   */
  networkFailed: boolean;
}

/** Callback used to actually POST one payload. Injected for testability. */
export type SensorUploader = (
  rideId: string,
  readings: SensorReading[],
  deviceModel: string,
) => Promise<{ accepted: number; segments_updated: number }>;

interface QueueStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ── Storage ──

const QUEUE_STORAGE_ID = "tarmoto-sensor-queue";
const QUEUE_KEY = "pending";

function createQueueStorage(): QueueStorage {
  try {
    // Lazy require — the native MMKV binding isn't available in jest, so the
    // module must still load with an in-memory fallback (same pattern as
    // stores/index.ts). This keeps the service trivially unit-testable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } =
      require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: QUEUE_STORAGE_ID });
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

// ── Queue core ──
// State is module-local on purpose: the queue is a singleton per app
// install (there's only one MMKV file backing it) and lifting it to a
// store would just add indirection. The `__setStorageForTest` export lets
// tests swap in a fresh shim between cases without touching MMKV.

let storage: QueueStorage = createQueueStorage();
// Holds the promise for the currently-running drain (if any) so
// concurrent callers can await it and reuse its DrainResult instead of
// short-circuiting with a synthetic "backlog blocked" reply that races
// the real flush. A boolean lock would force the second caller to
// guess the network state — returning the in-flight promise lets them
// act on the actual outcome.
let drainInFlight: Promise<DrainResult> | null = null;
const listeners = new Set<(pending: number) => void>();

function readQueue(): PendingUpload[] {
  const raw = storage.getString(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // A corrupt MMKV blob from a crashed write shouldn't brick the queue
    // on next launch. Anything that doesn't look like a PendingUpload gets
    // dropped silently — the ride is already lost, logging it to the
    // rider would be noise they can't act on.
    return parsed.filter(isPendingUpload);
  } catch {
    return [];
  }
}

function isPendingUpload(value: unknown): value is PendingUpload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PendingUpload>;
  return (
    typeof v.id === "string" &&
    typeof v.rideId === "string" &&
    typeof v.deviceModel === "string" &&
    Array.isArray(v.readings) &&
    typeof v.enqueuedAt === "number" &&
    typeof v.attempts === "number"
  );
}

function writeQueue(next: PendingUpload[]): void {
  if (next.length === 0) {
    storage.remove(QUEUE_KEY);
  } else {
    storage.set(QUEUE_KEY, JSON.stringify(next));
  }
  notify(next.length);
}

function notify(pending: number): void {
  for (const listener of listeners) {
    try {
      listener(pending);
    } catch {
      // A misbehaving listener shouldn't block the rest — the queue is
      // the authoritative state and we already persisted before notifying.
    }
  }
}

function nextId(): string {
  // Good-enough uniqueness: monotonic timestamp + random suffix. The queue
  // never holds millions of items; a UUID lib would be a dep for no gain.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Error classification ──

function isRetriableNetworkError(error: unknown): boolean {
  // Anything that made it to the server (`response.status` set) isn't a
  // connectivity failure — the server either accepted, rejected, or
  // throttled us. Retrying those on the queue would be spinning.
  if (typeof error !== "object" || error === null) return false;
  const axiosErr = error as AxiosError;
  if (axiosErr.response) return false;
  // Axios v1 surfaces disconnects as ERR_NETWORK / ECONNABORTED / ETIMEDOUT
  // depending on whether the request reached the socket before failing.
  const code = axiosErr.code ?? "";
  if (
    code === "ERR_NETWORK" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }
  // Some error shapes (fetch polyfills, Android's NSURLErrorNotConnected)
  // only surface a message. The substring check is conservative: a
  // server-shaped error would have `response` set and exit earlier.
  const message = typeof axiosErr.message === "string" ? axiosErr.message : "";
  return /network|timeout|offline|disconnected/i.test(message);
}

// ── Public API ──

/**
 * Submit a sensor payload. If the network call succeeds the payload (and
 * any backlog) is uploaded live. If the network call fails for
 * connectivity reasons the payload is enqueued and the caller still gets
 * a successful `SubmitResult` with `status: "queued"` — the ride is
 * already over, we don't want to bubble a retry into the UI.
 *
 * Non-network failures (4xx, 5xx) propagate — those are caller-actionable
 * bugs (bad payload, auth) or server outages that the queue can't fix.
 */
export async function submitSensorUpload(
  rideId: string,
  readings: SensorReading[],
  deviceModel: string,
  uploader: SensorUploader,
): Promise<SubmitResult> {
  // Flush the backlog first so rides stay chronologically ordered on the
  // server — otherwise a fresh ride would land before older queued ones
  // and the backend's "newest data wins" aggregation would re-rank older
  // evidence below newer. If the flush hits a network error mid-way, the
  // current payload falls through to the same enqueue path below.
  //
  // Gate on `networkFailed`, not `remaining > 0`: poison pills (HTTP
  // 4xx awaiting their 3rd attempt) sit in the queue without meaning the
  // network is down, and a healthy fresh upload shouldn't be delayed
  // behind them. If the link really is down, `networkFailed` is set.
  const drain = await drainOfflineQueue(uploader);

  if (drain.networkFailed) {
    // Don't even try the live call — we already know the network is down.
    enqueueUpload(rideId, readings, deviceModel);
    return {
      status: "queued",
      accepted: 0,
      segmentsUpdated: 0,
      pending: getPendingCount(),
    };
  }

  try {
    const { accepted, segments_updated } = await uploader(
      rideId,
      readings,
      deviceModel,
    );
    return {
      status: "uploaded",
      accepted,
      segmentsUpdated: segments_updated,
      pending: getPendingCount(),
    };
  } catch (error) {
    if (isRetriableNetworkError(error)) {
      enqueueUpload(rideId, readings, deviceModel);
      return {
        status: "queued",
        accepted: 0,
        segmentsUpdated: 0,
        pending: getPendingCount(),
      };
    }
    throw error;
  }
}

/**
 * Attempt to flush every pending upload, oldest-first. Stops at the first
 * network error (keeps the rest for later). Non-network errors cause the
 * offending entry to be dropped so one poisoned payload can't brick the
 * queue — those are almost always auth or malformed-body issues that
 * retrying won't fix.
 *
 * Safe to call concurrently: a second invocation while the first is
 * running is a no-op.
 */
export function drainOfflineQueue(
  uploader: SensorUploader,
): Promise<DrainResult> {
  // Concurrent callers get the exact same promise so they see the real
  // outcome instead of a stub reply that would race the in-flight flush.
  if (drainInFlight) return drainInFlight;

  const run = async (): Promise<DrainResult> => {
    let flushed = 0;
    let networkFailed = false;
    // Each drain touches every item at most once. Without this guard, a
    // poison pill (HTTP 4xx) would be retried three times back-to-back
    // in the same call — `replaceById` keeps the failed entry at index
    // 0, so re-reading and picking `queue[0]` loops on the same payload
    // until `attempts` hits the drop threshold. That wastes server
    // capacity and starves healthy items behind it. Skipping ids we've
    // already tried this pass means the next iteration moves past the
    // poison to the next entry and the three attempts spread across
    // three drain calls, matching the original design intent.
    const attemptedThisDrain = new Set<string>();
    while (true) {
      const queue = readQueue();
      // Re-read each iteration so a concurrent enqueue isn't silently
      // overwritten, but skip anything we've already handled this pass.
      const next = queue.find((e) => !attemptedThisDrain.has(e.id));
      if (!next) break;
      attemptedThisDrain.add(next.id);
      try {
        await uploader(next.rideId, next.readings, next.deviceModel);
        // Matching by id is position-independent — if enqueueUpload ran
        // while we awaited, the freshly-added entry stays intact.
        removeById(next.id);
        flushed += 1;
      } catch (error) {
        if (isRetriableNetworkError(error)) {
          // Still offline. Leave the rest for the next drain and tell
          // the caller why we stopped so they can skip their live call.
          networkFailed = true;
          break;
        }
        // Poison pill: bump attempts; if we've seen it too many times,
        // drop it so one bad payload doesn't block every other ride.
        // `attempts` exists partly so a future UI could surface stuck
        // items — for now the threshold is conservative.
        next.attempts += 1;
        if (next.attempts >= 3) {
          removeById(next.id);
        } else {
          replaceById(next.id, next);
        }
        // Don't count poison retries as flushed, but keep draining — the
        // next item might be healthy.
      }
    }
    return { flushed, remaining: getPendingCount(), networkFailed };
  };

  drainInFlight = run().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

/** Append one entry to the queue. Exported mainly for tests. */
export function enqueueUpload(
  rideId: string,
  readings: SensorReading[],
  deviceModel: string,
): PendingUpload {
  const entry: PendingUpload = {
    id: nextId(),
    rideId,
    deviceModel,
    readings,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);
  return entry;
}

export function getPendingCount(): number {
  return readQueue().length;
}

export function getPendingUploads(): PendingUpload[] {
  return readQueue();
}

/** Reset the queue (used by tests and by a future "forget pending" action). */
export function clearOfflineQueue(): void {
  writeQueue([]);
}

/**
 * Subscribe to pending-count changes. Returns an unsubscribe function.
 * React components can drive badges/indicators off this directly.
 */
export function subscribePending(
  listener: (pending: number) => void,
): () => void {
  listeners.add(listener);
  // Fire once on subscribe so callers don't need to read the count
  // separately — matches the ergonomics of a Zustand selector.
  listener(getPendingCount());
  return () => {
    listeners.delete(listener);
  };
}

function removeById(id: string): void {
  const queue = readQueue().filter((e) => e.id !== id);
  writeQueue(queue);
}

function replaceById(id: string, next: PendingUpload): void {
  const queue = readQueue().map((e) => (e.id === id ? next : e));
  writeQueue(queue);
}

// ── Test hooks ──
// Exposed for unit tests so each case starts with a clean in-memory
// shim. Not exported from the package's index — call sites should use
// `clearOfflineQueue()` instead.
export function __setStorageForTest(next: QueueStorage): void {
  storage = next;
  drainInFlight = null;
  listeners.clear();
}
