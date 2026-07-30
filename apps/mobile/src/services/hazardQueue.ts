/**
 * Offline-aware queue for hazard reports — US-4 AC #6.
 *
 * Riders report hazards mid-ride; cellular drops are common in tunnels,
 * forests, and mountain passes — exactly the places where hazard reports
 * are most valuable. This module is a durable FIFO buffer sitting between
 * the HazardReportScreen submit handler and the live POST:
 *
 *   1. Caller hands a payload to `submitHazardReport(...)`.
 *   2. Any backlog from earlier offline reports is drained first
 *      (oldest-first) so the chronological order on the server matches
 *      the order the rider tapped Submit.
 *   3. If the live POST fails for connectivity / transient-server
 *      reasons, the payload is enqueued and the call resolves as
 *      `queued`. The rider is already back to riding — we don't want a
 *      retry loop bubbling into a UI they've left.
 *   4. Retries happen on the next successful-looking call or an
 *      explicit `drainHazardQueue()` (e.g. a future "Retry now" button
 *      on the rider's pending-reports list).
 *
 * The architecture mirrors `offlineQueue.ts` (sensor uploads). Photo
 * attachments ride along as a `photoUri`: until the backend file-upload
 * endpoint lands the URI is kept locally so that a future drain can
 * include it without forcing the rider to recapture.
 */

import type { Hazard, HazardType, Severity } from "@/types";
import {
  isNetworkDownError,
  isRetriableError,
  isTransientServerError,
} from "./networkErrors";
import { isFeatureKillSwitchActive } from "./systemSwitchCache";

// ── Types ──

export interface HazardReportPayload {
  lat: number;
  lng: number;
  hazardType: HazardType;
  severity: Severity;
  note?: string | undefined;
  /**
   * Local URI of an optional photo attachment (camera or library). Kept
   * in the queue entry so that when the backend file-upload endpoint
   * lands, the drain can re-read the file and ship it without losing
   * the rider's original capture. Today's uploader ignores it.
   */
  photoUri?: string | undefined;
}

export interface PendingHazardReport extends HazardReportPayload {
  id: string;
  enqueuedAt: number;
  attempts: number;
}

export type SubmitStatus = "uploaded" | "queued";

export interface SubmitHazardResult {
  status: SubmitStatus;
  /** Server-side hazard, present only on `uploaded` */
  hazard?: Hazard;
  pending: number;
}

export interface DrainHazardResult {
  flushed: number;
  remaining: number;
  /**
   * True only when the drain stopped because the link itself is down —
   * lets `submitHazardReport` skip its live call. A non-zero `remaining`
   * could equally be a poison pill awaiting its retry budget.
   */
  networkFailed: boolean;
  /**
   * True when the drain stopped because the server returned a transient
   * fault (5xx / 408 / 429) rather than because the link is down. The
   * link is fine, but pushing a fresh live report now would (a) pile on
   * a struggling backend and (b) ship the new hazard before the older
   * queued ones, breaking the FIFO order the rest of the pipeline
   * assumes. Callers should treat this the same as `networkFailed` for
   * the purpose of "queue, don't go live".
   */
  transientServerError: boolean;
  /**
   * True when the drain stopped because the `hazard_reporting` operator kill
   * switch was flipped off mid-drain. Callers must treat this the same as the
   * other stop reasons — queue the fresh report, don't POST it — so a live
   * submit racing the kill doesn't slip a report past the disabled switch.
   */
  killed: boolean;
}

/** Callback used to actually POST one report. Injected for testability. */
export type HazardUploader = (payload: HazardReportPayload) => Promise<Hazard>;

interface QueueStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ── Storage ──

const QUEUE_STORAGE_ID = "tarmoto-hazard-queue";
const QUEUE_KEY = "pending";

function createQueueStorage(): QueueStorage {
  try {
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

let storage: QueueStorage = createQueueStorage();
let drainInFlight: Promise<DrainHazardResult> | null = null;
const listeners = new Set<(pending: number) => void>();

function readQueue(): PendingHazardReport[] {
  const raw = storage.getString(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingHazardReport);
  } catch {
    return [];
  }
}

function isPendingHazardReport(value: unknown): value is PendingHazardReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PendingHazardReport>;
  return (
    typeof v.id === "string" &&
    typeof v.lat === "number" &&
    typeof v.lng === "number" &&
    typeof v.hazardType === "string" &&
    typeof v.severity === "string" &&
    typeof v.enqueuedAt === "number" &&
    typeof v.attempts === "number"
  );
}

function writeQueue(next: PendingHazardReport[]): void {
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
      // A misbehaving listener shouldn't break the queue.
    }
  }
}

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function removeById(id: string): void {
  writeQueue(readQueue().filter((e) => e.id !== id));
}

function replaceById(id: string, next: PendingHazardReport): void {
  writeQueue(readQueue().map((e) => (e.id === id ? next : e)));
}

function pendingPayload(entry: PendingHazardReport): HazardReportPayload {
  return {
    lat: entry.lat,
    lng: entry.lng,
    hazardType: entry.hazardType,
    severity: entry.severity,
    note: entry.note,
    photoUri: entry.photoUri,
  };
}

// ── Public API ──

export async function submitHazardReport(
  payload: HazardReportPayload,
  uploader: HazardUploader,
): Promise<SubmitHazardResult> {
  // Drain backlog first so reports stay in the order the rider tapped
  // Submit. Gate on the drain's stop reasons (`networkFailed`,
  // `transientServerError`), NOT on `remaining > 0` — a non-zero
  // `remaining` could equally be a 4xx poison pill awaiting its retry
  // budget, in which case the link and server are both fine and a
  // healthy fresh report should still go live.
  const drain = await drainHazardQueue(uploader);

  if (drain.networkFailed || drain.transientServerError || drain.killed) {
    // Skip the live call when the drain stopped on any of:
    //   - networkFailed → link is down
    //   - transientServerError → backend is struggling, and shipping a
    //     fresh report past the older queued ones would also break FIFO
    //   - killed → the operator disabled `hazard_reporting` mid-drain; a fresh
    //     report racing the kill must be held, not POSTed past the switch
    enqueueHazardReport(payload);
    return { status: "queued", pending: getPendingCount() };
  }

  // Final recheck before the live POST: covers the window the drain's `killed`
  // signal can't (an EMPTY queue drains without ever looping, so `killed` stays
  // false even if the switch is now off). Hold the report instead of POSTing.
  if (!isFeatureKillSwitchActive("hazard_reporting")) {
    enqueueHazardReport(payload);
    return { status: "queued", pending: getPendingCount() };
  }

  try {
    const hazard = await uploader(payload);
    return { status: "uploaded", hazard, pending: getPendingCount() };
  } catch (error) {
    if (isRetriableError(error)) {
      enqueueHazardReport(payload);
      return { status: "queued", pending: getPendingCount() };
    }
    // 4xx (other than 408/429) propagates: bad payload or expired auth
    // is caller-actionable and retrying the same bytes won't help.
    throw error;
  }
}

export function drainHazardQueue(
  uploader: HazardUploader,
): Promise<DrainHazardResult> {
  if (drainInFlight) return drainInFlight;

  const run = async (): Promise<DrainHazardResult> => {
    let flushed = 0;
    let networkFailed = false;
    let transientServerError = false;
    let killed = false;
    // Touch each item at most once per drain so a poison pill doesn't
    // burn its three attempts in a tight loop and starve healthy items
    // queued behind it.
    const attemptedThisDrain = new Set<string>();
    while (true) {
      // Operator kill switch (`hazard_reporting`): if it flips off mid-drain,
      // stop immediately and RETAIN the remaining queue — the drain is the same
      // POST path as a live submit, so an abuse-wave / moderation kill must
      // halt it per-item, not just at entry. Reports drain once re-enabled.
      // Signalled to `submitHazardReport` so a fresh live report racing the
      // kill is queued rather than POSTed.
      if (!isFeatureKillSwitchActive("hazard_reporting")) {
        killed = true;
        break;
      }
      const queue = readQueue();
      const next = queue.find((e) => !attemptedThisDrain.has(e.id));
      if (!next) break;
      attemptedThisDrain.add(next.id);
      try {
        await uploader(pendingPayload(next));
        removeById(next.id);
        flushed += 1;
      } catch (error) {
        if (isNetworkDownError(error)) {
          networkFailed = true;
          break;
        }
        if (isTransientServerError(error)) {
          // Server hiccup: keep queued, stop draining, don't burn a
          // retry attempt, AND signal the stop reason so the submit
          // path skips its live call (otherwise a fresh report would
          // ship before older queued ones, breaking FIFO).
          transientServerError = true;
          break;
        }
        next.attempts += 1;
        if (next.attempts >= 3) {
          removeById(next.id);
        } else {
          replaceById(next.id, next);
        }
      }
    }
    return {
      flushed,
      remaining: getPendingCount(),
      networkFailed,
      transientServerError,
      killed,
    };
  };

  drainInFlight = run().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

export function enqueueHazardReport(
  payload: HazardReportPayload,
): PendingHazardReport {
  const entry: PendingHazardReport = {
    ...payload,
    id: nextId(),
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

export function getPendingHazardReports(): PendingHazardReport[] {
  return readQueue();
}

export function clearHazardQueue(): void {
  writeQueue([]);
}

export function subscribePending(
  listener: (pending: number) => void,
): () => void {
  listeners.add(listener);
  listener(getPendingCount());
  return () => {
    listeners.delete(listener);
  };
}

// ── Test hooks ──

export function __setStorageForTest(next: QueueStorage): void {
  storage = next;
  drainInFlight = null;
  listeners.clear();
}
