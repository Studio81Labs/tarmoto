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
    await reconcileRideStop("r1");
    expect(stopRide).toHaveBeenCalledWith("r1");
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("treats an already-stopped ride (4xx) as success — no throw, nothing pending", async () => {
    stopRide.mockRejectedValue(new ApiError("Ride is not active", 400, {}));
    await expect(reconcileRideStop("r1")).resolves.toBeUndefined();
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("persists and rethrows on a transient (network) failure", async () => {
    stopRide.mockRejectedValue(new Error("network down"));
    await expect(reconcileRideStop("r1")).rejects.toThrow("network down");
    expect(__getPendingRideStopsForTest()).toEqual(["r1"]);
  });

  it("persists and rethrows on a 5xx", async () => {
    stopRide.mockRejectedValue(new ApiError("server error", 503, {}));
    await expect(reconcileRideStop("r1")).rejects.toBeInstanceOf(ApiError);
    expect(__getPendingRideStopsForTest()).toEqual(["r1"]);
  });

  it("dedupes concurrent stops for the same ride", async () => {
    let resolve!: (v: unknown) => void;
    stopRide.mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );

    const a = reconcileRideStop("r1");
    const b = reconcileRideStop("r1");
    resolve({ id: "r1" });
    await Promise.all([a, b]);

    // One shared in-flight request, not two.
    expect(stopRide).toHaveBeenCalledTimes(1);
  });

  it("drains a persisted pending stop and clears it on success", async () => {
    // Seed a pending id via a failed reconcile.
    stopRide.mockRejectedValueOnce(new Error("offline"));
    await reconcileRideStop("r1").catch(() => undefined);
    expect(__getPendingRideStopsForTest()).toEqual(["r1"]);

    // Now the network is back — the drain reconciles it.
    stopRide.mockResolvedValue({ id: "r1" } as never);
    await drainPendingRideStops();
    expect(stopRide).toHaveBeenLastCalledWith("r1");
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("keeps the id pending when the drain retry still fails", async () => {
    stopRide.mockRejectedValue(new Error("still offline"));
    await reconcileRideStop("r1").catch(() => undefined);
    await drainPendingRideStops();
    expect(__getPendingRideStopsForTest()).toEqual(["r1"]);
  });
});
