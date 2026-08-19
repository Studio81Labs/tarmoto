/**
 * Deep-link config — cold-start safety for kill-switched screens.
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
 */

import { linking } from "../linking";

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
