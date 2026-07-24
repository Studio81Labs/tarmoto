import { AppState, type AppStateStatus } from "react-native";
import {
  startDisplayPreferencesSyncMonitor,
  stopDisplayPreferencesSyncMonitor,
  type AccountDisplayPreferences,
  type DeviceDisplayPreferences,
} from "../displayPreferencesSyncMonitor";

type Listener = (next: AppStateStatus) => void;

describe("displayPreferencesSyncMonitor", () => {
  let listeners: Listener[];
  let account: AccountDisplayPreferences | null;
  let device: DeviceDisplayPreferences;
  let sync: jest.MockedFunction<
    (
      userId: string,
      patch: { format_locale?: string; timezone?: string },
    ) => Promise<void>
  >;
  let onDevicePreferencesDetected: jest.MockedFunction<
    (preferences: DeviceDisplayPreferences) => void
  >;
  let addEventListenerSpy: jest.SpiedFunction<typeof AppState.addEventListener>;

  beforeEach(() => {
    stopDisplayPreferencesSyncMonitor();
    listeners = [];
    account = {
      userId: "user-1",
      formatLocale: "en-US",
      timeZone: "UTC",
    };
    device = { formatLocale: "cs-CZ", timeZone: "Europe/Prague" };
    sync = jest.fn().mockResolvedValue(undefined);
    onDevicePreferencesDetected = jest.fn();
    addEventListenerSpy = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((event: string, listener: Listener) => {
        if (event === "change") listeners.push(listener);
        return {
          remove: () => {
            listeners = listeners.filter((item) => item !== listener);
          },
        };
      });
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    stopDisplayPreferencesSyncMonitor();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function start(isAuthenticated = true) {
    return startDisplayPreferencesSyncMonitor({
      isAuthenticated: () => isAuthenticated,
      currentDevicePreferences: () => device,
      onDevicePreferencesDetected,
      currentAccountPreferences: () => account,
      sync,
    });
  }

  it("syncs both device-derived preferences on authenticated startup", async () => {
    start();
    await flush();

    expect(sync).toHaveBeenCalledWith("user-1", {
      format_locale: "cs-CZ",
      timezone: "Europe/Prague",
    });
  });

  it("skips signed-out, unresolved, and already-matching accounts", async () => {
    start(false);
    await flush();
    expect(sync).not.toHaveBeenCalled();

    stopDisplayPreferencesSyncMonitor();
    account = null;
    start();
    await flush();
    expect(sync).not.toHaveBeenCalled();

    stopDisplayPreferencesSyncMonitor();
    account = {
      userId: "user-1",
      formatLocale: "cs-CZ",
      timeZone: "Europe/Prague",
    };
    start();
    await flush();
    expect(sync).not.toHaveBeenCalled();
  });

  it("rechecks device settings after returning to the foreground", async () => {
    account = {
      userId: "user-1",
      formatLocale: "cs-CZ",
      timeZone: "Europe/Prague",
    };
    start();
    await flush();
    expect(sync).not.toHaveBeenCalled();
    expect(onDevicePreferencesDetected).toHaveBeenLastCalledWith(device);

    device = { formatLocale: "de-DE", timeZone: "Europe/Berlin" };
    listeners.forEach((listener) => listener("active"));
    await flush();
    expect(onDevicePreferencesDetected).toHaveBeenLastCalledWith(device);
    expect(sync).toHaveBeenCalledWith("user-1", {
      format_locale: "de-DE",
      timezone: "Europe/Berlin",
    });
  });

  it("publishes foreground device changes even while signed out", async () => {
    start(false);
    await flush();
    expect(onDevicePreferencesDetected).toHaveBeenLastCalledWith(device);

    device = { formatLocale: "de-DE", timeZone: "Europe/Berlin" };
    listeners.forEach((listener) => listener("active"));
    await flush();

    expect(onDevicePreferencesDetected).toHaveBeenLastCalledWith(device);
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not duplicate an in-flight write", async () => {
    let resolveSync: (() => void) | undefined;
    sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );
    start();
    await flush();

    listeners.forEach((listener) => listener("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    resolveSync?.();
    await flush();
  });

  it("retries a failed sync on the next foreground", async () => {
    sync
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    start();
    await flush();

    listeners.forEach((listener) => listener("active"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("cleanup unsubscribes the foreground listener", async () => {
    const stop = start();
    await flush();
    sync.mockClear();

    stop();
    listeners.forEach((listener) => listener("active"));
    await flush();
    expect(sync).not.toHaveBeenCalled();
  });
});
