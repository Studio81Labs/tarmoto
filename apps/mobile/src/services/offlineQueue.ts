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

import type { SensorReading } from "@/types";
import type { CalibrationPayload, RideTagEvent } from "@tarmoto/shared";
import {
  isNetworkDownError,
  isRetriableError,
  isTransientServerError,
} from "./networkErrors";
import { canContributeRoadData } from "./privacyCache";
import { isSystemSwitchEnabled } from "./systemSwitchCache";

// ── Types ──

export interface PendingUpload {
  /** Stable id so tests / UI can reference an entry without position. */
  id: string;
  rideId: string;
  deviceModel: string;
  readings: SensorReading[];
  /**
   * On-device classifier identifier when the TF Lite model produced the
   * window-level outputs in this batch (US-3). `null` means the v0 RMS
   * heuristic fired for the whole batch. Optional in the persisted blob
   * because rides queued before the field was introduced predate the
   * ML rollout — they're treated as `null` on read.
   */
  modelVersion: string | null;
  /**
   * On-device preprocessing pipeline marker (issue #493) at the time
   * the ride was captured. `null` means "no marker" — the readings
   * were not low-pass-filtered on the client, which is the correct
   * label for any ride queued by a pre-#493 app build that's drained
   * after the user upgrades. Without this field the drain would tag
   * legacy raw-axis payloads as `lp22-v1` and defeat the marker for
   * exactly the mixed-client case it's designed to separate.
   *
   * Optional in the persisted blob so older queue entries deserialise
   * to `null` rather than failing validation.
   */
  preprocessingVersion: string | null;
  /**
   * Rider-asserted surface tags captured during the ride (research
   * issue #7). Optional in the persisted blob: rides queued by an app
   * build that pre-dates the tagging UI deserialise to `[]` so the
   * uploader can keep its argument shape stable.
   */
  tagEvents: RideTagEvent[];
  /**
   * Idle-baseline calibration captured at ride start (issue #494).
   * `null` when the rider's calibration window was abandoned (sub-
   * minimum sample count). Optional in the persisted blob — rides
   * queued by an older app build deserialise to `null` so the
   * uploader can keep its argument shape stable.
   */
  calibration: CalibrationPayload | null;
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
  /**
   * True when the drain stopped because the server returned a transient
   * fault (5xx / 408 / 429) rather than because the link is down. The
   * link itself is fine, but pushing a fresh live payload now would (a)
   * pile on a struggling backend and (b) ship the new ride before the
   * older queued ones, breaking the FIFO order the rest of the pipeline
   * assumes. Callers should treat this the same as `networkFailed` for
   * the purpose of "queue, don't go live".
   */
  transientServerError: boolean;
}

/** Callback used to actually POST one payload. Injected for testability. */
export type SensorUploader = (
  rideId: string,
  readings: SensorReading[],
  deviceModel: string,
  modelVersion: string | null,
  tagEvents: RideTagEvent[],
  preprocessingVersion: string | null,
  calibration: CalibrationPayload | null,
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
    return parsed.filter(isPendingUpload).map((entry) => ({
      ...entry,
      // Pre-US-3 entries are `undefined` here — normalise to `null`
      // so the rest of the pipeline can rely on a strict shape.
      modelVersion: entry.modelVersion ?? null,
      // Pre-#7 entries lack the field entirely — normalise to `[]`
      // so downstream uploaders don't need a separate optional path.
      tagEvents: entry.tagEvents ?? [],
      // Pre-#493 entries lack this field. Normalise to `null` —
      // those rides captured raw axes, so the on-wire marker must
      // stay absent when they're eventually drained, matching the
      // backend's "null = raw axes" contract.
      preprocessingVersion: entry.preprocessingVersion ?? null,
      // Pre-#494 entries lack the field entirely — normalise to
      // `null` so the uploader can keep its argument shape stable.
      calibration: entry.calibration ?? null,
    }));
  } catch {
    return [];
  }
}

function isPendingUpload(value: unknown): value is PendingUpload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PendingUpload> & {
    modelVersion?: unknown;
    tagEvents?: unknown;
    preprocessingVersion?: unknown;
    calibration?: unknown;
  };
  // `modelVersion` is tolerated as `undefined` so entries persisted by
  // an older app build (pre-US-3) still round-trip — they're rewritten
  // with `null` on the next read via `readQueue`.
  const validModelVersion =
    v.modelVersion === undefined ||
    v.modelVersion === null ||
    typeof v.modelVersion === "string";
  // `tagEvents` is tolerated as `undefined` for the same backward-compat
  // reason (pre-#7 entries) — the read path normalises to `[]`.
  const validTagEvents =
    v.tagEvents === undefined || Array.isArray(v.tagEvents);
  // Same backward-compat for #493: pre-#493 entries lack the field
  // entirely and the read path normalises them to `null` (raw axes).
  const validPreprocessingVersion =
    v.preprocessingVersion === undefined ||
    v.preprocessingVersion === null ||
    typeof v.preprocessingVersion === "string";
  // `calibration` is tolerated as `undefined` so entries persisted by
  // an older app build (pre-#494) still round-trip — they're rewritten
  // with `null` on the next read via `readQueue`.
  const validCalibration =
    v.calibration === undefined ||
    v.calibration === null ||
    (typeof v.calibration === "object" && v.calibration !== null);
  return (
    typeof v.id === "string" &&
    typeof v.rideId === "string" &&
    typeof v.deviceModel === "string" &&
    Array.isArray(v.readings) &&
    validModelVersion &&
    validTagEvents &&
    validPreprocessingVersion &&
    validCalibration &&
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

// Error classification — see ./networkErrors.ts. Re-exporting nothing
// here on purpose: the classifiers are an implementation detail of every
// offline-aware queue, not part of this module's public contract.

// ── Public API ──

/**
 * Submit a sensor payload. If the network call succeeds the payload (and
 * any backlog) is uploaded live. If the network call fails for
 * connectivity reasons OR a transient server condition (5xx/408/429)
 * the payload is enqueued and the caller still gets a successful
 * `SubmitResult` with `status: "queued"` — the ride is already over,
 * we don't want to bubble a retry into the UI.
 *
 * Client-error failures (4xx other than 408/429) propagate — those are
 * caller-actionable bugs (bad payload, auth) the queue can't fix by
 * retrying the same bytes.
 */
export async function submitSensorUpload(
  rideId: string,
  readings: SensorReading[],
  deviceModel: string,
  modelVersion: string | null,
  tagEvents: RideTagEvent[],
  preprocessingVersion: string | null,
  calibration: CalibrationPayload | null,
  uploader: SensorUploader,
): Promise<SubmitResult> {
  // #279 / #501 — honour the rider's `road_data_contribution` opt-out
  // BEFORE touching the queue or the network. The backend also drops
  // an opted-out payload server-side (`SensorService.processUpload`),
  // but we suppress here too so an opt-out rider doesn't burn battery
  // / bandwidth shipping data the server will discard. Silent success
  // (`status: "uploaded"`, zeros) so the caller's stop-flow keeps
  // moving — surfacing an error here for an intentional opt-out
  // would confuse the rider.
  //
  // We also DROP any pre-opt-out backlog (Codex review on PR #513): a
  // queue entry was captured while consent was still ON, but the
  // rider's current preference is "don't send" — letting the
  // backlog replay later (after another submit / drainOfflineQueue
  // tick) would silently leak the rider's road data against their
  // current consent. Clearing the queue makes the opt-out take
  // effect for every payload that hasn't yet reached the server,
  // matching the intent of the toggle.
  if (!canContributeRoadData()) {
    clearOfflineQueue();
    return {
      status: "uploaded",
      accepted: 0,
      segmentsUpdated: 0,
      pending: getPendingCount(),
    };
  }

  // Operator kill switch (`sys_surface_upload`): an operator can pause surface
  // ingestion (e.g. ingest maintenance) without an app update. Unlike the
  // privacy opt-out above this is TEMPORARY — HOLD the data rather than dropping
  // it: queue the current payload and skip the drain + live POST so nothing
  // ships while the switch is off (the backend rejects it anyway, so uploading
  // would only churn retries). Everything drains once the operator re-enables
  // it. Fail SAFE (default ON), so the common path is unchanged.
  if (!isSystemSwitchEnabled("sys_surface_upload")) {
    enqueueUpload(
      rideId,
      readings,
      deviceModel,
      modelVersion,
      tagEvents,
      preprocessingVersion,
      calibration,
    );
    return {
      status: "queued",
      accepted: 0,
      segmentsUpdated: 0,
      pending: getPendingCount(),
    };
  }

  // Flush the backlog first so rides stay chronologically ordered on the
  // server — otherwise a fresh ride would land before older queued ones
  // and the backend's "newest data wins" aggregation would re-rank older
  // evidence below newer. If the flush hits a network error mid-way, the
  // current payload falls through to the same enqueue path below.
  //
  // Gate on the drain's stop reasons (`networkFailed`,
  // `transientServerError`), NOT on `remaining > 0`: poison pills (HTTP
  // 4xx awaiting their 3rd attempt) sit in the queue without meaning
  // the link or the server is unhealthy, so a healthy fresh upload
  // shouldn't be delayed behind them.
  const drain = await drainOfflineQueue(uploader);

  // #279 / #501 — recheck consent after the drain await (Codex
  // review on PR #513 r3212972527). The entry-point gate above
  // only catches an opt-out that was already in place when this
  // call started; a toggle that lands mid-drain (e.g. via a
  // concurrent privacy refresh after the companion flipped the
  // preference) would otherwise still hit the live `uploader(...)`
  // below for the fresh payload. Drop it cleanly: clear any
  // residual queue and return silent-success zeros, matching the
  // entry-point behaviour.
  if (!canContributeRoadData()) {
    clearOfflineQueue();
    return {
      status: "uploaded",
      accepted: 0,
      segmentsUpdated: 0,
      pending: getPendingCount(),
    };
  }

  if (drain.networkFailed || drain.transientServerError) {
    // Skip the live call:
    //   - networkFailed → link is down
    //   - transientServerError → backend is struggling, and shipping a
    //     fresh ride past the older queued ones would also break FIFO
    enqueueUpload(
      rideId,
      readings,
      deviceModel,
      modelVersion,
      tagEvents,
      preprocessingVersion,
      calibration,
    );
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
      modelVersion,
      tagEvents,
      preprocessingVersion,
      calibration,
    );
    return {
      status: "uploaded",
      accepted,
      segmentsUpdated: segments_updated,
      pending: getPendingCount(),
    };
  } catch (error) {
    if (isRetriableError(error)) {
      // #279 / #501 — recheck consent before enqueuing the
      // failed live upload (Codex review on PR #513
      // r3213030169). The rider may have toggled
      // `road_data_contribution` off WHILE the live request was
      // awaiting; without this gate, the catch path would store
      // the fresh ride payload under their now-off preference,
      // ready to be sent later if they opted back in.
      if (!canContributeRoadData()) {
        clearOfflineQueue();
        return {
          status: "uploaded",
          accepted: 0,
          segmentsUpdated: 0,
          pending: getPendingCount(),
        };
      }
      // Both connectivity drops and transient server faults land here —
      // either way the correct move is to preserve the ride data and
      // retry later, not surface a blocking error to the rider.
      enqueueUpload(
        rideId,
        readings,
        deviceModel,
        modelVersion,
        tagEvents,
        preprocessingVersion,
        calibration,
      );
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
  // #279 / #501 — opt-out gate fires BEFORE the in-flight reuse
  // (Codex review on PR #513 r3212984407). Otherwise a caller
  // arriving while a drain is active and after consent flipped
  // off would only get back the existing `drainInFlight` promise
  // and never trigger a clear; if the active loop then breaks on
  // a network error before its next per-iteration consent check,
  // the remaining backlog would stay persisted and could be
  // uploaded if the rider toggled consent back on later.
  //
  // Clearing here is safe even when a drain is in flight: the
  // active loop's next `readQueue()` returns `[]` after the wipe,
  // so it exits cleanly on its next iteration. At most one more
  // payload (the one currently being uploaded) ships before the
  // loop notices — that's acceptable: we can't cancel an in-flight
  // HTTP request without an `AbortController`, and the contract is
  // "stop sending NEW data after the toggle", not "abort the
  // current request mid-flight".
  if (!canContributeRoadData()) {
    clearOfflineQueue();
    return Promise.resolve({
      flushed: 0,
      remaining: 0,
      networkFailed: false,
      transientServerError: false,
    });
  }

  // Operator kill switch (`sys_surface_upload`): HOLD the backlog while an
  // operator has paused ingestion — stop draining without touching the queue so
  // it resumes intact when the switch flips back on. Fail SAFE (default ON).
  if (!isSystemSwitchEnabled("sys_surface_upload")) {
    return Promise.resolve({
      flushed: 0,
      remaining: getPendingCount(),
      networkFailed: false,
      transientServerError: false,
    });
  }

  // Concurrent callers get the exact same promise so they see the real
  // outcome instead of a stub reply that would race the in-flight flush.
  if (drainInFlight) return drainInFlight;

  const run = async (): Promise<DrainResult> => {
    let flushed = 0;
    let networkFailed = false;
    let transientServerError = false;
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
      // #279 / #501 — recheck the rider's consent on every
      // iteration (Codex review on PR #513 r3212972527). The
      // entry-point gate above only fires once per drain call,
      // so a long-running drain that started under consent could
      // otherwise keep uploading after the rider toggled the
      // preference off mid-flight (e.g. from the companion while
      // mobile is still flushing). Bail out cleanly: clear the
      // remaining backlog (the rider's current preference is
      // "don't send", which overrides past captures) and report
      // the in-progress drain's `flushed` count.
      if (!canContributeRoadData()) {
        clearOfflineQueue();
        break;
      }
      // Recheck the `sys_surface_upload` operator switch on EVERY iteration too
      // (not just at the entry gate above): if an operator flips it `force_off`
      // mid-drain — e.g. while an `await uploader(...)` is pending — HOLD as soon
      // as the cached switch flips instead of posting the next queued ride. The
      // backlog is retained intact (unlike the privacy opt-out) so it resumes
      // when the switch flips back on. Without this an active drain would keep
      // hammering the backend until each request's 503 broke the loop, which is
      // exactly the retry churn this change prevents.
      if (!isSystemSwitchEnabled("sys_surface_upload")) {
        break;
      }
      const queue = readQueue();
      // Re-read each iteration so a concurrent enqueue isn't silently
      // overwritten, but skip anything we've already handled this pass.
      const next = queue.find((e) => !attemptedThisDrain.has(e.id));
      if (!next) break;
      attemptedThisDrain.add(next.id);
      try {
        await uploader(
          next.rideId,
          next.readings,
          next.deviceModel,
          next.modelVersion,
          next.tagEvents,
          next.preprocessingVersion,
          next.calibration,
        );
        // Matching by id is position-independent — if enqueueUpload ran
        // while we awaited, the freshly-added entry stays intact.
        removeById(next.id);
        flushed += 1;
      } catch (error) {
        // #279 / #501 — recheck consent on the failure path
        // before we flag a stop reason (Codex review on PR #513
        // r3212930165). The rider may have toggled
        // `road_data_contribution` off WHILE the failing upload
        // was awaiting; without this check we'd return
        // `networkFailed`/`transientServerError` with the
        // backlog still persisted, and a later opt-in plus drain
        // could replay payloads captured against the rider's
        // current "don't send" preference. The poison-pill /
        // dropped-attempt branch below also shares this gate so
        // dropped items don't linger after a mid-flight opt-out.
        if (!canContributeRoadData()) {
          clearOfflineQueue();
          break;
        }
        if (isNetworkDownError(error)) {
          // Link is down. Leave the rest for the next drain and tell
          // the caller why we stopped so they can skip their live call.
          networkFailed = true;
          break;
        }
        if (isTransientServerError(error)) {
          // Server hiccup (5xx, rate limit, request timeout). The
          // payload is fine — retrying later is the right move. Stop
          // draining to avoid hammering a struggling backend, but keep
          // everything queued and flag the stop reason so the submit
          // path skips its live call (otherwise a fresh ride would
          // ship before older queued ones, breaking FIFO). The link
          // itself is fine, so `networkFailed` stays false. `attempts`
          // is untouched so a temporarily unhappy server doesn't burn
          // a payload's retry budget.
          transientServerError = true;
          break;
        }
        // Poison pill (4xx client error): bump attempts; if we've seen
        // it too many times, drop it so one bad payload doesn't block
        // every other ride. `attempts` exists partly so a future UI
        // could surface stuck items — for now the threshold is
        // conservative.
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
    return {
      flushed,
      remaining: getPendingCount(),
      networkFailed,
      transientServerError,
    };
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
  modelVersion: string | null,
  tagEvents: RideTagEvent[] = [],
  preprocessingVersion: string | null = null,
  calibration: CalibrationPayload | null = null,
): PendingUpload {
  const entry: PendingUpload = {
    id: nextId(),
    rideId,
    deviceModel,
    readings,
    modelVersion,
    tagEvents,
    preprocessingVersion,
    calibration,
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
