/**
 * Hazard report queue — US-4 AC #6.
 *
 * Mirrors the offlineQueue tests: the persistence layer falls back to
 * an in-memory shim under jest, and the focus is on the behavior the
 * HazardReportScreen submit handler depends on (live POST, queue on
 * disconnect, drain backlog before fresh submit, drop poison pills).
 */

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

import {
  __setStorageForTest,
  clearHazardQueue,
  drainHazardQueue,
  enqueueHazardReport,
  getPendingCount,
  getPendingHazardReports,
  submitHazardReport,
  type HazardReportPayload,
  type HazardUploader,
} from "../hazardQueue";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import type { Hazard } from "@/types";

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
    raw: store,
  };
}

function makePayload(
  overrides: Partial<HazardReportPayload> = {},
): HazardReportPayload {
  return {
    lat: 49.82,
    lng: 18.26,
    hazardType: "pothole",
    severity: "medium",
    ...overrides,
  };
}

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "hazard-1",
    lat: 49.82,
    lng: 18.26,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: "rider-1",
    road_name: null,
    created_at: "2026-04-25T08:00:00.000Z",
    expires_at: "2026-04-26T08:00:00.000Z",
    ...overrides,
  };
}

function makeNetworkError(): Error {
  // Mirrors a fetch transport-level failure — message contains
  // "network", `status` is absent. The classifier uses the latter
  // to distinguish link-down from server-returned errors.
  return new Error("Network Error");
}

function makeServerError(status: number): Error {
  // Mirrors the `ApiError` shape the typed-client facade throws.
  const err = new Error(`HTTP ${status}`) as Error & { status?: number };
  err.status = status;
  return err;
}

describe("hazardQueue", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
  });

  describe("submitHazardReport", () => {
    it("uploads immediately when the network works", async () => {
      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(async () => makeHazard());

      const result = await submitHazardReport(
        makePayload({ note: "Big pothole near bridge" }),
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.hazard?.id).toBe("hazard-1");
      expect(result.pending).toBe(0);
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(uploader).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: 49.82,
          lng: 18.26,
          hazardType: "pothole",
          severity: "medium",
          note: "Big pothole near bridge",
        }),
      );
    });

    it("queues a fresh report (does NOT POST it) when the switch is killed mid-drain", async () => {
      // Codex P1: a live submit whose backlog-drain gets killed must not slip
      // the fresh report past the switch — it has to be queued.
      enqueueHazardReport(makePayload({ note: "queued backlog" }));
      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(async () => {
        // Operator disables reporting while draining the backlog item.
        (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
        return makeHazard();
      });

      const result = await submitHazardReport(
        makePayload({ note: "fresh report" }),
        uploader,
      );

      // Only the backlog item hit the network; the fresh report is queued.
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("queued");
      const notes = getPendingHazardReports().map((e) => e.note);
      expect(notes).toContain("fresh report");
    });

    it("queues a fresh report when the switch is already off and the queue is empty", async () => {
      // No backlog → the drain loop never iterates, so `killed` stays false;
      // the pre-upload recheck must still hold the report.
      (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      const uploader: HazardUploader = jest.fn(async () => makeHazard());

      const result = await submitHazardReport(
        makePayload({ note: "fresh report" }),
        uploader,
      );

      expect(uploader).not.toHaveBeenCalled();
      expect(result.status).toBe("queued");
      expect(getPendingHazardReports()).toHaveLength(1);
    });

    it("queues the payload when the network is down", async () => {
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitHazardReport(
        makePayload({ photoUri: "file:///tmp/photo.jpg" }),
        uploader,
      );

      expect(result.status).toBe("queued");
      expect(result.hazard).toBeUndefined();
      expect(result.pending).toBe(1);

      const pending = getPendingHazardReports();
      expect(pending).toHaveLength(1);
      // Photo URI must round-trip so a future drain can ship it once
      // the backend file-upload endpoint lands.
      expect(pending[0]?.photoUri).toBe("file:///tmp/photo.jpg");
      expect(pending[0]?.hazardType).toBe("pothole");
    });

    it("queues on transient server errors (5xx)", async () => {
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeServerError(503);
      });

      const result = await submitHazardReport(makePayload(), uploader);

      expect(result.status).toBe("queued");
      expect(getPendingCount()).toBe(1);
    });

    it("propagates 4xx client errors so the rider can react", async () => {
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      await expect(submitHazardReport(makePayload(), uploader)).rejects.toThrow(
        "HTTP 400",
      );
      // Bad payload must NOT be persisted — retrying the same bytes
      // won't fix it.
      expect(getPendingCount()).toBe(0);
    });

    it("drains backlog before sending the fresh payload", async () => {
      enqueueHazardReport(
        makePayload({ hazardType: "ice", note: "queued first" }),
      );
      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(async (payload) => makeHazard({ id: `srv-${payload.hazardType}` }));

      const result = await submitHazardReport(
        makePayload({ hazardType: "gravel", note: "live second" }),
        uploader,
      );

      expect(result.status).toBe("uploaded");
      expect(result.hazard?.id).toBe("srv-gravel");
      // Two calls: 1) drained backlog, 2) fresh payload.
      expect(uploader).toHaveBeenCalledTimes(2);
      expect(uploader.mock.calls[0]?.[0]?.note).toBe("queued first");
      expect(uploader.mock.calls[1]?.[0]?.note).toBe("live second");
      expect(getPendingCount()).toBe(0);
    });

    it("queues fresh payload immediately if backlog drain hits a network error", async () => {
      enqueueHazardReport(makePayload({ note: "old report" }));
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await submitHazardReport(
        makePayload({ note: "new report" }),
        uploader,
      );

      expect(result.status).toBe("queued");
      // The drain attempted the old report once (and failed), then we
      // skipped the live call because the link is down.
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(getPendingCount()).toBe(2);
    });

    it("queues fresh payload (no live call) when backlog drain hits a transient server error", async () => {
      // Critical FIFO guard: the drain stops on 5xx/408/429 WITHOUT
      // setting `networkFailed`, because the link is fine. Without the
      // `transientServerError` flag the submit path would still try
      // the live POST — and if it succeeded (e.g. the rate limit was
      // payload-specific or a one-off), the new hazard would ship
      // before the older queued ones, breaking FIFO.
      enqueueHazardReport(makePayload({ note: "old report" }));
      // First call (drain) throws 503, second call (the live POST that
      // must NOT happen) would succeed if invoked — the test asserts
      // it isn't.
      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >();
      uploader.mockRejectedValueOnce(makeServerError(503));
      uploader.mockResolvedValueOnce(makeHazard({ id: "should-not-ship" }));

      const result = await submitHazardReport(
        makePayload({ note: "new report" }),
        uploader,
      );

      expect(result.status).toBe("queued");
      // Exactly one call: the drain attempt that hit 503. The live POST
      // for the fresh payload must NOT be made.
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(getPendingCount()).toBe(2);
    });
  });

  describe("drainHazardQueue stop reasons", () => {
    it("flags transientServerError without networkFailed on 5xx", async () => {
      enqueueHazardReport(makePayload());
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeServerError(503);
      });

      const result = await drainHazardQueue(uploader);
      expect(result.networkFailed).toBe(false);
      expect(result.transientServerError).toBe(true);
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it("flags networkFailed without transientServerError on link-down", async () => {
      enqueueHazardReport(makePayload());
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeNetworkError();
      });

      const result = await drainHazardQueue(uploader);
      expect(result.networkFailed).toBe(true);
      expect(result.transientServerError).toBe(false);
    });
  });

  describe("drainHazardQueue", () => {
    it("flushes everything in chronological order", async () => {
      enqueueHazardReport(makePayload({ note: "first" }));
      enqueueHazardReport(makePayload({ note: "second" }));
      enqueueHazardReport(makePayload({ note: "third" }));

      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(async () => makeHazard());

      const result = await drainHazardQueue(uploader);
      expect(result.flushed).toBe(3);
      expect(result.remaining).toBe(0);
      expect(result.networkFailed).toBe(false);
      const notes = uploader.mock.calls.map((c) => c[0].note);
      expect(notes).toEqual(["first", "second", "third"]);
    });

    it("stops mid-drain and retains the queue when hazard_reporting is killed", async () => {
      // Codex P1: a kill landing while the drain loop is running must halt it
      // per-item and keep the remaining reports, not push the whole backlog.
      enqueueHazardReport(makePayload({ note: "first" }));
      enqueueHazardReport(makePayload({ note: "second" }));
      enqueueHazardReport(makePayload({ note: "third" }));

      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(async () => {
        // Operator disables reporting while the first upload is in flight.
        (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
        return makeHazard();
      });

      const result = await drainHazardQueue(uploader);

      // Only the first item POSTed; the loop broke before touching the rest.
      expect(uploader).toHaveBeenCalledTimes(1);
      expect(result.flushed).toBe(1);
      expect(result.remaining).toBe(2);
    });

    it("does not POST anything if hazard_reporting is already off at drain start", async () => {
      (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      enqueueHazardReport(makePayload({ note: "first" }));
      const uploader: HazardUploader = jest.fn(async () => makeHazard());

      const result = await drainHazardQueue(uploader);

      expect(uploader).not.toHaveBeenCalled();
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it("stops at the first network error and flags networkFailed", async () => {
      enqueueHazardReport(makePayload({ note: "first" }));
      enqueueHazardReport(makePayload({ note: "second" }));

      let calls = 0;
      const uploader: HazardUploader = jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw makeNetworkError();
        return makeHazard();
      });

      const result = await drainHazardQueue(uploader);
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(2);
      expect(result.networkFailed).toBe(true);
      expect(uploader).toHaveBeenCalledTimes(1);
    });

    it("drops poison pills after three attempts so they don't starve the queue", async () => {
      enqueueHazardReport(makePayload({ note: "broken" }));
      const uploader: HazardUploader = jest.fn(async () => {
        throw makeServerError(400);
      });

      // Three drains exhaust the per-payload retry budget; the entry is
      // dropped on the third drop so subsequent fresh calls aren't
      // blocked behind a permanently-broken report.
      await drainHazardQueue(uploader);
      expect(getPendingCount()).toBe(1);
      await drainHazardQueue(uploader);
      expect(getPendingCount()).toBe(1);
      await drainHazardQueue(uploader);
      expect(getPendingCount()).toBe(0);
    });

    it("dedupes concurrent drains so we don't double-fire", async () => {
      enqueueHazardReport(makePayload({ note: "one" }));
      const pendingResolvers: Array<(value: Hazard) => void> = [];
      const uploader = jest.fn<
        ReturnType<HazardUploader>,
        [HazardReportPayload]
      >(
        () =>
          new Promise<Hazard>((resolve) => {
            pendingResolvers.push(resolve);
          }),
      );

      const a = drainHazardQueue(uploader);
      const b = drainHazardQueue(uploader);
      expect(a).toBe(b);

      pendingResolvers[0]?.(makeHazard());
      const result = await a;
      expect(result.flushed).toBe(1);
      expect(uploader).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearHazardQueue", () => {
    it("removes everything", () => {
      enqueueHazardReport(makePayload());
      enqueueHazardReport(makePayload());
      expect(getPendingCount()).toBe(2);
      clearHazardQueue();
      expect(getPendingCount()).toBe(0);
    });
  });
});
