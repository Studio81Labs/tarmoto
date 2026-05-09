/**
 * Foreground privacy refresh monitor (#279 / #501 — Codex review on
 * PR #513). Asserts the cold-start behaviour, the AppState 'active'
 * subscription, and the auth-gate that skips refreshes when the
 * rider is signed out.
 */

import { AppState, type AppStateStatus } from "react-native";
import {
  startPrivacyRefreshMonitor,
  stopPrivacyRefreshMonitor,
} from "../privacyRefreshMonitor";

type Listener = (next: AppStateStatus) => void;

describe("privacyRefreshMonitor (#279 / #501)", () => {
  let listeners: Listener[];
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopPrivacyRefreshMonitor();
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
    stopPrivacyRefreshMonitor();
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
    startPrivacyRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on cold start when signed out", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startPrivacyRefreshMonitor({
      isAuthenticated: () => false,
      refresh,
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes on every foreground transition", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startPrivacyRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });
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

  it("ignores non-active transitions", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startPrivacyRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });
    await flush();
    refresh.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("inactive"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("swallows refresh failures so the monitor stays subscribed", async () => {
    const refresh = jest.fn().mockRejectedValue(new Error("network down"));
    startPrivacyRefreshMonitor({
      isAuthenticated: () => true,
      refresh,
    });
    await flush();
    // The next foreground transition still fires — a transient
    // failure must not tear down the listener.
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stop = startPrivacyRefreshMonitor({
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
