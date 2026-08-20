/**
 * Request-cache mechanics for the personalised review read (#1212).
 *
 * The cache exists to collapse the `sys_poi_ratings` flip burst — the fetch
 * effect's read and the detail echo's read — into one network request, at the
 * layer where the request itself is visible. The sharp edges are the ones
 * that killed the component-level marks in #1209: a FAILED read must never
 * suppress a later one, and an invalidation must always win over anything
 * that was in flight when it happened.
 */

import {
  dedupeReviewsRead,
  invalidateReviewsRead,
  REVIEWS_READ_TTL_MS,
  type ReviewsReadKey,
} from "../reviewsReadCache";
import type { RoadReview } from "@/types";

function reviews(...ids: string[]): RoadReview[] {
  return ids.map((id) => ({ id }) as RoadReview);
}

function key(overrides: Partial<ReviewsReadKey> = {}): ReviewsReadKey {
  return {
    segmentId: "seg-1",
    viewerId: "rider-1",
    ratingsEnabled: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("reviewsReadCache", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    invalidateReviewsRead();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shares ONE in-flight request between identical reads", async () => {
    const pending = deferred<RoadReview[]>();
    const fetcher = jest.fn(() => pending.promise);

    // The flip burst: the fetch effect's read and the detail echo's read.
    const first = dedupeReviewsRead(key(), fetcher);
    const second = dedupeReviewsRead(key(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    pending.resolve(reviews("r-1"));
    await expect(first).resolves.toEqual(reviews("r-1"));
    await expect(second).resolves.toEqual(reviews("r-1"));
  });

  it("serves a just-resolved read inside the TTL window", async () => {
    const fetcher = jest.fn(async () => reviews("r-1"));
    await dedupeReviewsRead(key(), fetcher);

    jest.advanceTimersByTime(REVIEWS_READ_TTL_MS);
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-1"),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const fetcher = jest
      .fn<Promise<RoadReview[]>, []>()
      .mockResolvedValueOnce(reviews("r-old"))
      .mockResolvedValueOnce(reviews("r-new"));
    await dedupeReviewsRead(key(), fetcher);

    jest.advanceTimersByTime(REVIEWS_READ_TTL_MS + 1);
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-new"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does NOT slide the window on a hit — the TTL runs from resolution", async () => {
    // A sliding window would let periodic triggers suppress network reads
    // indefinitely; the cache is a burst-collapser, not a data cache.
    const fetcher = jest.fn(async () => reviews("r-1"));
    await dedupeReviewsRead(key(), fetcher);

    jest.advanceTimersByTime(REVIEWS_READ_TTL_MS - 500);
    await dedupeReviewsRead(key(), fetcher); // hit, must not extend
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(501); // past the ORIGINAL resolution + TTL
    await dedupeReviewsRead(key(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keys on the full response identity — segment, viewer, and switch state", async () => {
    const fetcher = jest.fn(async () => reviews("r-1"));

    await dedupeReviewsRead(key(), fetcher);
    // Another road, another rider, and the post-flip read each carry a
    // different identity, so none may be served the cached response.
    await dedupeReviewsRead(key({ segmentId: "seg-2" }), fetcher);
    await dedupeReviewsRead(key({ viewerId: "rider-2" }), fetcher);
    await dedupeReviewsRead(key({ viewerId: null }), fetcher);
    await dedupeReviewsRead(key({ ratingsEnabled: false }), fetcher);

    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("clears the entry when the read REJECTS, so the next read goes out", async () => {
    const failure = new Error("network down");
    const fetcher = jest
      .fn<Promise<RoadReview[]>, []>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(reviews("r-after"));

    await expect(dedupeReviewsRead(key(), fetcher)).rejects.toBe(failure);

    // No TTL suppression after a failure — the retry must reach the network
    // immediately (the defect class that killed the component-level marks).
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-after"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("delivers the shared rejection to EVERY holder of the promise", async () => {
    const pending = deferred<RoadReview[]>();
    const fetcher = jest.fn(() => pending.promise);

    const first = dedupeReviewsRead(key(), fetcher);
    const second = dedupeReviewsRead(key(), fetcher);
    const failure = new Error("boom");
    pending.reject(failure);

    // Both callers see the failure exactly as if each had issued the request
    // itself — nobody is left hanging on a promise that silently vanished.
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
  });

  it("a late rejection must not evict a SUCCESSOR entry under the same key", async () => {
    const stale = deferred<RoadReview[]>();
    const fetcher = jest
      .fn<Promise<RoadReview[]>, []>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(reviews("r-fresh"));

    const staleRead = dedupeReviewsRead(key(), fetcher);
    // The invalidation (e.g. a pull-to-refresh) evicts the in-flight entry;
    // the next read starts fresh under the same key.
    invalidateReviewsRead("seg-1");
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-fresh"),
    );

    // The evicted read now fails. Its cleanup must recognise the entry is no
    // longer its own and leave the successor's cached response in place.
    stale.reject(new Error("stale failure"));
    await expect(staleRead).rejects.toThrow("stale failure");
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-fresh"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("segment-scoped invalidation drops every entry for that road only", async () => {
    const fetcher = jest.fn(async () => reviews("r-1"));
    await dedupeReviewsRead(key(), fetcher);
    await dedupeReviewsRead(key({ ratingsEnabled: false }), fetcher);
    await dedupeReviewsRead(key({ segmentId: "seg-2" }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);

    invalidateReviewsRead("seg-1");

    // Both seg-1 identities refetch; seg-2 is still inside its window.
    await dedupeReviewsRead(key(), fetcher);
    await dedupeReviewsRead(key({ ratingsEnabled: false }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await dedupeReviewsRead(key({ segmentId: "seg-2" }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("an invalidated in-flight read is not joined by later callers", async () => {
    const stale = deferred<RoadReview[]>();
    const fetcher = jest
      .fn<Promise<RoadReview[]>, []>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(reviews("r-fresh"));

    const staleRead = dedupeReviewsRead(key(), fetcher);
    invalidateReviewsRead("seg-1");

    // A read issued AFTER the invalidating event must not be handed a
    // request issued before it.
    const freshRead = dedupeReviewsRead(key(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The evicted read still settles normally for whoever held it.
    stale.resolve(reviews("r-stale"));
    await expect(staleRead).resolves.toEqual(reviews("r-stale"));
    await expect(freshRead).resolves.toEqual(reviews("r-fresh"));

    // And its late resolution must not re-arm a cache window: the successor's
    // response is what the next read joins.
    await expect(dedupeReviewsRead(key(), fetcher)).resolves.toEqual(
      reviews("r-fresh"),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bare invalidation clears every segment (the vote path)", async () => {
    const fetcher = jest.fn(async () => reviews("r-1"));
    await dedupeReviewsRead(key(), fetcher);
    await dedupeReviewsRead(key({ segmentId: "seg-2" }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);

    invalidateReviewsRead();

    await dedupeReviewsRead(key(), fetcher);
    await dedupeReviewsRead(key({ segmentId: "seg-2" }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
