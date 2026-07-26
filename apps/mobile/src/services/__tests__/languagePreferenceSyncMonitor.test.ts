import { AppState } from "react-native";
import {
  startLanguagePreferenceSyncMonitor,
  stopLanguagePreferenceSyncMonitor,
  type PendingLanguageSelection,
} from "../languagePreferenceSyncMonitor";

type AppStateListener = (state: "active" | "background") => void;

describe("languagePreferenceSyncMonitor", () => {
  let listener: AppStateListener | undefined;
  let pending: PendingLanguageSelection | null;
  let currentUserId: string;
  let accountLocale: string | null;
  const sync = jest.fn<Promise<void>, [PendingLanguageSelection]>();
  const onAlreadySynced = jest.fn();
  const onOwnerMismatch = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    pending = { locale: "en", ownerUserId: "rider-a" };
    currentUserId = "rider-a";
    accountLocale = null;
    sync.mockReset().mockResolvedValue(undefined);
    onAlreadySynced.mockReset();
    onOwnerMismatch.mockReset();
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
      currentUserId: () => currentUserId,
      pendingSelection: () => pending,
      accountLocale: () => accountLocale,
      sync,
      onAlreadySynced,
      onOwnerMismatch,
    });
  }

  it("syncs a pending local language immediately", async () => {
    start();
    await jest.runAllTimersAsync();

    expect(sync).toHaveBeenCalledWith({
      locale: "en",
      ownerUserId: "rider-a",
    });
  });

  it("clears a marker whose language already reached the account", async () => {
    accountLocale = "en";
    start();
    await jest.runAllTimersAsync();

    expect(sync).not.toHaveBeenCalled();
    expect(onAlreadySynced).toHaveBeenCalledWith({
      locale: "en",
      ownerUserId: "rider-a",
    });
  });

  it("discards a marker owned by a different signed-in rider", async () => {
    currentUserId = "rider-b";
    start();
    await jest.runAllTimersAsync();

    expect(sync).not.toHaveBeenCalled();
    expect(onOwnerMismatch).toHaveBeenCalledWith({
      locale: "en",
      ownerUserId: "rider-a",
    });
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

  it("does not let foreground events bypass retry backoff", async () => {
    sync
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    start();
    await Promise.resolve();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    listener?.("active");
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("coalesces foreground events that arrive before an in-flight failure", async () => {
    let rejectFirst!: (error: Error) => void;
    sync
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    start();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    listener?.("active");
    listener?.("active");
    rejectFirst(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("serializes a superseding selection across monitor restarts", async () => {
    let resolveFirst!: () => void;
    sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    start();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    pending = {
      locale: "de" as PendingLanguageSelection["locale"],
      ownerUserId: "rider-a",
    };
    start();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({
      locale: "de",
      ownerUserId: "rider-a",
    });
  });

  it("keeps multiple waiters behind each replacement write", async () => {
    let resolveFirst!: () => void;
    sync
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        pending = null;
      });
    start();
    await Promise.resolve();
    pending = {
      locale: "de" as PendingLanguageSelection["locale"],
      ownerUserId: "rider-a",
    };

    listener?.("active");
    listener?.("active");
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({
      locale: "de",
      ownerUserId: "rider-a",
    });
  });

  it("rechecks the marker whenever the app becomes active", async () => {
    pending = null;
    start();
    await Promise.resolve();
    pending = { locale: "en", ownerUserId: "rider-a" };

    listener?.("active");
    await Promise.resolve();

    expect(sync).toHaveBeenCalledWith({
      locale: "en",
      ownerUserId: "rider-a",
    });
  });
});
