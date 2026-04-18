/**
 * Offline sensor-upload queue — US-18 AC #4.
 *
 * Focus: the behavior the ride-stop flow and the Settings retry button
 * rely on. Persistence is asserted against an in-memory shim (MMKV isn't
 * available in jest); the code already has a guarded fallback for that.
 */

import {
  __setStorageForTest,
  clearOfflineQueue,
  drainOfflineQueue,
  enqueueUpload,
  getPendingCount,
  getPendingUploads,
  submitSensorUpload,
  subscribePending,
  type SensorUploader,
} from "../offlineQueue";
import type { SensorReading } from "@/types";

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
    // Expose raw store so tests can inspect corruption scenarios.
    raw: store,
  };
}

function makeReading(t: number): SensorReading {
  return { t, ax: 0.1, ay: 0.2, az: 9.8 };
}

function makeNetworkError(): Error {
  // Shape matches what axios v1 produces for a disconnect — ERR_NETWORK
  // plus no `response`. The classifier short-circuits on `response` being
  // defined so we must leave it unset.
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

describe("offlineQueue", () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    __setStorageForTest(storage);
  });

  describe("submitSensorUpload", () => {
    it("uploads immediately when the network works", async () => {
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async () => ({ accepted: 12, segments_updated: 3 }));

      const result = await submitSensorUpload(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.accepted).toBe(12);
      expect(result.segmentsUpdated).toBe(3);
      expect(result.pending).toBe(0);
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(uploader).toHaveBeenCalledWith(
        "ride-1",
        [makeReading(1)],
        "iPhone",
      );
    });

    it("queues the payload when the network is down", async () => {
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitSensorUpload(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.accepted).toBe(0);
      expect(result.pending).toBe(1);
      expect(getPendingCount()).toBe(1);
      expect(getPendingUploads()[0].rideId).toBe("ride-1");
    });

    it("bubbles 4xx client errors so callers can react", async () => {
      // 4xx means the payload or auth is wrong — the queue can't fix
      // that by retrying the same bytes, so the error surfaces.
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      await expect(
        submitSensorUpload("ride-1", [makeReading(1)], "iPhone", uploader),
      ).rejects.toThrow("HTTP 400");
      expect(getPendingCount()).toBe(0);
    });

    it("flushes the backlog before the fresh upload so order is preserved", async () => {
      enqueueUpload("old-ride", [makeReading(1)], "iPhone");
      const calls: string[] = [];
      const uploader: SensorUploader = jest.fn(async (rideId) => {
        calls.push(rideId);
        return { accepted: 1, segments_updated: 1 };
      });

      const result = await submitSensorUpload(
        "new-ride",
        [makeReading(2)],
        "iPhone",
        uploader,
      );

      expect(calls).toEqual(["old-ride", "new-ride"]);
      expect(result.status).toBe("uploaded");
      expect(result.pending).toBe(0);
    });

    it("queues the new payload when the server is transiently failing (5xx)", async () => {
      // Regression: an earlier version dropped 5xx items as poison,
      // losing ride data on server hiccups. 5xx/408/429 mean "try
      // again", not "this payload is bad".
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeServerError(503);
      });

      const result = await submitSensorUpload(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.pending).toBe(1);
      expect(getPendingUploads()[0].rideId).toBe("ride-1");
    });

    it("queues the new payload if the backlog flush hits the network", async () => {
      // Backlog item pre-seeded. The uploader stays offline the entire
      // call — so neither the backlog item nor the fresh payload can go
      // live, and both should end up on the queue in order.
      enqueueUpload("old-ride", [makeReading(1)], "iPhone");
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitSensorUpload(
        "new-ride",
        [makeReading(2)],
        "iPhone",
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.pending).toBe(2);
      const pending = getPendingUploads();
      expect(pending.map((e) => e.rideId)).toEqual(["old-ride", "new-ride"]);
    });

    it("still uploads live when a poison pill sits in the queue", async () => {
      // Regression: an earlier version gated the live-upload skip on
      // `drain.remaining > 0`, which mistook a poison pill for a network
      // outage and queued perfectly-valid fresh payloads behind it.
      // A poison item just means the server rejected ONE bad payload —
      // the link is fine and new uploads should still go live.
      enqueueUpload("poison", [makeReading(1)], "iPhone");
      const uploader: SensorUploader = jest.fn(async (rideId) => {
        if (rideId === "poison") throw makeServerError(400);
        return { accepted: 7, segments_updated: 2 };
      });

      const result = await submitSensorUpload(
        "fresh",
        [makeReading(2)],
        "iPhone",
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.accepted).toBe(7);
      // Poison still waiting its next attempt; fresh was NOT queued.
      const pending = getPendingUploads();
      expect(pending.map((e) => e.rideId)).toEqual(["poison"]);
    });
  });

  describe("drainOfflineQueue", () => {
    it("is a no-op when the queue is empty", async () => {
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >();
      const result = await drainOfflineQueue(uploader);
      expect(result).toEqual({
        flushed: 0,
        remaining: 0,
        networkFailed: false,
      });
      expect(uploader).not.toHaveBeenCalled();
    });

    it("flushes items oldest-first and empties the queue", async () => {
      enqueueUpload("a", [makeReading(1)], "iPhone");
      enqueueUpload("b", [makeReading(2)], "iPhone");
      enqueueUpload("c", [makeReading(3)], "iPhone");
      const calls: string[] = [];
      const uploader: SensorUploader = jest.fn(async (rideId) => {
        calls.push(rideId);
        return { accepted: 1, segments_updated: 0 };
      });

      const result = await drainOfflineQueue(uploader);

      expect(calls).toEqual(["a", "b", "c"]);
      expect(result.flushed).toBe(3);
      expect(result.remaining).toBe(0);
      expect(getPendingCount()).toBe(0);
    });

    it("stops at the first network error and keeps the rest", async () => {
      enqueueUpload("a", [makeReading(1)], "iPhone");
      enqueueUpload("b", [makeReading(2)], "iPhone");
      enqueueUpload("c", [makeReading(3)], "iPhone");
      let callIdx = 0;
      const uploader: SensorUploader = jest.fn(async () => {
        callIdx += 1;
        if (callIdx === 1) return { accepted: 1, segments_updated: 0 };
        throw makeNetworkError();
      });

      const result = await drainOfflineQueue(uploader);

      expect(result.flushed).toBe(1);
      expect(result.remaining).toBe(2);
      expect(result.networkFailed).toBe(true);
      expect(getPendingUploads().map((e) => e.rideId)).toEqual(["b", "c"]);
    });

    it("does not flag networkFailed when only poison items remain", async () => {
      enqueueUpload("poison", [makeReading(1)], "iPhone");
      const uploader: SensorUploader = async () => {
        throw makeServerError(400);
      };

      const result = await drainOfflineQueue(uploader);

      expect(result.networkFailed).toBe(false);
      expect(result.remaining).toBe(1);
    });

    it("preserves items across drains when the server is transiently failing", async () => {
      // Regression: an earlier version bumped `attempts` on any non-
      // network error and dropped after 3, so 5xx/429/408 (which mean
      // "try again later") would eat a rider's sensor data. Transient
      // server faults must NOT bump attempts or drop the payload.
      enqueueUpload("a", [makeReading(1)], "iPhone");
      enqueueUpload("b", [makeReading(2)], "iPhone");
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async () => {
        throw makeServerError(503);
      });

      // Five drains' worth of server pain should still leave both items
      // intact with `attempts` untouched.
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await drainOfflineQueue(uploader);
      }

      const remaining = getPendingUploads();
      expect(remaining.map((e) => e.rideId)).toEqual(["a", "b"]);
      expect(remaining.every((e) => e.attempts === 0)).toBe(true);

      // And when the server recovers, the next drain flushes them.
      const recovered: SensorUploader = async () => ({
        accepted: 1,
        segments_updated: 0,
      });
      const result = await drainOfflineQueue(recovered);
      expect(result.flushed).toBe(2);
      expect(getPendingCount()).toBe(0);
    });

    it("treats 429 and 408 as retriable, not poison", async () => {
      enqueueUpload("a", [makeReading(1)], "iPhone");
      let callIdx = 0;
      const uploader: SensorUploader = async () => {
        callIdx += 1;
        // Rate-limited twice, then timed out once — nothing should be
        // dropped. A fourth call succeeds.
        if (callIdx === 1) throw makeServerError(429);
        if (callIdx === 2) throw makeServerError(429);
        if (callIdx === 3) throw makeServerError(408);
        return { accepted: 1, segments_updated: 0 };
      };

      await drainOfflineQueue(uploader);
      await drainOfflineQueue(uploader);
      await drainOfflineQueue(uploader);
      expect(getPendingUploads()[0].attempts).toBe(0);

      const final = await drainOfflineQueue(uploader);
      expect(final.flushed).toBe(1);
      expect(getPendingCount()).toBe(0);
    });

    it("shares the in-flight drain across concurrent callers", async () => {
      // Two drains started in parallel should return the same result and
      // the uploader should only see each payload once. A boolean lock
      // would return a synthetic no-op to the second caller, racing the
      // real flush and reporting a stale `remaining`.
      enqueueUpload("a", [makeReading(1)], "iPhone");
      enqueueUpload("b", [makeReading(2)], "iPhone");
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async () => ({ accepted: 1, segments_updated: 0 }));

      const [first, second] = await Promise.all([
        drainOfflineQueue(uploader),
        drainOfflineQueue(uploader),
      ]);

      // Both callers see the same outcome (not a stubbed 0/N reply).
      expect(first).toEqual(second);
      expect(first.flushed).toBe(2);
      expect(first.remaining).toBe(0);
      expect(uploader).toHaveBeenCalledTimes(2);
    });

    it("drops poison items after 3 failed attempts so the queue can drain", async () => {
      // A 4xx keeps failing no matter how often we retry — without the
      // poison-pill drop it would block every other ride forever. Three
      // attempts matches the threshold in the service.
      enqueueUpload("poison", [makeReading(1)], "iPhone");
      enqueueUpload("healthy", [makeReading(2)], "iPhone");
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async (rideId) => {
        if (rideId === "poison") throw makeServerError(400);
        return { accepted: 1, segments_updated: 0 };
      });

      // Each drain bumps `attempts` for the poison item by 1 and
      // continues past it to the healthy one. After 3 drains the poison
      // should be dropped.
      await drainOfflineQueue(uploader);
      await drainOfflineQueue(uploader);
      await drainOfflineQueue(uploader);

      const remaining = getPendingUploads();
      expect(remaining.find((e) => e.rideId === "poison")).toBeUndefined();
      // The healthy item should have flushed in the very first drain.
      expect(remaining.find((e) => e.rideId === "healthy")).toBeUndefined();
    });

    it("only attempts a poison item once per drain call", async () => {
      // Regression: an earlier version kept the failed item at index 0
      // and re-read the queue in the same loop, which burned all 3
      // retries inside the first drain and hammered the server with
      // rapid-fire 400s. The fix tracks ids already attempted this
      // pass so the retries are spread across drain calls.
      enqueueUpload("poison", [makeReading(1)], "iPhone");
      const poisonCalls = jest.fn();
      const uploader: SensorUploader = async (rideId) => {
        if (rideId === "poison") {
          poisonCalls();
          throw makeServerError(400);
        }
        return { accepted: 1, segments_updated: 0 };
      };

      await drainOfflineQueue(uploader);

      expect(poisonCalls).toHaveBeenCalledTimes(1);
      // Still in the queue, attempts bumped exactly once.
      const [entry] = getPendingUploads();
      expect(entry.rideId).toBe("poison");
      expect(entry.attempts).toBe(1);
    });
  });

  describe("persistence + state", () => {
    it("survives a reload from the backing storage", () => {
      enqueueUpload("ride-1", [makeReading(1)], "iPhone");
      enqueueUpload("ride-2", [makeReading(2)], "iPhone");

      // Simulate process restart: keep the same underlying store, just
      // reset the in-flight flag + listeners via the test hook.
      __setStorageForTest(storage);

      const reloaded = getPendingUploads();
      expect(reloaded.map((e) => e.rideId)).toEqual(["ride-1", "ride-2"]);
    });

    it("clearOfflineQueue wipes the backlog", () => {
      enqueueUpload("ride-1", [makeReading(1)], "iPhone");
      expect(getPendingCount()).toBe(1);
      clearOfflineQueue();
      expect(getPendingCount()).toBe(0);
    });

    it("tolerates a corrupted blob in storage", () => {
      storage.raw.set("pending", "not json {");
      expect(getPendingCount()).toBe(0);
      expect(getPendingUploads()).toEqual([]);
    });

    it("notifies subscribers on enqueue and drain", async () => {
      const snapshots: number[] = [];
      const unsubscribe = subscribePending((n) => snapshots.push(n));
      // Initial fire on subscribe — ergonomic for React state init.
      expect(snapshots).toEqual([0]);

      enqueueUpload("ride-1", [makeReading(1)], "iPhone");
      enqueueUpload("ride-2", [makeReading(2)], "iPhone");

      const uploader: SensorUploader = async () => ({
        accepted: 1,
        segments_updated: 0,
      });
      await drainOfflineQueue(uploader);
      unsubscribe();

      // We should have seen 0 (initial) → 1 (enqueue) → 2 (enqueue)
      // → 1 (drain first) → 0 (drain second).
      expect(snapshots).toEqual([0, 1, 2, 1, 0]);
    });
  });
});
