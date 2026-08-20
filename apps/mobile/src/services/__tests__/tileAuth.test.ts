/**
 * The live map's scoped tile credential (#1279).
 *
 * `@maplibre/maplibre-react-native` is mocked because the real module reaches
 * for the native transform bridge on import; the assertions here are about
 * WHAT we hand that bridge — a URL-scoped search parameter under a stable id,
 * never a global header, and never the account bearer.
 */

jest.mock("@maplibre/maplibre-react-native", () => ({
  TransformRequestManager: {
    addUrlSearchParam: jest.fn(() => "tarmoto-tile-token"),
    removeUrlSearchParam: jest.fn(),
  },
}));

import { AppState } from "react-native";
import { TransformRequestManager } from "@maplibre/maplibre-react-native";
import { tileTokenRotationMs } from "@tarmoto/shared";
import {
  applyTileToken,
  getTileCredentialPresence,
  startTileTokenMonitor,
  stopTileTokenMonitor,
  subscribeTileCredentialPresence,
} from "../tileAuth";

const transformRequestManager = TransformRequestManager as unknown as {
  addUrlSearchParam: jest.Mock;
  removeUrlSearchParam: jest.Mock;
};
const appStateListeners: Array<(next: string) => void> = [];
const removeListener = jest.fn();

jest
  .spyOn(AppState, "addEventListener")
  .mockImplementation((_event, handler) => {
    appStateListeners.push(handler as (next: string) => void);
    return { remove: removeListener } as ReturnType<
      typeof AppState.addEventListener
    >;
  });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("applyTileToken", () => {
  beforeEach(() => {
    transformRequestManager.addUrlSearchParam.mockClear();
    transformRequestManager.removeUrlSearchParam.mockClear();
  });

  it("registers a URL-SCOPED search param, not a global header", () => {
    // A global header would travel to the OpenFreeMap basemap host, which the
    // issue's acceptance forbids outright.
    applyTileToken("tok-1", 900, "https://api.tarmoto.app");

    expect(transformRequestManager.addUrlSearchParam).toHaveBeenCalledWith({
      id: "tarmoto-tile-token",
      match: "^https://api\\.tarmoto\\.app/api/v1/roads/tiles/",
      name: "tile_token",
      value: "tok-1",
    });
  });

  it("reuses one id so rotation updates in place", () => {
    // Re-adding the same id replaces the value instead of stacking a second
    // transform — and leaves the source's URL template untouched, so MapLibre
    // keeps its tile cache across a rotation.
    applyTileToken("tok-1", 900, "https://api.tarmoto.app");
    applyTileToken("tok-2", 900, "https://api.tarmoto.app");

    const ids = transformRequestManager.addUrlSearchParam.mock.calls.map(
      (c) => (c[0] as { id: string }).id,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("withdraws the param entirely for a null token", () => {
    applyTileToken(null);

    expect(transformRequestManager.removeUrlSearchParam).toHaveBeenCalledWith(
      "tarmoto-tile-token",
    );
    expect(transformRequestManager.addUrlSearchParam).not.toHaveBeenCalled();
  });
});

describe("startTileTokenMonitor", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    appStateListeners.length = 0;
    removeListener.mockClear();
    transformRequestManager.addUrlSearchParam.mockClear();
    transformRequestManager.removeUrlSearchParam.mockClear();
  });

  afterEach(() => {
    stopTileTokenMonitor();
    jest.useRealTimers();
  });

  it("mints and publishes a credential for a signed-in rider", async () => {
    const mint = jest
      .fn()
      .mockResolvedValue({ token: "tok-1", expires_in: 900 });

    startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();

    expect(mint).toHaveBeenCalledTimes(1);
    expect(transformRequestManager.addUrlSearchParam).toHaveBeenCalledWith(
      expect.objectContaining({ value: "tok-1" }),
    );
  });

  it("never mints for a signed-out install", async () => {
    const mint = jest.fn();

    startTileTokenMonitor({ isAuthenticated: () => false, mint });
    await flush();

    expect(mint).not.toHaveBeenCalled();
    expect(transformRequestManager.removeUrlSearchParam).toHaveBeenCalled();
  });

  it("rotates before the credential expires", async () => {
    const mint = jest
      .fn()
      .mockResolvedValue({ token: "tok-1", expires_in: 900 });

    startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(tileTokenRotationMs(900));
    await flush();

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("keeps an unexpired credential when a mint fails, and retries", async () => {
    // A rider in a tunnel must not silently drop to the free zoom cap.
    const mint = jest
      .fn()
      .mockResolvedValueOnce({ token: "tok-1", expires_in: 900 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ token: "tok-2", expires_in: 900 });

    startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();
    // `start` withdraws any stale credential before minting; ignore that one.
    transformRequestManager.removeUrlSearchParam.mockClear();

    jest.advanceTimersByTime(tileTokenRotationMs(900));
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
    // The failed rotation left the working credential in place.
    expect(transformRequestManager.removeUrlSearchParam).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000);
    await flush();
    expect(mint).toHaveBeenCalledTimes(3);
    expect(transformRequestManager.addUrlSearchParam).toHaveBeenCalledWith(
      expect.objectContaining({ value: "tok-2" }),
    );
  });

  it("withdraws the credential when the monitor stops", async () => {
    // Sign-out: the transform lives in the native stack and outlives the React
    // tree, so a second rider on the same install must not inherit it.
    const mint = jest
      .fn()
      .mockResolvedValue({ token: "tok-1", expires_in: 900 });

    const stop = startTileTokenMonitor({
      isAuthenticated: () => true,
      mint,
    });
    await flush();

    stop();

    expect(transformRequestManager.removeUrlSearchParam).toHaveBeenCalledWith(
      "tarmoto-tile-token",
    );
    expect(removeListener).toHaveBeenCalled();
  });

  it("ignores a mint that lands after the monitor stopped", async () => {
    // Sign-out (or a second rider signing in) while a mint is in flight: the
    // promise cannot be cancelled, so without a generation check its
    // completion would re-install the PREVIOUS session's token and serve tiles
    // under someone else's entitlement for a full token lifetime.
    let resolveMint: (v: { token: string; expires_in: number }) => void = () =>
      undefined;
    const mint = jest.fn(
      () =>
        new Promise<{ token: string; expires_in: number }>((resolve) => {
          resolveMint = resolve;
        }),
    );

    const stop = startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    stop();
    transformRequestManager.addUrlSearchParam.mockClear();

    resolveMint({ token: "tok-stale", expires_in: 900 });
    await flush();

    expect(transformRequestManager.addUrlSearchParam).not.toHaveBeenCalled();
    expect(getTileCredentialPresence()).toBe(false);
  });

  it("publishes credential presence so screens can remount their source", async () => {
    // MapLibre caches tiles by coordinates, and the native URL transform does
    // not change the source's URL or cache key — so a source that fetched
    // z13+ tiles before the mint landed needs a remount, not just a new param.
    const listener = jest.fn();
    const unsubscribe = subscribeTileCredentialPresence(listener);
    const mint = jest
      .fn()
      .mockResolvedValue({ token: "tok-1", expires_in: 900 });

    expect(getTileCredentialPresence()).toBe(false);
    startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();

    expect(getTileCredentialPresence()).toBe(true);
    expect(listener).toHaveBeenCalled();

    stopTileTokenMonitor();
    expect(getTileCredentialPresence()).toBe(false);
    unsubscribe();
  });

  it("re-mints on foreground only when a rotation is actually due", async () => {
    const mint = jest
      .fn()
      .mockResolvedValue({ token: "tok-1", expires_in: 900 });

    startTileTokenMonitor({ isAuthenticated: () => true, mint });
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // Tabbing in and out must not mint on every transition.
    appStateListeners.forEach((l) => l("active"));
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // Background timers are unreliable, so a foreground past the rotation
    // deadline has to catch up on its own.
    jest.setSystemTime(Date.now() + tileTokenRotationMs(900) + 1000);
    appStateListeners.forEach((l) => l("active"));
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
