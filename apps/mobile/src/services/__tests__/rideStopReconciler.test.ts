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
  return {
    api: { stopRide: jest.fn(), getAuthenticatedUserId: jest.fn(() => null) },
    ApiError,
  };
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

describe("rideStopReconciler", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
    stopRide.mockReset();
    getAuthenticatedUserId.mockReset();
    getAuthenticatedUserId.mockReturnValue(null);
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

  it("queues (does NOT POST) when a DIFFERENT rider is now authenticated", async () => {
    // Rider A owns the ride but rider B is signed in when the kill fires.
    // POSTing under B's token would 404 and wrongly discard A's stop, so it
    // must be persisted for A's own later drain instead.
    getAuthenticatedUserId.mockReturnValue("userB");
    await expect(reconcileRideStop("rA", "userA")).resolves.toBeUndefined();

    expect(stopRide).not.toHaveBeenCalled();
    expect(__getPendingRideStopsForTest()).toEqual([
      { rideId: "rA", userId: "userA" },
    ]);
  });

  it("still POSTs when the authenticated rider matches the owner", async () => {
    getAuthenticatedUserId.mockReturnValue("userA");
    stopRide.mockResolvedValue({ id: "rA" } as never);
    await reconcileRideStop("rA", "userA");
    expect(stopRide).toHaveBeenCalledWith("rA");
    expect(__getPendingRideStopsForTest()).toEqual([]);
  });

  it("still POSTs when the owner is unknown (empty), under whoever is signed in", async () => {
    // A missing owner ("") can't establish a mismatch — the HUD stop must still
    // run under the signed-in rider's session.
    getAuthenticatedUserId.mockReturnValue("userA");
    stopRide.mockResolvedValue({ id: "rA" } as never);
    await reconcileRideStop("rA", "");
    expect(stopRide).toHaveBeenCalledWith("rA");
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

describe("rideStopReconciler storage init", () => {
  // Bracket access dodges babel's `transform-inline-environment-variables`,
  // which rewrites dot-form `process.env.JEST_WORKER_ID` into a literal and
  // would break the assignment/restore below.
  const env = process.env as Record<string, string | undefined>;
  const originalWorkerId = env["JEST_WORKER_ID"];

  afterEach(() => {
    env["JEST_WORKER_ID"] = originalWorkerId;
    jest.resetModules();
    jest.dontMock("react-native-mmkv");
  });

  it("surfaces (logs) an on-device MMKV init failure instead of hiding it", () => {
    // Simulate a real device (not a jest worker) where MMKV init throws.
    delete env["JEST_WORKER_ID"];
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    jest.isolateModules(() => {
      jest.doMock("react-native-mmkv", () => ({
        createMMKV: () => {
          throw new Error("native binding unavailable");
        },
      }));
      // Re-import so the module's top-level `createStorage()` runs under the
      // failing mock. The module must not throw on import (falls back to
      // memory) but must log the lost-durability warning.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../rideStopReconciler");
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("MMKV unavailable"),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("stays quiet about the native-binding-absent fallback under jest", () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    jest.isolateModules(() => {
      jest.doMock("react-native-mmkv", () => ({
        createMMKV: () => {
          throw new Error("no native module under jest");
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../rideStopReconciler");
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
