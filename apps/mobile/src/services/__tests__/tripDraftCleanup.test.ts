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
  return { api: { deleteTrip: jest.fn() }, ApiError };
});

import { api, ApiError } from "../api";
import {
  __getPendingTripDraftCleanupsForTest,
  __setStorageForTest,
  drainTripDraftCleanups,
  reconcileTripDraftCleanup,
} from "../tripDraftCleanup";

const deleteTrip = api.deleteTrip as jest.MockedFunction<typeof api.deleteTrip>;

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
  });

  it("deletes the draft and leaves nothing pending on success", async () => {
    deleteTrip.mockResolvedValue(undefined);
    await reconcileTripDraftCleanup("t1", "userA");
    expect(deleteTrip).toHaveBeenCalledWith("t1");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("treats a 404 (already gone) as success — nothing pending", async () => {
    deleteTrip.mockRejectedValue(new ApiError("Not found", 404, {}));
    await reconcileTripDraftCleanup("t1", "userA");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("persists the id+owner on a transient (network) failure for a later drain", async () => {
    deleteTrip.mockRejectedValue(new Error("planner outage"));
    await reconcileTripDraftCleanup("t1", "userA");
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
    let resolve!: () => void;
    deleteTrip.mockImplementation(
      () => new Promise<void>((r) => (resolve = () => r())),
    );

    const a = reconcileTripDraftCleanup("t1", "userA");
    const b = reconcileTripDraftCleanup("t1", "userA");
    resolve();
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
    expect(deleteTrip).toHaveBeenCalledWith("tA");
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
