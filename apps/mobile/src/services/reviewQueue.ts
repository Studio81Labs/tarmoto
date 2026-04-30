/**
 * Offline-aware queue for road-segment reviews — US-25 AC #2.
 *
 * Riders compose reviews curbside on poor cellular: the photo picker is
 * forgiving but the network often isn't. This module is a durable FIFO
 * buffer between RoadPreviewScreen's submit handler and the live POST,
 * mirroring `hazardQueue.ts`:
 *
 *   1. Caller hands a payload to `submitReviewWithQueue(...)`.
 *   2. Any backlog from earlier offline submits is drained first
 *      (oldest-first) so segments stay in the order the rider tapped
 *      Submit.
 *   3. If the live POST fails for connectivity / transient-server
 *      reasons the payload is enqueued and the call resolves as
 *      `queued`; the rider can keep riding without a retry loop in
 *      their face.
 *   4. Retries happen on the next successful-looking call or an
 *      explicit `drainReviewQueue()`.
 *
 * Edits and deletes go straight to the network — they only make sense
 * when there's already a server-side review with an id, and that
 * round-trip already confirmed connectivity. The queue is for the
 * tap-Submit-on-the-shoulder-of-the-road create case where losing the
 * payload would be the worst outcome.
 *
 * Photos: this queue assumes photos have already been uploaded and
 * the payload's `photos` array contains URLs the backend returned.
 * The form uploads each photo before invoking this submit so a
 * network drop after photo upload but before the review POST still
 * preserves the URLs — re-uploading the same files (and re-billing
 * storage) on every retry would be much worse than a small extra
 * round-trip up front.
 */

import {
  isNetworkDownError,
  isRetriableError,
  isTransientServerError,
} from "./networkErrors";
import type { RoadReview } from "@/types";

// ── Types ──

export interface ReviewSubmissionPayload {
  segmentId: string;
  rating: number;
  /**
   * `null` explicitly clears the field (used on the update path so a
   * cleared comment makes it onto the wire — `JSON.stringify` strips
   * `undefined`, which would let a permissive PUT handler read it as
   * "keep existing value"). Use `undefined` on create to omit the
   * field entirely. Same convention for `bikeModel` and `photos`.
   */
  comment?: string | null;
  bikeModel?: string | null;
  /** URLs of photos already persisted on Tarmoto media storage. */
  photos?: string[] | null;
}

export interface PendingReview extends ReviewSubmissionPayload {
  id: string;
  enqueuedAt: number;
  attempts: number;
}

export type SubmitStatus = "uploaded" | "queued";

export interface SubmitReviewResult {
  status: SubmitStatus;
  /** Server-side review row, present only on `uploaded`. */
  review?: RoadReview;
  pending: number;
}

export interface DrainReviewResult {
  flushed: number;
  remaining: number;
  /**
   * True only when the drain stopped because the link itself is down.
   * Lets `submitReviewWithQueue` skip its live call. A non-zero
   * `remaining` could equally be a poison pill awaiting its retry
   * budget.
   */
  networkFailed: boolean;
  /**
   * True when the drain stopped because the server returned a transient
   * fault (5xx / 408 / 429). Treat as networkFailed for the purpose of
   * "queue, don't go live" so a fresh review doesn't ship before older
   * queued ones — same FIFO rationale as hazardQueue.
   */
  transientServerError: boolean;
}

/** Callback used to actually POST one payload. Injected for testability. */
export type ReviewUploader = (
  payload: ReviewSubmissionPayload,
) => Promise<RoadReview>;

interface QueueStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ── Storage ──

const QUEUE_STORAGE_ID = "tarmoto-review-queue";
const QUEUE_KEY = "pending";

function createQueueStorage(): QueueStorage {
  try {
    // Lazy require — the native MMKV binding isn't available in jest,
    // so the module must still load with an in-memory fallback (same
    // shape as hazardQueue / offlineQueue).
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
let drainInFlight: Promise<DrainReviewResult> | null = null;

function readQueue(): PendingReview[] {
  const raw = storage.getString(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingReview);
  } catch {
    return [];
  }
}

function isPendingReview(value: unknown): value is PendingReview {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PendingReview>;
  return (
    typeof v.id === "string" &&
    typeof v.segmentId === "string" &&
    typeof v.rating === "number" &&
    typeof v.enqueuedAt === "number" &&
    typeof v.attempts === "number"
  );
}

function writeQueue(next: PendingReview[]): void {
  if (next.length === 0) {
    storage.remove(QUEUE_KEY);
  } else {
    storage.set(QUEUE_KEY, JSON.stringify(next));
  }
}

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function removeById(id: string): void {
  writeQueue(readQueue().filter((e) => e.id !== id));
}

function replaceById(id: string, next: PendingReview): void {
  writeQueue(readQueue().map((e) => (e.id === id ? next : e)));
}

function pendingPayload(entry: PendingReview): ReviewSubmissionPayload {
  return {
    segmentId: entry.segmentId,
    rating: entry.rating,
    comment: entry.comment,
    bikeModel: entry.bikeModel,
    photos: entry.photos,
  };
}

// ── Public API ──

export async function submitReviewWithQueue(
  payload: ReviewSubmissionPayload,
  uploader: ReviewUploader,
): Promise<SubmitReviewResult> {
  // Drain backlog first so reviews stay in the order the rider tapped
  // Submit. Gate on the drain's stop reasons (`networkFailed`,
  // `transientServerError`), NOT on `remaining > 0` — a non-zero
  // `remaining` could equally be a 4xx poison pill awaiting its retry
  // budget, in which case the link and server are both fine and a
  // healthy fresh review should still go live.
  const drain = await drainReviewQueue(uploader);

  if (drain.networkFailed || drain.transientServerError) {
    enqueueReview(payload);
    return { status: "queued", pending: getPendingCount() };
  }

  try {
    const review = await uploader(payload);
    return { status: "uploaded", review, pending: getPendingCount() };
  } catch (error) {
    if (isRetriableError(error)) {
      enqueueReview(payload);
      return { status: "queued", pending: getPendingCount() };
    }
    // 4xx (other than 408/429) propagates — caller-actionable: bad
    // payload, expired auth, or a 409 duplicate-review the caller
    // wants to translate into "open the existing review for editing".
    throw error;
  }
}

export function drainReviewQueue(
  uploader: ReviewUploader,
): Promise<DrainReviewResult> {
  if (drainInFlight) return drainInFlight;

  const run = async (): Promise<DrainReviewResult> => {
    let flushed = 0;
    let networkFailed = false;
    let transientServerError = false;
    // Touch each item at most once per drain so a poison pill doesn't
    // burn its three attempts in a tight loop and starve healthy items
    // queued behind it.
    const attemptedThisDrain = new Set<string>();
    while (true) {
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
          transientServerError = true;
          break;
        }
        next.attempts += 1;
        if (next.attempts >= 3) {
          // Drop the poison pill so it can't starve healthy entries
          // behind it. 4xx most often means a duplicate-review (409)
          // the rider already resolved by editing, expired auth the
          // next session will repair, or a payload mismatch the rider
          // can't fix without retrying — three attempts is
          // conservative enough that transient blips don't drop
          // legitimate reviews.
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
    };
  };

  drainInFlight = run().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

export function enqueueReview(payload: ReviewSubmissionPayload): PendingReview {
  const entry: PendingReview = {
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

export function getPendingReviews(): PendingReview[] {
  return readQueue();
}

// ── Test hooks ──

export function __setStorageForTest(next: QueueStorage): void {
  storage = next;
  drainInFlight = null;
}
