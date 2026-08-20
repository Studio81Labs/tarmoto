/**
 * Deep-link configuration for the root tab navigator.
 *
 * Extracted from `RootNavigator` so it can be unit-tested against
 * `getStateFromPath` without importing the whole screen tree (MapLibre etc.).
 *
 * `initialRouteName` on the deep-linkable stacks is load-bearing: a COLD-START
 * deep link that resolves straight to a nested screen (e.g. `hazard/report` →
 * `HazardReport`) would otherwise build a stack with that screen as its ONLY
 * route, so a `goBack()` — including the ones the `hazard_reporting` /
 * `trip_planning` kill switches fire to close a disabled form — has nowhere to
 * go and strands the rider. Seeding the stack root ensures there's always a
 * safe route beneath.
 */

import { type LinkingOptions } from "@react-navigation/native";
import { Linking, NativeModules, Platform } from "react-native";
import { parseHazardTypeParam } from "@/services/hazardReportLink";
import type { RootTabParamList } from "./RootNavigator";

type TarmotoLaunchURLModule = {
  consumePendingLaunchURL: () => Promise<string | null>;
};

/**
 * Cold-start URL resolution (#1189). CarPlay makes the iOS app scene-based,
 * so a launch URL arrives at `scene(_:willConnectTo:options:)` — never in the
 * app-delegate launch options that `Linking.getInitialURL()` reads, and too
 * early to forward as a `Linking` event (the bundle is still loading, no
 * listener exists, and bridgeless posts no JS-ready notification to queue
 * against). The native `TarmotoLaunchURL` module retains that URL until React
 * Navigation asks for it here; draining is one-shot on the native side, so a
 * container remount cannot re-navigate to a stale launch URL.
 *
 * Falls back to `Linking.getInitialURL()` when the slot is empty: Android
 * (where launch intents keep working through it), and any iOS build where the
 * module is somehow absent — the pre-#1189 behaviour rather than a crash.
 *
 * Warm links don't come through here at all: React Navigation's default
 * `subscribe` listens to `Linking` events, which the native store feeds via
 * `RCTLinkingManager` once this drain has happened.
 */
export async function getInitialURL(): Promise<string | null | undefined> {
  if (Platform.OS === "ios") {
    const launchURLModule = NativeModules.TarmotoLaunchURL as
      TarmotoLaunchURLModule | undefined;
    const pendingURL = await launchURLModule?.consumePendingLaunchURL();
    if (pendingURL != null) {
      return pendingURL;
    }
  }
  return Linking.getInitialURL();
}

export const linking: LinkingOptions<RootTabParamList> = {
  prefixes: ["tarmoto://"],
  // No `subscribe` override: the default `Linking` event listener handles warm
  // links, which iOS feeds through `scene(_:openURLContexts:)` →
  // `RCTLinkingManager`.
  getInitialURL,
  config: {
    screens: {
      ProfileTab: {
        screens: {
          LinkAccount: "link-account",
        },
      },
      TripsTab: {
        // Seed the nested stack with its list root so a COLD-START
        // `tarmoto://trips/join` deep link builds `[TripsList, TripJoin]`, not a
        // lone `TripJoin`. Without this, JoinTripScreen's `trip_planning`
        // kill-switch `goBack()` (and a normal back gesture) would have nowhere
        // to go and strand the rider on the disabled form.
        initialRouteName: "TripsList",
        screens: {
          TripJoin: "trips/join",
        },
      },
      // US-17 AC #4 — Quick-launch Commute reachable from the head unit
      // list template. `CarPlayRideMirror` fires `tarmoto://commute/start`
      // when the rider taps Start Commute on the bike display; we route
      // the URL into the existing Commute screen on the Home tab so the
      // post-launch nav state is the same as if the rider tapped Commute
      // on Home. CommuteScreen handles the "no primary route saved" case
      // with its own setup CTA, so the row is always reachable without
      // us gating it from the head unit.
      HomeTab: {
        screens: {
          Commute: "commute/start",
        },
      },
      // US-17 follow-up (#343): the Google Assistant App Action declared in
      // `android/app/src/main/res/xml/shortcuts.xml` fires this URL when the
      // rider says "Hey Google, ask Tarmoto to report a pothole" on Android
      // Auto or the phone Assistant. Routing through the Map tab means the
      // tab nav state is sane after the rider dismisses the modal — same
      // footgun-avoidance choice as the in-app FAB on MapScreen.
      MapTab: {
        // Seed the nested stack with the map root so a COLD-START
        // `tarmoto://hazard/report` deep link builds `[Map, HazardReport]`.
        // Without this, HazardReportScreen's `hazard_reporting` kill-switch
        // `goBack()` would have nowhere to go and leave the disabled report
        // form on screen.
        initialRouteName: "Map",
        screens: {
          HazardReport: {
            path: "hazard/report",
            parse: {
              preselectedType: (value: string) => parseHazardTypeParam(value),
            },
          },
        },
      },
    },
  },
};
