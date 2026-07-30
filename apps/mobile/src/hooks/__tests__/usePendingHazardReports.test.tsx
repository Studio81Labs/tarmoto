/**
 * usePendingHazardReports — focused on the retry contract.
 *
 * The visual integration lives in `SettingsScreen.pendingHazards.test.tsx`.
 * This file pins down the hook semantics:
 *  - `count` mirrors the queue's pending count via `subscribePending`
 *  - `retry` calls `flushPendingHazardReports` and surfaces a snapshot
 *    of `{ flushed, failed, remaining }` (failed = before − flushed −
 *    remaining), which is what the toast is composed from
 *  - re-entrancy is locked synchronously so a rapid double-tap doesn't
 *    fire two flushes
 */

import { act, renderHook, waitFor } from "@testing-library/react-native";
import { usePendingHazardReports } from "../usePendingHazardReports";
import { api } from "@/services/api";
import {
  __setStorageForTest,
  clearHazardQueue,
  enqueueHazardReport,
} from "@/services/hazardQueue";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

jest.mock("@/services/api", () => ({
  api: {
    flushPendingHazardReports: jest.fn(),
  },
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

function makeMemoryStorage() {
  const memory = new Map<string, string>();
  return {
    getString: (key: string) => memory.get(key),
    set: (key: string, value: string) => {
      memory.set(key, value);
    },
    remove: (key: string) => {
      memory.delete(key);
    },
  };
}

beforeEach(() => {
  __setStorageForTest(makeMemoryStorage());
  (api.flushPendingHazardReports as jest.Mock).mockReset();
  (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
});

describe("usePendingHazardReports", () => {
  it("seeds count from the queue and tracks subsequent enqueues", async () => {
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });

    const { result } = await renderHook(() => usePendingHazardReports());

    expect(result.current.count).toBe(1);

    await act(() => {
      enqueueHazardReport({
        lat: 49.3,
        lng: 16.7,
        hazardType: "gravel",
        severity: "low",
      });
    });

    await waitFor(() => {
      expect(result.current.count).toBe(2);
    });
  });

  it("captures flushed + remaining in lastResult and derives failed = before − flushed − remaining", async () => {
    // Three queued, drain reports: flushed=2, remaining=0
    //   → failed = 3 − 2 − 0 = 1 (one poison pill dropped)
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });
    enqueueHazardReport({
      lat: 49.3,
      lng: 16.7,
      hazardType: "gravel",
      severity: "low",
    });
    enqueueHazardReport({
      lat: 49.4,
      lng: 16.8,
      hazardType: "ice",
      severity: "high",
    });

    (api.flushPendingHazardReports as jest.Mock).mockImplementation(
      async () => {
        // Simulate the drain by clearing the queue (the real queue would
        // notify via `writeQueue`). We bypass that here because the hook
        // only reads `flushed` / `remaining` from the API result.
        __setStorageForTest(makeMemoryStorage());
        return {
          flushed: 2,
          remaining: 0,
          networkFailed: false,
          transientServerError: false,
        };
      },
    );

    const { result } = await renderHook(() => usePendingHazardReports());
    expect(result.current.count).toBe(3);

    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.lastResult).toEqual({
      flushed: 2,
      failed: 1,
      remaining: 0,
    });
    expect(result.current.isRetrying).toBe(false);
  });

  it("reports a remaining backlog when the drain stops on network failure", async () => {
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });
    enqueueHazardReport({
      lat: 49.3,
      lng: 16.7,
      hazardType: "gravel",
      severity: "low",
    });

    (api.flushPendingHazardReports as jest.Mock).mockResolvedValue({
      flushed: 0,
      remaining: 2,
      networkFailed: true,
      transientServerError: false,
    });

    const { result } = await renderHook(() => usePendingHazardReports());
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.lastResult).toEqual({
      flushed: 0,
      failed: 0,
      remaining: 2,
    });
  });

  it("clears lastResult when the queue drifts away from the post-retry snapshot", async () => {
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });

    (api.flushPendingHazardReports as jest.Mock).mockImplementation(
      async () => {
        // Mirror a clean drain through the queue's own API so the
        // listeners stay attached — the realistic path the rider's
        // retry takes.
        clearHazardQueue();
        return {
          flushed: 1,
          remaining: 0,
          networkFailed: false,
          transientServerError: false,
        };
      },
    );

    const { result } = await renderHook(() => usePendingHazardReports());
    await act(async () => {
      await result.current.retry();
    });

    // Drain settled cleanly — the success outcome is rendered.
    expect(result.current.lastResult).toEqual({
      flushed: 1,
      failed: 0,
      remaining: 0,
    });
    expect(result.current.count).toBe(0);

    // Rider submits another report offline. The previous "Uploaded 1
    // report." outcome no longer describes the queue and must clear,
    // otherwise it would sit next to the fresh pending-count copy.
    await act(() => {
      enqueueHazardReport({
        lat: 49.3,
        lng: 16.7,
        hazardType: "gravel",
        severity: "low",
      });
    });

    await waitFor(() => {
      expect(result.current.count).toBe(1);
      expect(result.current.lastResult).toBeNull();
    });
  });

  it("locks out a second retry until the first one resolves", async () => {
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });

    let release: (() => void) | undefined;
    (api.flushPendingHazardReports as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              flushed: 1,
              remaining: 0,
              networkFailed: false,
              transientServerError: false,
            });
        }),
    );

    const { result } = await renderHook(() => usePendingHazardReports());

    let firstCall: Promise<void>;
    await act(() => {
      firstCall = result.current.retry();
      // Second call hits the synchronous re-entrancy guard before React
      // commits `isRetrying = true`. It must no-op without touching the
      // API.
      void result.current.retry();
    });

    expect(api.flushPendingHazardReports).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await firstCall;
    });

    expect(result.current.lastResult?.flushed).toBe(1);
  });

  it("does NOT drain the queue when hazard_reporting is operator-disabled", async () => {
    // The drain is the same POST path as a live submit — an operator kill for
    // an abuse wave must hold the queue, not flush it.
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    enqueueHazardReport({
      lat: 49.2,
      lng: 16.6,
      hazardType: "pothole",
      severity: "medium",
    });

    const { result } = await renderHook(() => usePendingHazardReports());

    await act(async () => {
      await result.current.retry();
    });

    expect(api.flushPendingHazardReports).not.toHaveBeenCalled();
    // Queue is held intact for when reporting is re-enabled.
    expect(result.current.count).toBe(1);
  });
});
