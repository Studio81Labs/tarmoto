/**
 * Ride-stop reconciler.
 *
 * Guards the reliability contract both stop callers depend on: a stop is
 * deduped across concurrent callers, an already-stopped ride resolves as
 * success (idempotent — no spurious "Couldn't stop ride"), and a transient
 * failure persists the id for a later drain so the backend ride can't orphan
 * the rider under the one-active-ride constraint.
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
  return { api: { stopRide: jest.fn() }, ApiError };
});

import { api, ApiError } from "../api";
import {
  __getPendingRideStopsForTest,
  __setStorageForTest,
  cancelPendingRideStop,
  drainPendingRideStops,
  reconcileRideStop,
} from "../rideStopReconciler";

const stopRide = api.stopRide as jest.MockedFunction<typeof api.stopRide>;

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

describe("rideStopReconciler", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
    stopRide.mockReset();
  });

  it("stops the ride and leaves nothing pending on success", async () => {
    stopRide.mockResolvedValue({ id: "r1" } as never);
    await reconcileRideStop("r1", "userA");
    expect(stopRide).toHaveBeenCalledWith("r1");
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("treats a proven-stopped ride (400) as success — no throw, nothing pending", async () => {
    stopRide.mockRejectedValue(new ApiError("Ride is not active", 400, {}));
    await expect(reconcileRideStop("r1", "userA")).resolves.toBeUndefined();
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("treats a 404 (ride gone) as success", async () => {
    stopRide.mockRejectedValue(new ApiError("Ride not found", 404, {}));
    await expect(reconcileRideStop("r1", "userA")).resolves.toBeUndefined();
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("keeps the stop pending on an auth failure (401) — NOT proven stopped", async () => {
    stopRide.mockRejectedValue(new ApiError("Unauthorized", 401, {}));
    await expect(reconcileRideStop("r1", "userA")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "r1", userId: "userA" },
    ]);
  });

  it("persists and rethrows on a transient (network) failure", async () => {
    stopRide.mockRejectedValue(new Error("network down"));
    await expect(reconcileRideStop("r1", "userA")).rejects.toThrow(
      "network down",
    );
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "r1", userId: "userA" },
    ]);
  });

  it("persists and rethrows on a 5xx", async () => {
    stopRide.mockRejectedValue(new ApiError("server error", 503, {}));
    await expect(reconcileRideStop("r1", "userA")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "r1", userId: "userA" },
    ]);
  });

  it("dedupes concurrent stops for the same ride", async () => {
    let resolve!: (v: unknown) => void;
    stopRide.mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );

    const a = reconcileRideStop("r1", "userA");
    const b = reconcileRideStop("r1", "userA");
    resolve({ id: "r1" });
    await Promise.all([a, b]);

    // One shared in-flight request, not two.
    expect(stopRide).toHaveBeenCalledTimes(1);
  });

  it("drains only the current rider's pending stops, and clears on success", async () => {
    // Seed two pending stops owned by different riders.
    stopRide.mockRejectedValue(new Error("offline"));
    await reconcileRideStop("rA", "userA").catch(() => undefined);
    await reconcileRideStop("rB", "userB").catch(() => undefined);
    expect(__getPendingRideStopsForTest()).toHaveLength(2);

    // userA is signed in and the network is back.
    stopRide.mockResolvedValue({ id: "rA" } as never);
    await drainPendingRideStops("userA");

    // Only userA's ride was reconciled; userB's entry is untouched.
    expect(stopRide).toHaveBeenLastCalledWith("rA");
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "rB", userId: "userB" },
    ]);
  });

  it("cancelPendingRideStop drops a queued entry (rider chose to keep riding)", async () => {
    stopRide.mockRejectedValue(new Error("offline"));
    await reconcileRideStop("r1", "userA").catch(() => undefined);
    expect(__getPendingRideStopsForTest()).toHaveLength(1);

    cancelPendingRideStop("r1");
    expect(__getPendingRideStopsForTest()).toEqual([]);

    // A later drain has nothing to retry — the ride is NOT completed.
    stopRide.mockClear();
    await drainPendingRideStops("userA");
    expect(stopRide).not.toHaveBeenCalled();
  });

  it("does NOT drain the ride that is still recording locally", async () => {
    // A manual stop failed and was queued while the ride keeps recording. A
    // background drain must skip it so it doesn't complete the live ride.
    stopRide.mockRejectedValue(new Error("offline"));
    await reconcileRideStop("active-ride", "userA").catch(() => undefined);
    await reconcileRideStop("ended-ride", "userA").catch(() => undefined);

    stopRide.mockClear();
    stopRide.mockResolvedValue({ id: "ended-ride" } as never);

    // Drain while "active-ride" is the local active ride → only "ended-ride"
    // is reconciled; the recording ride is left queued.
    await drainPendingRideStops("userA", "active-ride");

    expect(stopRide).toHaveBeenCalledTimes(1);
    expect(stopRide).toHaveBeenCalledWith("ended-ride");
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "active-ride", userId: "userA" },
    ]);
  });

  it("keeps the id pending when the drain retry still fails", async () => {
    stopRide.mockRejectedValue(new Error("still offline"));
    await reconcileRideStop("r1", "userA").catch(() => undefined);
    await drainPendingRideStops("userA");
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "r1", userId: "userA" },
    ]);
  });
});
