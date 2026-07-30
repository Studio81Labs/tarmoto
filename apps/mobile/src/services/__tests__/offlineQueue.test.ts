/**
 * Offline sensor-upload queue — US-18 AC #4.
 *
 * Focus: the behavior the ride-stop flow and the Settings retry button
 * rely on. Persistence is asserted against an in-memory shim (MMKV isn't
 * available in jest); the code already has a guarded fallback for that.
 */

// Operator system-switch cache — default ON so existing assertions are
// unaffected; the `sys_surface_upload` pause suite flips it to force_off.
jest.mock("../systemSwitchCache", () => ({
  isSystemSwitchEnabled: jest.fn(() => true),
}));

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
import { isSystemSwitchEnabled } from "../systemSwitchCache";
import {
  __setStorageForTest as __setPrivacyStorageForTest,
  clearCachedPreferences,
  setCachedPreferences,
} from "../privacyCache";
import type { SensorReading } from "@/types";
import { DEFAULT_PRIVACY_PREFERENCES } from "@tarmoto/shared";

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
  // Shape matches what fetch produces for a disconnect — a TypeError
  // (or generic Error in our facade) with no `status` set. The
  // classifier short-circuits on a numeric `status`, so leaving it
  // unset is what flags the error as network-down.
  return new Error("Network Error");
}

function makeServerError(status: number): Error {
  // Mirrors the `ApiError` shape the typed-client facade throws —
  // `status` is the HTTP status of the response that came back.
  const err = new Error(`HTTP ${status}`) as Error & { status?: number };
  err.status = status;
  return err;
}

describe("offlineQueue", () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    __setStorageForTest(storage);
    // Default privacy storage = canonical defaults (opt-in to road-
    // data contribution) so existing assertions about uploads /
    // queueing pass through. The privacy-gate suite below overrides
    // this per-case.
    __setPrivacyStorageForTest(createMemoryStorage());
    clearCachedPreferences();
    // Default the operator switch ON for every case; the pause suite overrides.
    (isSystemSwitchEnabled as jest.Mock).mockReturnValue(true);
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
        "rsc-v1.0.0",
        [],
        null,
        null,
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
        "rsc-v1.0.0",
        [],
        null,
        null,
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
        null,
        [],
        null,
        null,
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.accepted).toBe(0);
      expect(result.pending).toBe(1);
      expect(getPendingCount()).toBe(1);
      expect(getPendingUploads()[0]?.rideId).toBe("ride-1");
    });

    it("bubbles 4xx client errors so callers can react", async () => {
      // 4xx means the payload or auth is wrong — the queue can't fix
      // that by retrying the same bytes, so the error surfaces.
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      await expect(
        submitSensorUpload(
          "ride-1",
          [makeReading(1)],
          "iPhone",
          null,
          [],
          null,
          null,
          uploader,
        ),
      ).rejects.toThrow("HTTP 400");
      expect(getPendingCount()).toBe(0);
    });

    it("flushes the backlog before the fresh upload so order is preserved", async () => {
      enqueueUpload("old-ride", [makeReading(1)], "iPhone", null);
      const calls: string[] = [];
      const uploader: SensorUploader = jest.fn(async (rideId) => {
        calls.push(rideId);
        return { accepted: 1, segments_updated: 1 };
      });

      const result = await submitSensorUpload(
        "new-ride",
        [makeReading(2)],
        "iPhone",
        null,
        [],
        null,
        null,
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
        null,
        [],
        null,
        null,
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.pending).toBe(1);
      expect(getPendingUploads()[0]?.rideId).toBe("ride-1");
    });

    it("queues the new payload (no live call) when the BACKLOG flush hits a 5xx", async () => {
      // FIFO guard: when the drain stops on a transient server fault
      // it now flags `transientServerError`, and the submit path
      // skips the live POST. Without this, a fresh ride could
      // succeed (if the 5xx was payload-specific) and ship before
      // older queued ones — breaking the chronological order the
      // backend's "newest data wins" aggregation relies on.
      enqueueUpload("old-ride", [makeReading(1)], "iPhone", null);
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >();
      uploader.mockRejectedValueOnce(makeServerError(503));
      uploader.mockResolvedValueOnce({ accepted: 9, segments_updated: 9 });

      const result = await submitSensorUpload(
        "new-ride",
        [makeReading(2)],
        "iPhone",
        null,
        [],
        null,
        null,
        uploader,
      );

      expect(result.status).toBe("queued");
      // Exactly one call: the drain attempt that hit 503. The live
      // POST for "new-ride" must NOT be made.
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(getPendingUploads().map((e) => e.rideId)).toEqual([
        "old-ride",
        "new-ride",
      ]);
    });

    it("queues the new payload if the backlog flush hits the network", async () => {
      // Backlog item pre-seeded. The uploader stays offline the entire
      // call — so neither the backlog item nor the fresh payload can go
      // live, and both should end up on the queue in order.
      enqueueUpload("old-ride", [makeReading(1)], "iPhone", null);
      const uploader: SensorUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitSensorUpload(
        "new-ride",
        [makeReading(2)],
        "iPhone",
        null,
        [],
        null,
        null,
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
      enqueueUpload("poison", [makeReading(1)], "iPhone", null);
      const uploader: SensorUploader = jest.fn(async (rideId) => {
        if (rideId === "poison") throw makeServerError(400);
        return { accepted: 7, segments_updated: 2 };
      });

      const result = await submitSensorUpload(
        "fresh",
        [makeReading(2)],
        "iPhone",
        null,
        [],
        null,
        null,
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.accepted).toBe(7);
      // Poison still waiting its next attempt; fresh was NOT queued.
      const pending = getPendingUploads();
      expect(pending.map((e) => e.rideId)).toEqual(["poison"]);
    });

    it("threads the live submit's preprocessing marker into the upload", async () => {
      // Issue #493 — fresh rides go up with the current build's
      // preprocessing version. Pinning here so a future change that
      // inadvertently strips the field can't silently revert the
      // backend back to "raw axes" for new uploads.
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async () => ({ accepted: 1, segments_updated: 1 }));

      await submitSensorUpload(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        null,
        [],
        "lp22-v1",
        null,
        uploader,
      );

      expect(uploader).toHaveBeenCalledWith(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        null,
        [],
        "lp22-v1",
        null,
      );
    });

    it("replays a queued legacy entry without overwriting its raw-axis marker", async () => {
      // Regression: the live submit path must not replace a queued
      // entry's `preprocessingVersion` with the current build's value
      // when the drain replays it. A ride captured by a pre-#493
      // build sits in the queue with `preprocessingVersion = null`
      // (raw axes); after the user upgrades to a #493 build, the
      // first ride-stop triggers a drain that ships the old payload
      // — and the backend must still see "no marker / raw axes" for
      // that one row, otherwise it gets mislabelled as filtered.
      enqueueUpload("legacy-ride", [makeReading(1)], "iPhone", null, [], null);
      const calls: { rideId: string; preprocessing: string | null }[] = [];
      const uploader: SensorUploader = jest.fn(
        async (rideId, _r, _d, _m, _t, preprocessing) => {
          calls.push({ rideId, preprocessing });
          return { accepted: 1, segments_updated: 0 };
        },
      );

      await submitSensorUpload(
        "fresh-ride",
        [makeReading(2)],
        "iPhone",
        null,
        [],
        "lp22-v1",
        null,
        uploader,
      );

      // Drain replays the legacy entry as raw, then the fresh ride
      // goes live with the current build's marker.
      expect(calls).toEqual([
        { rideId: "legacy-ride", preprocessing: null },
        { rideId: "fresh-ride", preprocessing: "lp22-v1" },
      ]);
    });

    it("normalises a pre-#493 persisted entry (no preprocessingVersion field) to null on read", async () => {
      // A blob persisted by an older app build won't include the
      // `preprocessingVersion` field at all. The read path must
      // tolerate the absence and surface `null` to downstream
      // consumers — without this, the validator would reject the
      // entry and the rider would silently lose the queued ride.
      storage.raw.set(
        "pending",
        JSON.stringify([
          {
            id: "abc",
            rideId: "legacy-ride",
            deviceModel: "iPhone",
            readings: [makeReading(1)],
            modelVersion: null,
            tagEvents: [],
            // preprocessingVersion intentionally absent
            enqueuedAt: Date.now(),
            attempts: 0,
          },
        ]),
      );

      const calls: (string | null)[] = [];
      const uploader: SensorUploader = jest.fn(
        async (_id, _r, _d, _m, _t, preprocessing) => {
          calls.push(preprocessing);
          return { accepted: 1, segments_updated: 0 };
        },
      );

      const result = await drainOfflineQueue(uploader);
      expect(result.flushed).toBe(1);
      expect(calls).toEqual([null]);
    });

    describe("road_data_contribution gate (#279 / #501)", () => {
      it("suppresses uploads when the rider opted out", async () => {
        setCachedPreferences({
          ...DEFAULT_PRIVACY_PREFERENCES,
          road_data_contribution: false,
        });
        const uploader = jest.fn<
          ReturnType<SensorUploader>,
          Parameters<SensorUploader>
        >(async () => ({ accepted: 1, segments_updated: 1 }));

        const result = await submitSensorUpload(
          "ride-opt-out",
          [makeReading(1)],
          "iPhone",
          null,
          [],
          null,
          null,
          uploader,
        );

        // Silent success so the stop flow keeps moving — and we MUST
        // NOT have shipped any bytes.
        expect(result.status).toBe("uploaded");
        expect(result.accepted).toBe(0);
        expect(result.segmentsUpdated).toBe(0);
        expect(uploader).not.toHaveBeenCalled();
        // Skipped uploads must not enqueue either — a payload captured
        // under "no consent" should NEVER replay if the rider toggles
        // the consent back on later.
        expect(getPendingCount()).toBe(0);
      });

      it("uploads normally when the rider opted in", async () => {
        setCachedPreferences({
          ...DEFAULT_PRIVACY_PREFERENCES,
          road_data_contribution: true,
        });
        const uploader = jest.fn<
          ReturnType<SensorUploader>,
          Parameters<SensorUploader>
        >(async () => ({ accepted: 7, segments_updated: 2 }));

        const result = await submitSensorUpload(
          "ride-opt-in",
          [makeReading(1)],
          "iPhone",
          null,
          [],
          null,
          null,
          uploader,
        );

        expect(result.status).toBe("uploaded");
        expect(result.accepted).toBe(7);
        expect(uploader).toHaveBeenCalledTimes(1);
      });

      it("drops a pre-opt-out backlog so it cannot replay later (#501 review)", async () => {
        // Codex review on PR #513: queued payloads were captured while
        // consent was ON, but the rider's CURRENT preference is "don't
        // send" — letting the backlog replay later would silently leak
        // road data against the rider's current consent. The opt-out
        // branch must clear the queue, not just suppress the new send.
        enqueueUpload(
          "queued-while-consenting",
          [makeReading(1)],
          "iPhone",
          null,
        );
        enqueueUpload("queued-too", [makeReading(2)], "iPhone", null);
        expect(getPendingCount()).toBe(2);

        setCachedPreferences({
          ...DEFAULT_PRIVACY_PREFERENCES,
          road_data_contribution: false,
        });
        const uploader = jest.fn<
          ReturnType<SensorUploader>,
          Parameters<SensorUploader>
        >(async () => ({ accepted: 1, segments_updated: 1 }));

        const result = await submitSensorUpload(
          "fresh-payload",
          [makeReading(3)],
          "iPhone",
          null,
          [],
          null,
          null,
          uploader,
        );

        expect(uploader).not.toHaveBeenCalled();
        expect(result.pending).toBe(0);
        expect(getPendingCount()).toBe(0);
      });

      it("does not enqueue the live payload when consent flips off mid-request (#501 review)", async () => {
        // Codex review on PR #513 r3213030169: the retriable-error
        // catch in `submitSensorUpload` previously enqueued the
        // failed live payload unconditionally. If the rider
        // toggled off WHILE the live request was in flight, the
        // fresh ride payload (captured against the now-off
        // preference) used to land in MMKV, ready to be sent
        // later if the rider opted back in.
        setCachedPreferences({
          ...DEFAULT_PRIVACY_PREFERENCES,
          road_data_contribution: true,
        });

        const uploader: SensorUploader = jest.fn(async () => {
          // Toggle off mid-request, then fail retriable.
          setCachedPreferences({
            ...DEFAULT_PRIVACY_PREFERENCES,
            road_data_contribution: false,
          });
          throw makeNetworkError();
        });

        const result = await submitSensorUpload(
          "ride-mid-toggle",
          [makeReading(1)],
          "iPhone",
          null,
          [],
          null,
          null,
          uploader,
        );

        // Silent success (status: "uploaded", zeros) and NO
        // entry in the queue — the rider's current preference
        // is "don't send" and that overrides the
        // catch-and-retry behaviour.
        expect(result.status).toBe("uploaded");
        expect(result.pending).toBe(0);
        expect(getPendingCount()).toBe(0);
      });
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
        transientServerError: false,
      });
      expect(uploader).not.toHaveBeenCalled();
    });

    it("clears any pre-opt-out backlog without uploading when consent is off (#501 review)", async () => {
      // Mirrors the submit path's guard — the Settings "Retry now"
      // button reaches us via this entry point and must not ship
      // pre-opt-out queued payloads against the rider's current
      // consent.
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      expect(getPendingCount()).toBe(2);

      setCachedPreferences({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: false,
      });
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >();

      const result = await drainOfflineQueue(uploader);

      expect(uploader).not.toHaveBeenCalled();
      expect(result).toEqual({
        flushed: 0,
        remaining: 0,
        networkFailed: false,
        transientServerError: false,
      });
      expect(getPendingCount()).toBe(0);
    });

    it("clears the queue when the failing upload coincides with an off-toggle (#501 review)", async () => {
      // Codex review on PR #513 r3213030165: the drain catch
      // block previously broke out with `networkFailed` /
      // `transientServerError` set without rechecking consent.
      // If the rider toggled off WHILE a queued upload was
      // failing, the remaining backlog stayed persisted and
      // could replay if consent flipped back on later.
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      setCachedPreferences({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: true,
      });

      const uploader: SensorUploader = jest.fn(async () => {
        // Toggle off mid-request, then fail with a network error.
        setCachedPreferences({
          ...DEFAULT_PRIVACY_PREFERENCES,
          road_data_contribution: false,
        });
        throw makeNetworkError();
      });

      const result = await drainOfflineQueue(uploader);

      // The catch block sees consent off, wipes the queue, and
      // breaks WITHOUT setting `networkFailed: true` (the rider's
      // current preference takes precedence over the link state).
      expect(result.networkFailed).toBe(false);
      expect(getPendingCount()).toBe(0);
    });

    it("clears the queue even when a drain is already in flight (#501 review)", async () => {
      // Codex review on PR #513 r3212984407: a drain started under
      // consent + then the rider toggling off + then a second
      // caller (e.g. Settings "Retry now") arriving WHILE the
      // first drain is still running used to skip the clear
      // entirely — the second caller would just reuse
      // `drainInFlight`, and if the active loop broke on a
      // network error before its next per-iteration consent
      // check, the queue would persist. The fix moves the
      // consent gate ahead of the in-flight reuse so even a
      // concurrent caller wipes the queue immediately.
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      setCachedPreferences({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: true,
      });

      // First drain: stalls forever so we can simulate the
      // "drain already running" state. We don't await it.
      let resolveStall: () => void = () => undefined;
      const stall = new Promise<{ accepted: number; segments_updated: number }>(
        (resolve) => {
          resolveStall = () => resolve({ accepted: 1, segments_updated: 0 });
        },
      );
      const stallingUploader: SensorUploader = jest.fn(async () => stall);
      const inFlight = drainOfflineQueue(stallingUploader);

      // Toggle off mid-drain.
      setCachedPreferences({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: false,
      });

      // Second caller arrives — must observe the off-toggle and
      // wipe the queue immediately, NOT just inherit
      // `drainInFlight`.
      const secondUploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >();
      const secondResult = await drainOfflineQueue(secondUploader);

      expect(secondResult).toEqual({
        flushed: 0,
        remaining: 0,
        networkFailed: false,
        transientServerError: false,
      });
      expect(secondUploader).not.toHaveBeenCalled();
      expect(getPendingCount()).toBe(0);

      // Let the stalled first uploader complete so the test
      // teardown doesn't leak a pending promise. Its loop will
      // see the now-empty queue on next iteration and exit.
      resolveStall();
      await inFlight;
    });

    it("bails mid-drain when consent toggles off (#501 review)", async () => {
      // Codex review on PR #513 r3212972527: a drain that started
      // under consent must self-cancel if the rider toggles
      // `road_data_contribution` off mid-flight (e.g. via a
      // concurrent privacy refresh after the companion flipped the
      // preference). The in-loop check clears the remaining backlog
      // and returns whatever `flushed` count it reached; subsequent
      // drains see an empty queue.
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      enqueueUpload("c", [makeReading(3)], "iPhone", null);
      // Start with consent on so the entry-point gate doesn't fire.
      setCachedPreferences({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: true,
      });

      let calls = 0;
      const uploader: SensorUploader = jest.fn(async () => {
        calls += 1;
        // Simulate the companion flipping the toggle off after the
        // FIRST queued ride uploads. The drain loop should bail
        // before touching `b` or `c`.
        if (calls === 1) {
          setCachedPreferences({
            ...DEFAULT_PRIVACY_PREFERENCES,
            road_data_contribution: false,
          });
        }
        return { accepted: 1, segments_updated: 0 };
      });

      const result = await drainOfflineQueue(uploader);

      // Exactly one upload happened (the one before the toggle).
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(result.flushed).toBe(1);
      // Remaining backlog dropped — the rider's current consent
      // overrides past captures.
      expect(getPendingCount()).toBe(0);
    });

    it("flushes items oldest-first and empties the queue", async () => {
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      enqueueUpload("c", [makeReading(3)], "iPhone", null);
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
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
      enqueueUpload("c", [makeReading(3)], "iPhone", null);
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
      enqueueUpload("poison", [makeReading(1)], "iPhone", null);
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
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
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
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
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
      expect(getPendingUploads()[0]?.attempts).toBe(0);

      const final = await drainOfflineQueue(uploader);
      expect(final.flushed).toBe(1);
      expect(getPendingCount()).toBe(0);
    });

    it("shares the in-flight drain across concurrent callers", async () => {
      // Two drains started in parallel should return the same result and
      // the uploader should only see each payload once. A boolean lock
      // would return a synthetic no-op to the second caller, racing the
      // real flush and reporting a stale `remaining`.
      enqueueUpload("a", [makeReading(1)], "iPhone", null);
      enqueueUpload("b", [makeReading(2)], "iPhone", null);
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
      enqueueUpload("poison", [makeReading(1)], "iPhone", null);
      enqueueUpload("healthy", [makeReading(2)], "iPhone", null);
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
      enqueueUpload("poison", [makeReading(1)], "iPhone", null);
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
      expect(entry?.rideId).toBe("poison");
      expect(entry?.attempts).toBe(1);
    });
  });

  describe("persistence + state", () => {
    it("survives a reload from the backing storage", () => {
      enqueueUpload("ride-1", [makeReading(1)], "iPhone", null);
      enqueueUpload("ride-2", [makeReading(2)], "iPhone", null);

      // Simulate process restart: keep the same underlying store, just
      // reset the in-flight flag + listeners via the test hook.
      __setStorageForTest(storage);

      const reloaded = getPendingUploads();
      expect(reloaded.map((e) => e.rideId)).toEqual(["ride-1", "ride-2"]);
    });

    it("clearOfflineQueue wipes the backlog", () => {
      enqueueUpload("ride-1", [makeReading(1)], "iPhone", null);
      expect(getPendingCount()).toBe(1);
      clearOfflineQueue();
      expect(getPendingCount()).toBe(0);
    });

    it("tolerates a corrupted blob in storage", () => {
      storage.raw.set("pending", "not json {");
      expect(getPendingCount()).toBe(0);
      expect(getPendingUploads()).toEqual([]);
    });

    it("forwards modelVersion through enqueue → drain → uploader", async () => {
      // US-3: backend persists which classifier produced each batch so
      // a deprecation step can ignore older outputs. The queue must not
      // drop the field across the offline round-trip.
      enqueueUpload("ride-ml", [makeReading(1)], "iPhone", "rsc-v1.0.0");
      enqueueUpload("ride-heuristic", [makeReading(2)], "iPhone", null);

      const calls: Array<string | null> = [];
      const uploader: SensorUploader = async (_id, _r, _model, version) => {
        calls.push(version);
        return { accepted: 1, segments_updated: 0 };
      };
      await drainOfflineQueue(uploader);

      expect(calls).toEqual(["rsc-v1.0.0", null]);
    });

    it("forwards tag events through enqueue → drain → uploader (issue #7)", async () => {
      // Research issue #7: rider-asserted surface labels travel with
      // the readings through the offline queue. Losing them on the
      // queue round-trip would silently drop ground-truth data, so
      // assert the uploader sees the same array we enqueued.
      enqueueUpload("ride-tagged", [makeReading(1)], "iPhone", null, [
        { t: 1_000, label: "smooth_asphalt" },
      ]);

      const seen: Array<unknown> = [];
      const uploader: SensorUploader = async (
        _id,
        _r,
        _model,
        _version,
        tags,
      ) => {
        seen.push(tags);
        return { accepted: 1, segments_updated: 1 };
      };
      await drainOfflineQueue(uploader);

      expect(seen).toEqual([[{ t: 1_000, label: "smooth_asphalt" }]]);
    });

    it("normalises pre-#7 entries lacking tagEvents to []", () => {
      // A persisted blob from an older app build is missing the
      // field. The drain path needs a stable shape to pass into the
      // uploader, so the read path normalises to an empty array.
      const legacyEntry = {
        id: "legacy-1",
        rideId: "ride-1",
        deviceModel: "iPhone",
        readings: [makeReading(1)],
        modelVersion: null,
        enqueuedAt: 1,
        attempts: 0,
        // tagEvents intentionally omitted
      };
      storage.raw.set("pending", JSON.stringify([legacyEntry]));

      const restored = getPendingUploads();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.tagEvents).toEqual([]);
    });

    it("normalises pre-#494 entries lacking calibration to null", () => {
      // A persisted blob from an older app build is missing the
      // calibration field. The drain path needs a stable shape to
      // pass into the uploader, so the read path normalises to null.
      const legacyEntry = {
        id: "legacy-1",
        rideId: "ride-1",
        deviceModel: "iPhone",
        readings: [makeReading(1)],
        modelVersion: null,
        tagEvents: [],
        enqueuedAt: 1,
        attempts: 0,
        // calibration intentionally omitted
      };
      storage.raw.set("pending", JSON.stringify([legacyEntry]));

      const restored = getPendingUploads();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.calibration).toBeNull();
    });

    it("forwards calibration through enqueue → drain → uploader (issue #494)", async () => {
      // Idle-baseline calibration must travel with the readings
      // through the offline queue. Losing it on the round-trip would
      // strip the per-rider bias the backend uses to flag suspicious
      // uploads.
      const calibration = {
        axis_mean_x: 0.05,
        axis_mean_y: -0.02,
        axis_mean_z: 9.79,
        axis_std_x: 0.08,
        axis_std_y: 0.07,
        axis_std_z: 0.09,
        sample_count: 1500,
        truncated: false,
      };
      enqueueUpload(
        "ride-cal",
        [makeReading(1)],
        "iPhone",
        null,
        [],
        null,
        calibration,
      );

      const seen: Array<unknown> = [];
      const uploader: SensorUploader = async (
        _id,
        _r,
        _model,
        _version,
        _tags,
        _preprocessing,
        cal,
      ) => {
        seen.push(cal);
        return { accepted: 1, segments_updated: 1 };
      };
      await drainOfflineQueue(uploader);

      expect(seen).toEqual([calibration]);
    });

    it("normalises pre-US-3 entries lacking modelVersion to null", () => {
      // A persisted blob from an older app build is missing the field.
      // Reading it back must round-trip cleanly with `modelVersion:
      // null` rather than failing the shape guard and silently dropping
      // the rider's queued ride.
      const legacyEntry = {
        id: "legacy-1",
        rideId: "ride-1",
        deviceModel: "iPhone",
        readings: [makeReading(1)],
        enqueuedAt: 1,
        attempts: 0,
      };
      storage.raw.set("pending", JSON.stringify([legacyEntry]));

      const restored = getPendingUploads();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.rideId).toBe("ride-1");
      expect(restored[0]?.modelVersion).toBeNull();
    });

    it("notifies subscribers on enqueue and drain", async () => {
      const snapshots: number[] = [];
      const unsubscribe = subscribePending((n) => snapshots.push(n));
      // Initial fire on subscribe — ergonomic for React state init.
      expect(snapshots).toEqual([0]);

      enqueueUpload("ride-1", [makeReading(1)], "iPhone", null);
      enqueueUpload("ride-2", [makeReading(2)], "iPhone", null);

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

  describe("sys_surface_upload operator pause", () => {
    it("holds the payload (queues, no upload) when the switch is force_off", async () => {
      (isSystemSwitchEnabled as jest.Mock).mockReturnValue(false);
      const uploader = jest.fn<
        ReturnType<SensorUploader>,
        Parameters<SensorUploader>
      >(async () => ({ accepted: 1, segments_updated: 0 }));

      const result = await submitSensorUpload(
        "ride-1",
        [makeReading(1)],
        "iPhone",
        "rsc-v1.0.0",
        [],
        null,
        null,
        uploader,
      );

      // Queued, not uploaded, and never sent to the network — it resumes when
      // the operator re-enables the switch.
      expect(result.status).toBe("queued");
      expect(result.pending).toBe(1);
      expect(uploader).not.toHaveBeenCalled();
      expect(isSystemSwitchEnabled).toHaveBeenCalledWith("sys_surface_upload");
    });

    it("holds the existing backlog (no drain) when the switch is force_off", async () => {
      // Seed a backlog captured while the switch was on.
      enqueueUpload("ride-0", [makeReading(0)], "iPhone", null, [], null, null);
      expect(getPendingCount()).toBe(1);

      (isSystemSwitchEnabled as jest.Mock).mockReturnValue(false);
      const uploader: SensorUploader = jest.fn(async () => ({
        accepted: 1,
        segments_updated: 0,
      }));

      const result = await drainOfflineQueue(uploader);

      // Backlog retained intact; nothing drained or dropped.
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
      expect(uploader).not.toHaveBeenCalled();
      expect(getPendingCount()).toBe(1);
    });

    it("resumes draining once the switch is back on", async () => {
      enqueueUpload("ride-0", [makeReading(0)], "iPhone", null, [], null, null);
      const uploader: SensorUploader = jest.fn(async () => ({
        accepted: 1,
        segments_updated: 0,
      }));

      // Switch defaults ON (beforeEach) → the backlog flushes normally.
      const result = await drainOfflineQueue(uploader);

      expect(result.flushed).toBe(1);
      expect(getPendingCount()).toBe(0);
      expect(uploader).toHaveBeenCalledTimes(1);
    });
  });
});
