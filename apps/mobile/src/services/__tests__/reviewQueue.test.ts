/**
 * Review submission queue — US-25 AC #2.
 *
 * Mirrors hazardQueue/offlineQueue: the persistence layer falls back
 * to an in-memory shim under jest, and the focus is on the behaviour
 * the review form's submit handler depends on (live POST, queue on
 * disconnect, drain backlog before fresh submit, drop poison pills).
 */

import {
  __setStorageForTest,
  drainReviewQueue,
  enqueueReview,
  getPendingCount,
  getPendingReviews,
  submitReviewWithQueue,
  type ReviewSubmissionPayload,
  type ReviewUploader,
} from "../reviewQueue";
import type { RoadReview } from "@/types";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
  };
}

function makePayload(
  overrides: Partial<ReviewSubmissionPayload> = {},
): ReviewSubmissionPayload {
  return {
    segmentId: "seg-1",
    rating: 4,
    comment: "Smooth asphalt, great ride!",
    bikeModel: "BMW R1250GS",
    photos: ["https://api.tarmoto.test/uploads/road-review-photos/u-1.jpg"],
    ...overrides,
  };
}

function makeReview(overrides: Partial<RoadReview> = {}): RoadReview {
  return {
    id: "review-1",
    user_id: "user-1",
    user_display_name: "Rider",
    rating: 4,
    comment: null,
    bike_model: null,
    photos: [],
    created_at: "2026-04-30T10:00:00.000Z",
    helpful_count: 0,
    not_helpful_count: 0,
    my_vote: null,
    is_mine: true,
    ...overrides,
  };
}

function makeNetworkError(): Error {
  // Mirrors a fetch transport-level failure — message contains
  // "network", `status` is absent so the classifier flags it as
  // link-down rather than a server-returned error.
  return new Error("Network Error");
}

function makeServerError(status: number): Error {
  // Mirrors the `ApiError` shape the typed-client facade throws.
  const err = new Error(`HTTP ${status}`) as Error & { status?: number };
  err.status = status;
  return err;
}

describe("reviewQueue", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
  });

  describe("submitReviewWithQueue", () => {
    it("posts immediately when the network works", async () => {
      const uploader = jest.fn<
        ReturnType<ReviewUploader>,
        [ReviewSubmissionPayload]
      >(async () => makeReview());

      const result = await submitReviewWithQueue(
        makePayload(),
        uploader,
        "user-1",
      );

      expect(result.status).toBe("uploaded");
      expect(result.review?.id).toBe("review-1");
      expect(result.pending).toBe(0);
      expect(uploader).toHaveBeenCalledTimes(1);
    });

    it("queues the payload when the network is down", async () => {
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitReviewWithQueue(
        makePayload({ comment: "Pavement broke up after the bridge" }),
        uploader,
        "user-1",
      );

      expect(result.status).toBe("queued");
      expect(result.review).toBeUndefined();
      expect(result.pending).toBe(1);
      const pending = getPendingReviews();
      expect(pending).toHaveLength(1);
      // Photo URLs must round-trip so the next drain can re-submit
      // without re-uploading the bytes.
      expect(pending[0]?.photos).toEqual([
        "https://api.tarmoto.test/uploads/road-review-photos/u-1.jpg",
      ]);
    });

    it("queues on transient server errors (5xx / 408 / 429)", async () => {
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(503);
      });

      const result = await submitReviewWithQueue(
        makePayload(),
        uploader,
        "user-1",
      );

      expect(result.status).toBe("queued");
      expect(getPendingCount()).toBe(1);
    });

    it("propagates 4xx client errors (e.g. 409 duplicate review)", async () => {
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(409);
      });

      await expect(
        submitReviewWithQueue(makePayload(), uploader, "user-1"),
      ).rejects.toMatchObject({ status: 409 });
      // 4xx must not silently land in the queue — the form needs to
      // see the rejection and switch to edit mode.
      expect(getPendingCount()).toBe(0);
    });

    it("drains backlog before posting a fresh review (FIFO)", async () => {
      enqueueReview(makePayload({ rating: 2, segmentId: "seg-A" }), "user-1");
      const order: string[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        order.push(p.segmentId);
        return makeReview({ id: `r-${p.segmentId}` });
      });

      const result = await submitReviewWithQueue(
        makePayload({ rating: 5, segmentId: "seg-B" }),
        uploader,
        "user-1",
      );

      expect(result.status).toBe("uploaded");
      expect(result.review?.id).toBe("r-seg-B");
      expect(order).toEqual(["seg-A", "seg-B"]);
      expect(getPendingCount()).toBe(0);
    });

    it("skips the live call when the drain stops on a network error", async () => {
      enqueueReview(makePayload({ segmentId: "seg-A" }), "user-1");
      const calls: ReviewSubmissionPayload[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        calls.push(p);
        throw makeNetworkError();
      });

      const result = await submitReviewWithQueue(
        makePayload({ segmentId: "seg-B" }),
        uploader,
        "user-1",
      );

      expect(result.status).toBe("queued");
      expect(getPendingCount()).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.segmentId).toBe("seg-A");
    });

    it("does not flush entries belonging to a different signed-in user", async () => {
      // Regression: queue entries used to live without a userId, so a
      // review queued by user A while offline could upload under user
      // B's session after a sign-out / sign-in on the same device.
      // The drain now only flushes entries whose userId matches.
      enqueueReview(
        makePayload({ comment: "user-A's note", segmentId: "seg-A" }),
        "user-A",
      );
      const calls: ReviewSubmissionPayload[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        calls.push(p);
        return makeReview();
      });

      // user-B signs in; their fresh submit goes through but user-A's
      // queued payload stays put.
      const result = await submitReviewWithQueue(
        makePayload({ comment: "user-B's note", segmentId: "seg-B" }),
        uploader,
        "user-B",
      );

      expect(result.status).toBe("uploaded");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.comment).toBe("user-B's note");
      const remaining = getPendingReviews();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.userId).toBe("user-A");
    });
  });

  describe("drainReviewQueue", () => {
    it("flushes everything in order on a healthy link", async () => {
      enqueueReview(makePayload({ segmentId: "a" }), "user-1");
      enqueueReview(makePayload({ segmentId: "b" }), "user-1");
      enqueueReview(makePayload({ segmentId: "c" }), "user-1");
      const seen: string[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        seen.push(p.segmentId);
        return makeReview();
      });

      const result = await drainReviewQueue(uploader, "user-1");

      expect(result).toEqual({
        flushed: 3,
        remaining: 0,
        networkFailed: false,
        transientServerError: false,
      });
      expect(seen).toEqual(["a", "b", "c"]);
    });

    it("drops poison-pill 4xx entries after their retry budget", async () => {
      enqueueReview(makePayload({ segmentId: "poison" }), "user-1");
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      await drainReviewQueue(uploader, "user-1");
      await drainReviewQueue(uploader, "user-1");
      const final = await drainReviewQueue(uploader, "user-1");

      expect(final.remaining).toBe(0);
      expect(getPendingCount()).toBe(0);
    });

    it("stops on the first network error, leaving the rest queued", async () => {
      enqueueReview(makePayload({ segmentId: "a" }), "user-1");
      enqueueReview(makePayload({ segmentId: "b" }), "user-1");
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await drainReviewQueue(uploader, "user-1");

      expect(result.networkFailed).toBe(true);
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(2);
    });

    it("concurrent drains share the in-flight promise", async () => {
      enqueueReview(makePayload(), "user-1");
      let resolve!: (value: RoadReview) => void;
      const uploader: ReviewUploader = jest.fn(
        () => new Promise<RoadReview>((r) => (resolve = r)),
      );

      const a = drainReviewQueue(uploader, "user-1");
      const b = drainReviewQueue(uploader, "user-1");
      expect(a).toBe(b);

      resolve(makeReview());
      await a;
      expect(uploader).toHaveBeenCalledTimes(1);
    });

    it("skips entries from other users without burning their retry budget", async () => {
      enqueueReview(makePayload({ segmentId: "a" }), "user-A");
      enqueueReview(makePayload({ segmentId: "b" }), "user-B");
      const uploader: ReviewUploader = jest.fn(async () => makeReview());

      const result = await drainReviewQueue(uploader, "user-B");

      expect(result.flushed).toBe(1);
      // user-A's entry is left untouched — its `attempts` counter
      // stays at 0 so user A can finish it on their next sign-in
      // without the poison-pill drop kicking in prematurely.
      const remaining = getPendingReviews();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.userId).toBe("user-A");
      expect(remaining[0]?.attempts).toBe(0);
    });
  });
});
