/**
 * Foreground system-switch refresh monitor.
 *
 * Asserts the cold-start refresh, the AppState 'active' subscription, and — the
 * deliberate difference from `privacyRefreshMonitor` — that there is NO auth
 * gate: `/config/flags` is public, so a signed-out phone still refreshes so its
 * accelerometer kill switch honours the live operator state.
 */

import { AppState, type AppStateStatus } from "react-native";
import type { GlobalFeatureStates } from "@tarmoto/shared";
import {
  startSystemSwitchRefreshMonitor,
  stopSystemSwitchRefreshMonitor,
} from "../systemSwitchRefreshMonitor";

type Listener = (next: AppStateStatus) => void;

describe("systemSwitchRefreshMonitor", () => {
  let listeners: Listener[];
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopSystemSwitchRefreshMonitor();
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
    stopSystemSwitchRefreshMonitor();
  });

  function flush(): Promise<void> {
    // Two ticks: the cold-start chain is `void refreshQuietly → await refresh()`.
    return new Promise((resolve) => setImmediate(resolve)).then(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
  }

  it("fetches and persists on cold start with no auth gate", async () => {
    const states = { sys_accel_collection: "force_off" } as const;
    const fetchStates = jest.fn().mockResolvedValue(states);
    const persist = jest.fn();
    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    await flush();
    expect(fetchStates).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(states);
  });

  it("refreshes on every foreground transition", async () => {
    const fetchStates = jest.fn().mockResolvedValue({});
    const persist = jest.fn();
    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    await flush();
    fetchStates.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("active"));
    await flush();
    expect(fetchStates).toHaveBeenCalledTimes(1);

    listeners.forEach((l) => l("inactive"));
    listeners.forEach((l) => l("active"));
    await flush();
    expect(fetchStates).toHaveBeenCalledTimes(2);
  });

  it("ignores non-active transitions", async () => {
    const fetchStates = jest.fn().mockResolvedValue({});
    const persist = jest.fn();
    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    await flush();
    fetchStates.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("inactive"));
    await flush();
    expect(fetchStates).not.toHaveBeenCalled();
  });

  it("swallows fetch failures so the monitor stays subscribed", async () => {
    const fetchStates = jest.fn().mockRejectedValue(new Error("network down"));
    const persist = jest.fn();
    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    await flush();
    expect(persist).not.toHaveBeenCalled();
    // A transient failure must not tear down the listener.
    listeners.forEach((l) => l("active"));
    await flush();
    expect(fetchStates).toHaveBeenCalledTimes(2);
  });

  it("does not let a slow older fetch overwrite a newer one", async () => {
    // Cold-start fetch resolves LATE with the pre-force_off (stale) map;
    // a foreground fetch started later resolves FIRST with force_off. The
    // stale cold-start result must be dropped by the generation guard so it
    // can't re-enable the subsystem the operator just killed.
    const resolvers: Array<(v: GlobalFeatureStates) => void> = [];
    const fetchStates = jest
      .fn()
      .mockImplementation(
        () => new Promise<GlobalFeatureStates>((r) => resolvers.push(r)),
      );
    const persist = jest.fn();

    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    // Cold-start fetch is now in flight (resolvers[0]).
    listeners.forEach((l) => l("active"));
    // Foreground fetch in flight too (resolvers[1]).
    expect(fetchStates).toHaveBeenCalledTimes(2);

    // Newer (foreground) resolves first with the kill state, then the older
    // cold-start resolves with the stale map.
    resolvers[1]?.({ sys_accel_collection: "force_off" });
    await flush();
    resolvers[0]?.({});
    await flush();

    // Only the newer result was published; the stale one was dropped.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ sys_accel_collection: "force_off" });
  });

  it("honours an older valid result when the newer fetch fails", async () => {
    // Cold-start fetch is in flight; a foreground fetch starts but REJECTS.
    // The older fetch then resolves with `force_off` — since the failed newer
    // fetch never published, the older valid result MUST still be applied
    // (otherwise the cache stays default-ON and collection keeps running).
    let resolveCold: ((v: GlobalFeatureStates) => void) | undefined;
    let rejectForeground: ((e: Error) => void) | undefined;
    const fetchStates = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<GlobalFeatureStates>((r) => (resolveCold = r)),
      )
      .mockImplementationOnce(
        () =>
          new Promise<GlobalFeatureStates>((_r, j) => (rejectForeground = j)),
      );
    const persist = jest.fn();

    startSystemSwitchRefreshMonitor({ fetchStates, persist });
    listeners.forEach((l) => l("active"));
    expect(fetchStates).toHaveBeenCalledTimes(2);

    // Newer (foreground) fails first, then the older cold-start succeeds.
    rejectForeground?.(new Error("network down"));
    await flush();
    resolveCold?.({ sys_accel_collection: "force_off" });
    await flush();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ sys_accel_collection: "force_off" });
  });

  it("polls at the ~5-min interval while foregrounded, pausing when backgrounded", async () => {
    jest.useFakeTimers();
    try {
      const fetchStates = jest.fn().mockResolvedValue({});
      const persist = jest.fn();
      startSystemSwitchRefreshMonitor({ fetchStates, persist });
      // Cold-start fetch — flush microtasks (fake timers don't fake promises).
      await Promise.resolve();
      await Promise.resolve();
      fetchStates.mockClear();

      // A long-foregrounded session (active ride/nav) still learns of an
      // operator flip via the interval, without a background/foreground cycle.
      jest.advanceTimersByTime(5 * 60_000);
      expect(fetchStates).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(5 * 60_000);
      expect(fetchStates).toHaveBeenCalledTimes(2);

      // Backgrounded → polling pauses (no network churn while away).
      listeners.forEach((l) => l("background"));
      fetchStates.mockClear();
      jest.advanceTimersByTime(15 * 60_000);
      expect(fetchStates).not.toHaveBeenCalled();

      // Foreground → immediate refresh, then the poll resumes.
      listeners.forEach((l) => l("active"));
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchStates).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(5 * 60_000);
      expect(fetchStates).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const fetchStates = jest.fn().mockResolvedValue({});
    const persist = jest.fn();
    const stop = startSystemSwitchRefreshMonitor({ fetchStates, persist });
    await flush();
    fetchStates.mockClear();

    stop();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(fetchStates).not.toHaveBeenCalled();
  });
});
