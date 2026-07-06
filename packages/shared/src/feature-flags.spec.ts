import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  buildFeatureSnapshot,
  isFeatureEnabled,
  isFeatureKey,
  isGlobalFeatureState,
  resolveFeature,
} from "./feature-flags";
import { SUBSCRIPTION_TIERS } from "./constants";

describe("registry", () => {
  it("every definition's tier allowlist uses known tiers only", () => {
    for (const key of FEATURE_KEYS) {
      for (const tier of FEATURE_DEFINITIONS[key].tiers) {
        expect(SUBSCRIPTION_TIERS).toContain(tier);
      }
    }
  });

  it("free-tier grants are also granted to every paid tier (no downgrade holes)", () => {
    for (const key of FEATURE_KEYS) {
      const tiers = FEATURE_DEFINITIONS[key].tiers;
      if (tiers.includes("free")) {
        expect(tiers).toContain("pro");
        expect(tiers).toContain("premium");
      }
      // pro (mid) grants must carry into premium (top) — "everything in Pro"
      if (tiers.includes("pro")) {
        expect(tiers).toContain("premium");
      }
    }
  });
});

describe("resolveFeature precedence", () => {
  it("falls back to the registry default with no tier, override, or state", () => {
    for (const key of FEATURE_KEYS) {
      expect(resolveFeature(key, null, undefined, undefined)).toBe(
        FEATURE_DEFINITIONS[key].default,
      );
    }
  });

  it("grants via the tier allowlist", () => {
    // pro is the €29.99 mid tier
    expect(resolveFeature("gpx_export", "pro", undefined, undefined)).toBe(
      true,
    );
    expect(resolveFeature("gpx_export", "premium", undefined, undefined)).toBe(
      true,
    );
    expect(resolveFeature("gpx_export", "free", undefined, undefined)).toBe(
      false,
    );
    // group_rides is premium-only (€49.99 top tier) — pro does not grant it.
    expect(resolveFeature("group_rides", "pro", undefined, undefined)).toBe(
      false,
    );
    expect(resolveFeature("group_rides", "premium", undefined, undefined)).toBe(
      true,
    );
    // free-tier features are granted to everyone with a known tier
    expect(resolveFeature("hazard_alerts", "free", undefined, undefined)).toBe(
      true,
    );
    expect(
      resolveFeature("hazard_alerts", "premium", undefined, undefined),
    ).toBe(true);
  });

  it("treats unknown tiers as no grant (never throws)", () => {
    expect(resolveFeature("gpx_export", "vip", undefined, undefined)).toBe(
      false,
    );
    expect(resolveFeature("gpx_export", null, undefined, undefined)).toBe(
      false,
    );
  });

  it("applies a per-user override over the tier grant, in both directions", () => {
    // grant to a free user
    expect(resolveFeature("group_rides", "free", true, undefined)).toBe(true);
    // revoke from a premium user
    expect(resolveFeature("group_rides", "premium", false, undefined)).toBe(
      false,
    );
  });

  it("force_off is an absolute kill switch", () => {
    expect(resolveFeature("gpx_export", "premium", true, "force_off")).toBe(
      false,
    );
  });

  it("force_on enables for everyone except an explicit per-user force-off", () => {
    expect(resolveFeature("group_rides", "free", undefined, "force_on")).toBe(
      true,
    );
    expect(resolveFeature("group_rides", "free", false, "force_on")).toBe(
      false,
    );
  });
});

describe("buildFeatureSnapshot", () => {
  it("resolves every registry key", () => {
    const snapshot = buildFeatureSnapshot("pro", {}, {});
    expect(Object.keys(snapshot).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(snapshot.gpx_export).toBe(true);
    expect(snapshot.group_rides).toBe(false);
  });

  it("resolves the full ladder per tier", () => {
    const free = buildFeatureSnapshot("free", {}, {});
    const pro = buildFeatureSnapshot("pro", {}, {});
    const premium = buildFeatureSnapshot("premium", {}, {});
    // free gets the free-tier line items only
    expect(free.basic_navigation).toBe(true);
    expect(free.unlimited_trip_planning).toBe(false);
    expect(free.group_rides).toBe(false);
    // pro adds the mid-tier line items
    expect(pro.basic_navigation).toBe(true);
    expect(pro.unlimited_trip_planning).toBe(true);
    expect(pro.offline_maps).toBe(true);
    expect(pro.group_rides).toBe(false);
    expect(pro.advanced_analytics).toBe(false);
    // premium gets everything
    expect(Object.values(premium).every((v) => v === true)).toBe(true);
  });

  it("ignores unknown keys in override and state maps", () => {
    const snapshot = buildFeatureSnapshot(
      null,
      { stale_flag: true },
      { another_stale: "force_on" },
    );
    expect(Object.keys(snapshot).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(Object.values(snapshot).every((v) => v === false)).toBe(true);
  });

  it("combines all layers", () => {
    const snapshot = buildFeatureSnapshot(
      "free",
      { gpx_export: true },
      { group_rides: "force_on", commuter_mode: "force_off" },
    );
    expect(snapshot).toMatchObject({
      gpx_export: true, // per-user grant
      group_rides: true, // global force_on
      commuter_mode: false, // global force_off
      offline_maps: false, // free tier, no grant
      hazard_alerts: true, // free-tier grant
    });
  });
});

describe("type guards", () => {
  it("isFeatureKey accepts registry keys only", () => {
    expect(isFeatureKey("gpx_export")).toBe(true);
    expect(isFeatureKey("offline_maps")).toBe(true);
    expect(isFeatureKey("unknown")).toBe(false);
    expect(isFeatureKey(42)).toBe(false);
  });

  it("isGlobalFeatureState accepts the two override states only", () => {
    expect(isGlobalFeatureState("force_on")).toBe(true);
    expect(isGlobalFeatureState("force_off")).toBe(true);
    expect(isGlobalFeatureState("default")).toBe(false);
  });
});

describe("isFeatureEnabled", () => {
  const flags: Partial<Record<string, boolean>> = {
    group_rides: true,
    beta_ui: false,
  };

  it("returns the flag value when present", () => {
    expect(isFeatureEnabled(flags, "group_rides")).toBe(true);
    expect(isFeatureEnabled(flags, "beta_ui")).toBe(false);
  });

  it("returns the fallback (default false) for an unknown key", () => {
    expect(isFeatureEnabled(flags, "missing")).toBe(false);
    expect(isFeatureEnabled(flags, "missing", true)).toBe(true);
  });

  it("returns false (not a truthy prototype member) for prototype-collision keys", () => {
    expect(isFeatureEnabled({}, "toString")).toBe(false);
    expect(isFeatureEnabled({}, "constructor")).toBe(false);
    expect(isFeatureEnabled({}, "constructor", true)).toBe(true);
    expect(isFeatureEnabled({}, "hasOwnProperty")).toBe(false);
  });

  it("returns the own value when a prototype-named key is explicitly set", () => {
    expect(isFeatureEnabled({ toString: true }, "toString")).toBe(true);
  });
});
