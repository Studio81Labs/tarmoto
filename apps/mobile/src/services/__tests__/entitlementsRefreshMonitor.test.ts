/**
 * Foreground entitlements refresh monitor (PR #1086 — Codex P1).
 * Asserts the cold-start behaviour, the AppState 'active' subscription,
 * and the auth-gate that skips refreshes when the rider is signed out —
 * so the client-enforced gates re-check the server instead of enforcing
 * the launch-time snapshot indefinitely.
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
    // Two ticks because the cold-start refresh chain is
    // `void refreshIfAuthenticated → await refresh()`.
    return new Promise((resolve) => setImmediate(resolve)).then(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
  }

  it("refreshes on cold start when authenticated", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on cold start when signed out", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => false, refresh });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes on every foreground transition", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });
    await flush();
    refresh.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    listeners.forEach((l) => l("inactive"));
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("re-checks auth on each foreground (a rider who signed out is skipped)", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    let authed = true;
    startEntitlementsRefreshMonitor({
      isAuthenticated: () => authed,
      refresh,
    });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    authed = false;
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores non-active transitions", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });
    await flush();
    refresh.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("inactive"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("swallows refresh failures so the monitor stays subscribed", async () => {
    const refresh = jest.fn().mockRejectedValue(new Error("network down"));
    startEntitlementsRefreshMonitor({ isAuthenticated: () => true, refresh });
    await flush();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stop = startEntitlementsRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });
    await flush();
    refresh.mockClear();

    stop();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
