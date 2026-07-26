/**
 * Foreground entitlements refresh monitor (PR #1086 — Codex P1). The
 * monitor is foreground-only — launch is covered by the cold-start
 * `bootstrapAuth`, so firing here too would just race it. Asserts it does
 * NOT refresh on mount, refreshes on each `AppState` 'active' transition,
 * re-checks auth each time, and stays subscribed through failures.
 */

import { AppState, type AppStateStatus } from "react-native";
import {
  startEntitlementsRefreshMonitor,
  stopEntitlementsRefreshMonitor,
} from "../entitlementsRefreshMonitor";

type Listener = (next: AppStateStatus) => void;

describe("entitlementsRefreshMonitor (PR #1086)", () => {
  let listeners: Listener[];
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopEntitlementsRefreshMonitor();
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
    stopEntitlementsRefreshMonitor();
  });

  function flush(): Promise<void> {
    // Two ticks because the refresh chain is
    // `void refreshIfAuthenticated → await refresh()`.
    return new Promise((resolve) => setImmediate(resolve)).then(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
  }

  function foreground(): void {
    listeners.forEach((l) => l("active"));
  }

  it("does NOT refresh on mount (launch is covered by bootstrapAuth)", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes on every foreground transition", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });

    listeners.forEach((l) => l("background"));
    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    listeners.forEach((l) => l("inactive"));
    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh on foreground when signed out", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => false, refresh });
    foreground();
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-checks auth on each foreground (a rider who signed out is skipped)", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    let authed = true;
    startEntitlementsRefreshMonitor({ isAuthenticated: () => authed, refresh });

    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    authed = false;
    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores non-active transitions", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("inactive"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("swallows refresh failures so the monitor stays subscribed", async () => {
    const refresh = jest.fn().mockRejectedValue(new Error("network down"));
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });

    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The next foreground transition still fires — a transient failure must
    // not tear down the listener.
    foreground();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stop = startEntitlementsRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });

    stop();
    foreground();
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
