/**
 * `api.getReviews` deduplication through the request cache (#1212).
 *
 * The cache mechanics live in `reviewsReadCache` and are pinned in its own
 * suite; this one proves the COMPOSITION — that the facade keys the read on
 * `(segmentId, viewerId, ratingsEnabled)` from the live session + switch
 * cache, that every review mutation invalidates when it settles, and that
 * the explicit invalidation seam the pull-to-refresh gesture uses reaches
 * the cache.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();
let mockSession: { accessToken: string; userId: string | null } | null = {
  accessToken: "rider-a-token",
  userId: "rider-a",
};

jest.mock("../typedClient", () => ({
  client: {
    GET: (...args: unknown[]) => mockGet(...args),
    POST: (...args: unknown[]) => mockPost(...args),
    PUT: (...args: unknown[]) => mockPut(...args),
    DELETE: (...args: unknown[]) => mockDelete(...args),
  },
  clearTokens: jest.fn(),
  getAccessToken: () => mockSession?.accessToken ?? null,
  getAuthenticatedUserId: () => mockSession?.userId ?? null,
  getSessionEpoch: () => 0,
  getCachedUser: () => null,
  hydrateAuthTokens: jest.fn(),
  isAuthenticated: () => mockSession !== null,
  setCachedUser: jest.fn(),
  setAuthenticatedUserId: jest.fn(),
  storeTokens: jest.fn(),
  rawFetch: jest.fn(),
}));

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { api } from "../api";
import {
  __setStorageForTest,
  setCachedSystemSwitchStates,
} from "../systemSwitchCache";
import type { RoadReview } from "@/types";

function reviewList(...ids: string[]): RoadReview[] {
  return ids.map(
    (id) =>
      ({
        id,
        user_id: "author-1",
        rating: 4,
        is_mine: false,
        my_vote: null,
      }) as unknown as RoadReview,
  );
}

function success<T>(data: T) {
  return { data, response: { status: 200 } as Response };
}

function failure(status: number) {
  return {
    error: { message: `http ${status}` },
    response: { status } as Response,
  };
}

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

describe("api.getReviews request dedupe", () => {
  beforeEach(() => {
    mockSession = { accessToken: "rider-a-token", userId: "rider-a" };
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
    // Fresh switch cache (every switch default-ON) and an empty request
    // cache — entries are wall-clock scoped, so a leftover from the
    // previous test would still count as fresh.
    __setStorageForTest(createMemoryStorage());
    api.invalidateReviewsRead();
  });

  it("collapses the flip burst into ONE network read", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));

    // The two reads a `sys_poi_ratings` flip issues: the fetch effect's own
    // and the detail echo's.
    const [first, second] = await Promise.all([
      api.getReviews("seg-1"),
      api.getReviews("seg-1"),
    ]);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(first).toEqual(reviewList("r-1"));
    expect(second).toEqual(reviewList("r-1"));
  });

  it("does not serve a pre-flip response to a post-flip read", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-community")));
    await api.getReviews("seg-1");

    // Operator pauses ratings: the server's answer to this request changes
    // (community list -> own review only), so the key changes with it.
    setCachedSystemSwitchStates({ sys_poi_ratings: "force_off" });
    mockGet.mockResolvedValue(success(reviewList("r-own")));

    await expect(api.getReviews("seg-1")).resolves.toEqual(reviewList("r-own"));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("does not serve one rider's response to the NEXT account", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));
    await api.getReviews("seg-1");

    // `is_mine` / `my_vote` were resolved for rider A; rider B needs the
    // server's answer, not A's.
    mockSession = { accessToken: "rider-b-token", userId: "rider-b" };
    await api.getReviews("seg-1");

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("a settled create invalidates the segment — even a FAILED one", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));
    await api.getReviews("seg-1");

    // A 409 is server-confirmed proof the cached list is stale: the conflict
    // reload that follows must reach the network and see the existing review.
    mockPost.mockResolvedValue(failure(409));
    await expect(
      api.submitReview({ segmentId: "seg-1", rating: 5 }),
    ).rejects.toMatchObject({ status: 409 });

    await api.getReviews("seg-1");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("a successful update and delete each invalidate the segment", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));
    await api.getReviews("seg-1");

    mockPut.mockResolvedValue(success(reviewList("r-1")[0]));
    await api.updateReview({ segmentId: "seg-1", rating: 3 });
    await api.getReviews("seg-1");
    expect(mockGet).toHaveBeenCalledTimes(2);

    mockDelete.mockResolvedValue({
      response: { status: 204 } as Response,
    });
    await api.deleteReview("seg-1");
    await api.getReviews("seg-1");
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it("a settled vote invalidates cached reads", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));
    await api.getReviews("seg-1");

    // The vote endpoint only knows the review id, so the whole cache goes —
    // a cached read served just after a vote would roll the counts back.
    mockPost.mockResolvedValue(
      success({ helpful_count: 1, not_helpful_count: 0, my_vote: true }),
    );
    await api.voteOnReview("r-1", true);

    await api.getReviews("seg-1");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("explicit invalidation forces the next read out (the pull-to-refresh seam)", async () => {
    mockGet.mockResolvedValue(success(reviewList("r-1")));
    await api.getReviews("seg-1");

    api.invalidateReviewsRead("seg-1");

    await api.getReviews("seg-1");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("a failed read never suppresses the next one", async () => {
    mockGet.mockResolvedValueOnce(failure(500));
    await expect(api.getReviews("seg-1")).rejects.toMatchObject({
      status: 500,
    });

    // The retry goes straight to the network — no TTL window survives a
    // rejection (the defect class that killed the component-level marks).
    mockGet.mockResolvedValueOnce(success(reviewList("r-after")));
    await expect(api.getReviews("seg-1")).resolves.toEqual(
      reviewList("r-after"),
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
