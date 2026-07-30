/**
 * Trip-draft cleanup monitor — cold-start + foreground drain of the persisted
 * orphaned-draft delete queue, gated on being signed in.
 */

import { AppState, type AppStateStatus } from "react-native";
import {
  startTripDraftCleanupMonitor,
  stopTripDraftCleanupMonitor,
} from "../tripDraftCleanupMonitor";

type Listener = (next: AppStateStatus) => void;

describe("tripDraftCleanupMonitor", () => {
  let listeners: Listener[];
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopTripDraftCleanupMonitor();
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
    stopTripDraftCleanupMonitor();
  });

  function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve)).then(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
  }

  it("drains on cold start when authenticated", async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    startTripDraftCleanupMonitor({ isAuthenticated: () => true, drain });
    await flush();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("does not drain when signed out", async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    startTripDraftCleanupMonitor({ isAuthenticated: () => false, drain });
    await flush();
    expect(drain).not.toHaveBeenCalled();
  });

  it("drains on every foreground transition", async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    startTripDraftCleanupMonitor({ isAuthenticated: () => true, drain });
    await flush();
    drain.mockClear();

    listeners.forEach((l) => l("background"));
    listeners.forEach((l) => l("active"));
    await flush();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("swallows drain failures so the monitor stays subscribed", async () => {
    const drain = jest.fn().mockRejectedValue(new Error("still offline"));
    startTripDraftCleanupMonitor({ isAuthenticated: () => true, drain });
    await flush();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes", async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    const stop = startTripDraftCleanupMonitor({
      isAuthenticated: () => true,
      drain,
    });
    await flush();
    drain.mockClear();
    stop();
    listeners.forEach((l) => l("active"));
    await flush();
    expect(drain).not.toHaveBeenCalled();
  });
});
