/**
 * Device-timezone sync monitor (#866 — Codex review on PR #933). Asserts the
 * cold-start sync, the AppState 'active' subscription, the auth-gate, the
 * change-guard that avoids redundant writes, and re-sync after a sign-out.
 */

import { AppState, type AppStateStatus } from "react-native";
import {
  startTimezoneSyncMonitor,
  stopTimezoneSyncMonitor,
} from "../timezoneSyncMonitor";

type Listener = (next: AppStateStatus) => void;

describe("timezoneSyncMonitor (#866)", () => {
  let listeners: Listener[];
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopTimezoneSyncMonitor();
    listeners = [];
    addEventListenerSpy = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((event: string, listener: Listener) => {
        if (event === "change") listeners.push(listener);
        return {
          remove: () => {
            listeners = listeners.filter((l) => l !== listener);
          },
        };
      });
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    stopTimezoneSyncMonitor();
  });

  function flush(): Promise<void> {
    // Two ticks: the cold-start chain is `void syncIfNeeded → await sync()`.
    return new Promise((resolve) => setImmediate(resolve)).then(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
  }

  it("syncs the device timezone on cold start when authenticated", async () => {
    const sync = jest.fn().mockResolvedValue(undefined);
    startTimezoneSyncMonitor({
      isAuthenticated: () => true,
      currentTimezone: () => "Europe/Prague",
      sync,
    });
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("Europe/Prague");
  });

  it("does not sync on cold start when signed out", async () => {
    const sync = jest.fn().mockResolvedValue(undefined);
    startTimezoneSyncMonitor({
      isAuthenticated: () => false,
      currentTimezone: () => "Europe/Prague",
      sync,
    });
    await flush();
    expect(sync).not.toHaveBeenCalled();
  });

  it("skips an unchanged-timezone foreground but syncs when it changes", async () => {
    let tz = "Europe/Prague";
    const sync = jest.fn().mockResolvedValue(undefined);
    startTimezoneSyncMonitor({
      isAuthenticated: () => true,
      currentTimezone: () => tz,
      sync,
    });
    await flush();
    expect(sync).toHaveBeenCalledTimes(1); // cold start

    // Same timezone → no redundant full-row write.
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    // Rider crossed a timezone → one more write.
    tz = "America/New_York";
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith("America/New_York");
  });

  it("retries on the next foreground after a failed sync", async () => {
    const sync = jest
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(undefined);
    startTimezoneSyncMonitor({
      isAuthenticated: () => true,
      currentTimezone: () => "Europe/Prague",
      sync,
    });
    await flush(); // cold-start attempt fails → not marked synced
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("re-syncs after a sign-out/sign-in even on the same device timezone", async () => {
    let authed = true;
    const sync = jest.fn().mockResolvedValue(undefined);
    startTimezoneSyncMonitor({
      isAuthenticated: () => authed,
      currentTimezone: () => "Europe/Prague",
      sync,
    });
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    // Sign out — a foreground while signed out resets the change-guard.
    authed = false;
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    // Sign back in — the same timezone must sync again for the new session.
    authed = true;
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const sync = jest.fn().mockResolvedValue(undefined);
    const stop = startTimezoneSyncMonitor({
      isAuthenticated: () => true,
      currentTimezone: () => "Europe/Prague",
      sync,
    });
    await flush();
    sync.mockClear();

    stop();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(sync).not.toHaveBeenCalled();
  });
});
