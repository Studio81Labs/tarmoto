import { AppState } from "react-native";
import {
  startLanguagePreferenceSyncMonitor,
  stopLanguagePreferenceSyncMonitor,
} from "../languagePreferenceSyncMonitor";
import type { SupportedLocale } from "@tarmoto/shared";

type AppStateListener = (state: "active" | "background") => void;

describe("languagePreferenceSyncMonitor", () => {
  let listener: AppStateListener | undefined;
  let pending: SupportedLocale | null;
  let accountLocale: string | null;
  const sync = jest.fn<Promise<void>, [SupportedLocale]>();
  const onAlreadySynced = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    pending = "en";
    accountLocale = null;
    sync.mockReset().mockResolvedValue(undefined);
    onAlreadySynced.mockReset();
    listener = undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, next) => {
      listener = next as AppStateListener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    stopLanguagePreferenceSyncMonitor();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function start() {
    return startLanguagePreferenceSyncMonitor({
      isAuthenticated: () => true,
      pendingLocale: () => pending,
      accountLocale: () => accountLocale,
      sync,
      onAlreadySynced,
    });
  }

  it("syncs a pending local language immediately", async () => {
    start();
    await jest.runAllTimersAsync();

    expect(sync).toHaveBeenCalledWith("en");
  });

  it("clears a marker whose language already reached the account", async () => {
    accountLocale = "en";
    start();
    await jest.runAllTimersAsync();

    expect(sync).not.toHaveBeenCalled();
    expect(onAlreadySynced).toHaveBeenCalledWith("en");
  });

  it("retries a transient failure with capped backoff", async () => {
    sync
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    start();
    await Promise.resolve();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("rechecks the marker whenever the app becomes active", async () => {
    pending = null;
    start();
    await Promise.resolve();
    pending = "en";

    listener?.("active");
    await Promise.resolve();

    expect(sync).toHaveBeenCalledWith("en");
  });
});
