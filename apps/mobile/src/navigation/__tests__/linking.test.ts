/**
 * Deep-link config — cold-start safety for kill-switched screens, and the iOS
 * cold-start URL hand-off (#1189).
 *
 * A cold launch through `tarmoto://hazard/report` or `tarmoto://trips/join`
 * must NOT resolve to a nested stack whose only route is the deep-linked
 * screen: the `hazard_reporting` / `trip_planning` kill switches close those
 * screens with `goBack()`, which would have nowhere to go and strand the rider
 * on a disabled form. `initialRouteName` seeds a safe root beneath, so the
 * resolved cold-start state is `[<root>, <deep-linked screen>]`.
 *
 * (`getStateFromPath` would exercise resolution directly, but jest doesn't
 * transform `@react-navigation/*` — every other suite mocks it — so we assert
 * the config the resolver consumes instead.)
 *
 * The `getInitialURL` suite covers the killed-app path: on iOS the launch URL
 * only exists in the native `TarmotoLaunchURL` slot (scene-based apps never
 * see it in `Linking.getInitialURL()`), so the override must drain that slot
 * first and fall back to `Linking` for Android and for an empty slot.
 */

import { Linking, NativeModules, Platform } from "react-native";
import { getInitialURL, linking } from "../linking";

type StackConfig = {
  initialRouteName?: string;
  screens?: Record<string, unknown>;
};

function stack(tab: string): StackConfig {
  const screens = linking.config?.screens as
    Record<string, StackConfig> | undefined;
  const cfg = screens?.[tab];
  expect(cfg).toBeTruthy();
  return cfg as StackConfig;
}

describe("deep-link cold-start roots", () => {
  it("seeds Map beneath the hazard/report deep link so the killed screen can go back", () => {
    const mapTab = stack("MapTab");
    // A safe root is configured, distinct from the deep-linked leaf.
    expect(mapTab.initialRouteName).toBe("Map");
    expect(mapTab.screens).toHaveProperty("HazardReport");
    expect(mapTab.initialRouteName).not.toBe("HazardReport");
  });

  it("seeds TripsList beneath the trips/join deep link so the killed screen can go back", () => {
    const tripsTab = stack("TripsTab");
    expect(tripsTab.initialRouteName).toBe("TripsList");
    expect(tripsTab.screens).toHaveProperty("TripJoin");
    expect(tripsTab.initialRouteName).not.toBe("TripJoin");
  });
});

describe("getInitialURL (iOS cold-start hand-off)", () => {
  const originalOS = Platform.OS;
  const nativeModules = NativeModules as Record<string, unknown>;
  const originalLaunchURLModule = nativeModules.TarmotoLaunchURL;
  const linkingGetInitialURL = Linking.getInitialURL as jest.Mock;

  function setPlatform(os: "ios" | "android") {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: os,
    });
  }

  beforeEach(() => {
    linkingGetInitialURL.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: originalOS,
    });
    nativeModules.TarmotoLaunchURL = originalLaunchURLModule;
  });

  it("is wired into the linking config, leaving warm links on the default Linking listener", () => {
    // React Navigation consumes the override through the config object; the
    // absent `subscribe` keeps warm links on the default `Linking` event
    // subscription, which the native store feeds via RCTLinkingManager.
    expect(linking.getInitialURL).toBe(getInitialURL);
    expect(linking.subscribe).toBeUndefined();
  });

  it("returns the natively retained launch URL on a killed-app start", async () => {
    setPlatform("ios");
    const consumePendingLaunchURL = jest
      .fn()
      .mockResolvedValue("tarmoto://trips/join");
    nativeModules.TarmotoLaunchURL = { consumePendingLaunchURL };

    await expect(getInitialURL()).resolves.toBe("tarmoto://trips/join");
    expect(consumePendingLaunchURL).toHaveBeenCalledTimes(1);
    // The retained URL wins outright; the launch-options path is not consulted.
    expect(linkingGetInitialURL).not.toHaveBeenCalled();
  });

  it("drains the native slot through the consuming call instead of caching it", async () => {
    setPlatform("ios");
    // The native module is one-shot: it hands the URL out once and null after.
    // JS must go through the consuming call every time, so a container remount
    // cannot replay a stale launch URL from a JS-side cache.
    const consumePendingLaunchURL = jest
      .fn()
      .mockResolvedValueOnce("tarmoto://hazard/report")
      .mockResolvedValue(null);
    nativeModules.TarmotoLaunchURL = { consumePendingLaunchURL };

    await expect(getInitialURL()).resolves.toBe("tarmoto://hazard/report");
    await expect(getInitialURL()).resolves.toBeNull();
    expect(consumePendingLaunchURL).toHaveBeenCalledTimes(2);
  });

  it("falls back to Linking.getInitialURL when no launch URL was retained", async () => {
    setPlatform("ios");
    nativeModules.TarmotoLaunchURL = {
      consumePendingLaunchURL: jest.fn().mockResolvedValue(null),
    };
    linkingGetInitialURL.mockResolvedValue("tarmoto://commute/start");

    await expect(getInitialURL()).resolves.toBe("tarmoto://commute/start");
  });

  it("falls back to Linking.getInitialURL when the native module is absent", async () => {
    // A build without the module (or a test render) keeps the pre-#1189
    // behaviour instead of crashing the linking config.
    setPlatform("ios");
    nativeModules.TarmotoLaunchURL = undefined;
    linkingGetInitialURL.mockResolvedValue("tarmoto://trips/join");

    await expect(getInitialURL()).resolves.toBe("tarmoto://trips/join");
  });

  it("goes straight to Linking.getInitialURL on Android", async () => {
    setPlatform("android");
    const consumePendingLaunchURL = jest.fn();
    nativeModules.TarmotoLaunchURL = { consumePendingLaunchURL };
    linkingGetInitialURL.mockResolvedValue("tarmoto://hazard/report");

    await expect(getInitialURL()).resolves.toBe("tarmoto://hazard/report");
    expect(consumePendingLaunchURL).not.toHaveBeenCalled();
  });
});
