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
    await reconcileTripDraftCleanup("t1");
    expect(deleteTrip).toHaveBeenCalledWith("t1");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("treats a 404 (already gone) as success — nothing pending", async () => {
    deleteTrip.mockRejectedValue(new ApiError("Not found", 404, {}));
    await reconcileTripDraftCleanup("t1");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("persists the id on a transient (network) failure for a later drain", async () => {
    deleteTrip.mockRejectedValue(new Error("planner outage"));
    await reconcileTripDraftCleanup("t1");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual(["t1"]);
  });

  it("persists on an auth failure (401) — NOT proven gone", async () => {
    deleteTrip.mockRejectedValue(new ApiError("Unauthorized", 401, {}));
    await reconcileTripDraftCleanup("t1");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual(["t1"]);
  });

  it("dedupes concurrent cleanups for the same draft", async () => {
    let resolve!: () => void;
    deleteTrip.mockImplementation(
      () => new Promise<void>((r) => (resolve = () => r())),
    );

    const a = reconcileTripDraftCleanup("t1");
    const b = reconcileTripDraftCleanup("t1");
    resolve();
    await Promise.all([a, b]);

    expect(deleteTrip).toHaveBeenCalledTimes(1);
  });

  it("drains the persisted queue and clears entries the retry deletes", async () => {
    // Seed two failed cleanups.
    deleteTrip.mockRejectedValue(new Error("offline"));
    await reconcileTripDraftCleanup("tA");
    await reconcileTripDraftCleanup("tB");
    expect(__getPendingTripDraftCleanupsForTest()).toHaveLength(2);

    // Network's back — the drain retries and clears both.
    deleteTrip.mockReset();
    deleteTrip.mockResolvedValue(undefined);
    await drainTripDraftCleanups();

    expect(deleteTrip).toHaveBeenCalledWith("tA");
    expect(deleteTrip).toHaveBeenCalledWith("tB");
    expect(__getPendingTripDraftCleanupsForTest()).toEqual([]);
  });

  it("keeps the id pending when the drain retry still fails", async () => {
    deleteTrip.mockRejectedValue(new Error("still offline"));
    await reconcileTripDraftCleanup("t1");
    await drainTripDraftCleanups();
    expect(__getPendingTripDraftCleanupsForTest()).toEqual(["t1"]);
  });
});
