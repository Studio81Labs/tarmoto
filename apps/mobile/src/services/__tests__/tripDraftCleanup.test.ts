/**
 * Trip-draft cleanup reconciler.
 *
 * A `trip_planning` kill mid-create leaves a persisted `draft` (it counts
 * against `max_active_trips`) whose cleanup delete can fail for the same
 * outage. Since there's no delete-trip UI, the delete must be idempotent
 * (a 404 = already gone), persist the id on a transient failure, and drain it
 * later — otherwise the draft strands the rider's sole Free slot.
 */

jest.mock("../api", () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    api: { deleteTrip: jest.fn(), getAuthenticatedUserId: jest.fn() },
    ApiError,
  };
});

import { api, ApiError } from "../api";
import {
  __getPendingTripDraftCleanupsForTest,
  __setStorageForTest,
  drainTripDraftCleanups,
  reconcileTripDraftCleanup,
} from "../tripDraftCleanup";

const deleteTrip = api.deleteTrip as jest.MockedFunction<typeof api.deleteTrip>;
const getAuthenticatedUserId =
  api.getAuthenticatedUserId as jest.MockedFunction<
    typeof api.getAuthenticatedUserId
  >;

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

describe("tripDraftCleanup", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
    deleteTrip.mockReset();
    // Default: the owner ("userA", used across these cases) is the signed-in
    // rider, so the session-swap guard lets the delete through.
    getAuthenticatedUserId.mockReset();
    getAuthenticatedUserId.mockReturnValue("userA");
  });

  it("issues an ATOMIC draft-only delete and leaves nothing pending on success", async () => {
    deleteTrip.mockResolvedValue(undefined);
    await reconcileTripDraftCleanup("t1", "userA");
    // onlyIfDraft folds the status predicate into the backend DELETE — no
    // separate status GET, so no check-then-delete race.
    expect(deleteTrip).toHaveBeenCalledWith("t1", { onlyIfDraft: true });
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("treats a 404 as terminal when the owner is still signed in (gone or not-a-draft)", async () => {
    // The backend returns the same 404 for already-gone AND for a trip that has
    // moved past draft (generation finished in a post-commit race). Both mean
    // "nothing to clean" — the valid trip is never deleted (the WHERE clause
    // didn't match), so just drop the queue entry.
    deleteTrip.mockRejectedValue(new ApiError("Not found", 404, {}));
    await reconcileTripDraftCleanup("t1", "userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("keeps the entry if a 404 arrives AFTER the session changed (non-owner response)", async () => {
    // Owner passes the pre-delete guard, but a different rider signs in during
    // the request; the 404 may be a non-owner response under the new token, not
    // proof the draft is gone — so don't discard the owner's cleanup.
    deleteTrip.mockRejectedValue(new ApiError("Not found", 404, {}));
    getAuthenticatedUserId
      .mockReturnValueOnce("userA") // pre-delete guard passes
      .mockReturnValue("userB"); // session swapped by the time the 404 lands
    await reconcileTripDraftCleanup("t1", "userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });

  it("persists the id+owner on a transient (network) failure for a later drain", async () => {
    deleteTrip.mockRejectedValue(new Error("planner outage"));
    await reconcileTripDraftCleanup("t1", "userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });

  it("persists WITHOUT deleting when a different rider is signed in (session swap)", async () => {
    // Owner is userA but userB is authed — a DELETE under B's token 404s as a
    // non-owner and would be treated as "gone". Queue it for a later drain
    // under A's token instead; issue no request now.
    getAuthenticatedUserId.mockReturnValue("userB");
    await reconcileTripDraftCleanup("t1", "userA");
    expect(deleteTrip).not.toHaveBeenCalled();
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });

  it("persists WITHOUT deleting when nobody is signed in", async () => {
    getAuthenticatedUserId.mockReturnValue(null);
    await reconcileTripDraftCleanup("t1", "userA");
    expect(deleteTrip).not.toHaveBeenCalled();
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });

  it("persists on an auth failure (401) — NOT proven gone", async () => {
    deleteTrip.mockRejectedValue(new ApiError("Unauthorized", 401, {}));
    await reconcileTripDraftCleanup("t1", "userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });

  it("dedupes concurrent cleanups for the same draft", async () => {
    // The in-flight map dedupes synchronously, so a second concurrent call
    // reuses the first's promise and never issues its own delete.
    deleteTrip.mockResolvedValue(undefined);

    const a = reconcileTripDraftCleanup("t1", "userA");
    const b = reconcileTripDraftCleanup("t1", "userA");
    await Promise.all([a, b]);

    expect(deleteTrip).toHaveBeenCalledTimes(1);
  });

  it("drains only the current rider's entries, and clears the ones the retry deletes", async () => {
    // Seed failed cleanups owned by two different riders.
    deleteTrip.mockRejectedValue(new Error("offline"));
    await reconcileTripDraftCleanup("tA", "userA");
    await reconcileTripDraftCleanup("tB", "userB");
    expect(__getPendingTripDraftCleanupsForTest()).toHaveLength(2);

    // userA is signed in and the network is back — only THEIR entry drains.
    deleteTrip.mockReset();
    deleteTrip.mockResolvedValue(undefined);
    await drainTripDraftCleanups("userA");

    expect(deleteTrip).toHaveBeenCalledTimes(1);
    expect(deleteTrip).toHaveBeenCalledWith("tA", { onlyIfDraft: true });
    // userB's entry is untouched — retrying it under userA's token would 404
    // (non-owner) and wrongly discard it.
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "tB", ownerId: "userB" },
    ]);
  });

  it("keeps the id pending when the drain retry still fails", async () => {
    deleteTrip.mockRejectedValue(new Error("still offline"));
    await reconcileTripDraftCleanup("t1", "userA");
    await drainTripDraftCleanups("userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([
      { tripId: "t1", ownerId: "userA" },
    ]);
  });
});
