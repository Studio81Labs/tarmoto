/**
 * Foreground system-switch refresh monitor.
 *
 * Asserts the cold-start refresh, the AppState 'active' subscription, and — the
 * deliberate difference from `privacyRefreshMonitor` — that there is NO auth
 * gate: `/config/flags` is public, so a signed-out phone still refreshes so its
 * accelerometer kill switch honours the live operator state.
 */

import { AppState, type AppStateStatus } from "react-native";
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

  it("refreshes on cold start with no auth gate", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startSystemSwitchRefreshMonitor({ refresh });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on every foreground transition", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    startSystemSwitchRefreshMonitor({ refresh });
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
    startSystemSwitchRefreshMonitor({ refresh });
    await flush();
    refresh.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("inactive"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("swallows refresh failures so the monitor stays subscribed", async () => {
    const refresh = jest.fn().mockRejectedValue(new Error("network down"));
    startSystemSwitchRefreshMonitor({ refresh });
    await flush();
    // A transient failure must not tear down the listener.
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the AppState listener", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stop = startSystemSwitchRefreshMonitor({ refresh });
    await flush();
    refresh.mockClear();

    stop();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
