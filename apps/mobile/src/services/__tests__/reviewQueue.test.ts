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
  const err = new Error("Network Error") as Error & {
    code?: string;
    response?: unknown;
  };
  err.code = "ERR_NETWORK";
  return err;
}

function makeServerError(status: number): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    response?: { status: number };
  };
  err.response = { status };
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

      const result = await submitReviewWithQueue(makePayload(), uploader);

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
      );

      expect(result.status).toBe("queued");
      expect(result.review).toBeUndefined();
      expect(result.pending).toBe(1);
      const pending = getPendingReviews();
      expect(pending).toHaveLength(1);
      // Photo URLs must round-trip so the next drain can re-submit
      // without re-uploading the bytes.
      expect(pending[0].photos).toEqual([
        "https://api.tarmoto.test/uploads/road-review-photos/u-1.jpg",
      ]);
    });

    it("queues on transient server errors (5xx / 408 / 429)", async () => {
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(503);
      });

      const result = await submitReviewWithQueue(makePayload(), uploader);

      expect(result.status).toBe("queued");
      expect(getPendingCount()).toBe(1);
    });

    it("propagates 4xx client errors (e.g. 409 duplicate review)", async () => {
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(409);
      });

      await expect(
        submitReviewWithQueue(makePayload(), uploader),
      ).rejects.toMatchObject({ response: { status: 409 } });
      // 4xx must not silently land in the queue — the form needs to
      // see the rejection and switch to edit mode.
      expect(getPendingCount()).toBe(0);
    });

    it("drains backlog before posting a fresh review (FIFO)", async () => {
      enqueueReview(makePayload({ rating: 2, segmentId: "seg-A" }));
      const order: string[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        order.push(p.segmentId);
        return makeReview({ id: `r-${p.segmentId}` });
      });

      const result = await submitReviewWithQueue(
        makePayload({ rating: 5, segmentId: "seg-B" }),
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.review?.id).toBe("r-seg-B");
      expect(order).toEqual(["seg-A", "seg-B"]);
      expect(getPendingCount()).toBe(0);
    });

    it("skips the live call when the drain stops on a network error", async () => {
      enqueueReview(makePayload({ segmentId: "seg-A" }));
      const calls: ReviewSubmissionPayload[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        calls.push(p);
        throw makeNetworkError();
      });

      const result = await submitReviewWithQueue(
        makePayload({ segmentId: "seg-B" }),
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(getPendingCount()).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0].segmentId).toBe("seg-A");
    });
  });

  describe("drainReviewQueue", () => {
    it("flushes everything in order on a healthy link", async () => {
      enqueueReview(makePayload({ segmentId: "a" }));
      enqueueReview(makePayload({ segmentId: "b" }));
      enqueueReview(makePayload({ segmentId: "c" }));
      const seen: string[] = [];
      const uploader: ReviewUploader = jest.fn(async (p) => {
        seen.push(p.segmentId);
        return makeReview();
      });

      const result = await drainReviewQueue(uploader);

      expect(result).toEqual({
        flushed: 3,
        remaining: 0,
        networkFailed: false,
        transientServerError: false,
      });
      expect(seen).toEqual(["a", "b", "c"]);
    });

    it("drops poison-pill 4xx entries after their retry budget", async () => {
      enqueueReview(makePayload({ segmentId: "poison" }));
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      await drainReviewQueue(uploader);
      await drainReviewQueue(uploader);
      const final = await drainReviewQueue(uploader);

      expect(final.remaining).toBe(0);
      expect(getPendingCount()).toBe(0);
    });

    it("stops on the first network error, leaving the rest queued", async () => {
      enqueueReview(makePayload({ segmentId: "a" }));
      enqueueReview(makePayload({ segmentId: "b" }));
      const uploader: ReviewUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await drainReviewQueue(uploader);

      expect(result.networkFailed).toBe(true);
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(2);
    });

    it("concurrent drains share the in-flight promise", async () => {
      enqueueReview(makePayload());
      let resolve!: (value: RoadReview) => void;
      const uploader: ReviewUploader = jest.fn(
        () => new Promise<RoadReview>((r) => (resolve = r)),
      );

      const a = drainReviewQueue(uploader);
      const b = drainReviewQueue(uploader);
      expect(a).toBe(b);

      resolve(makeReview());
      await a;
      expect(uploader).toHaveBeenCalledTimes(1);
    });
  });
});
