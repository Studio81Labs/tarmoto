import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  FEATURE_LIMIT_EXCEEDED,
  FREE_TOGGLE_FEATURE_KEYS,
  LIMIT_FEATURE_KEYS,
  SYSTEM_FEATURE_KEYS,
  TOGGLE_FEATURE_KEYS,
  buildFeatureSnapshot,
  buildLimitSnapshot,
  buildSystemSwitchSnapshot,
  getFeatureLimit,
  isFeatureEnabled,
  isFeatureKey,
  isGlobalFeatureState,
  isLimitFeatureKey,
  isSystemFeatureKey,
  isToggleFeatureKey,
  isWithinLimit,
  resolveFeature,
  resolveFeatureKillSwitch,
  resolveLimit,
  resolveSystemSwitch,
  upgradeTierForFeature,
  upgradeTierForLimit,
} from "./feature-flags";
import { SUBSCRIPTION_TIERS } from "./constants";

describe("registry", () => {
  it("every definition's tier allowlist uses known tiers only", () => {
    for (const key of TOGGLE_FEATURE_KEYS) {
      for (const tier of FEATURE_DEFINITIONS[key].tiers) {
        expect(SUBSCRIPTION_TIERS).toContain(tier);
      }
    }
  });

  it("free-tier grants are also granted to every paid tier (no downgrade holes)", () => {
    for (const key of TOGGLE_FEATURE_KEYS) {
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

describe("kind-split registry", () => {
  it("partitions FEATURE_KEYS exactly into toggle + limit + system keys", () => {
    expect(
      [
        ...TOGGLE_FEATURE_KEYS,
        ...LIMIT_FEATURE_KEYS,
        ...SYSTEM_FEATURE_KEYS,
      ].sort(),
    ).toEqual([...FEATURE_KEYS].sort());
    for (const key of TOGGLE_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("toggle");
    }
    for (const key of LIMIT_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("limit");
    }
    for (const key of SYSTEM_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("system");
    }
  });

  it("defines max_active_trips as a limit (free=1, pro/premium unlimited)", () => {
    expect(FEATURE_DEFINITIONS.max_active_trips).toEqual({
      kind: "limit",
      description: "Maximum open (draft/planned/active) trips a user may own.",
      default: 1,
      tiers: { free: 1, pro: null, premium: null },
    });
  });

  it("limit values are monotone non-decreasing across the tier ladder", () => {
    const rank = (v: number | null) => (v === null ? Infinity : v);
    for (const key of LIMIT_FEATURE_KEYS) {
      const { tiers } = FEATURE_DEFINITIONS[key];
      expect(rank(tiers.free)).toBeLessThanOrEqual(rank(tiers.pro));
      expect(rank(tiers.pro)).toBeLessThanOrEqual(rank(tiers.premium));
    }
  });

  it("key guards discriminate by kind", () => {
    expect(isToggleFeatureKey("gpx_export")).toBe(true);
    expect(isToggleFeatureKey("max_active_trips")).toBe(false);
    expect(isLimitFeatureKey("max_active_trips")).toBe(true);
    expect(isLimitFeatureKey("gpx_export")).toBe(false);
    expect(isFeatureKey("max_active_trips")).toBe(true);
    expect(isLimitFeatureKey("nope")).toBe(false);
  });
});

describe("system switches", () => {
  it("has 14 system keys, all kind:system + default:true, disjoint from toggle/limit", () => {
    expect(SYSTEM_FEATURE_KEYS.length).toBe(14);
    for (const key of SYSTEM_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("system");
      expect(FEATURE_DEFINITIONS[key].default).toBe(true);
    }
    const toggleLimit = new Set([
      ...TOGGLE_FEATURE_KEYS,
      ...LIMIT_FEATURE_KEYS,
    ]);
    for (const key of SYSTEM_FEATURE_KEYS) {
      expect(toggleLimit.has(key as never)).toBe(false);
    }
  });

  it("resolveSystemSwitch is on by default and off only on force_off", () => {
    expect(resolveSystemSwitch("sys_weather_provider", undefined)).toBe(true);
    expect(resolveSystemSwitch("sys_weather_provider", "force_on")).toBe(true);
    expect(resolveSystemSwitch("sys_weather_provider", "force_off")).toBe(
      false,
    );
  });

  it("buildSystemSwitchSnapshot resolves every key; absent = on; ignores stale keys", () => {
    const snap = buildSystemSwitchSnapshot({
      sys_weather_provider: "force_off",
    });
    expect(Object.keys(snap).sort()).toEqual([...SYSTEM_FEATURE_KEYS].sort());
    expect(snap.sys_weather_provider).toBe(false);
    expect(snap.sys_mapillary_previews).toBe(true); // absent → default on
    expect(snap).not.toHaveProperty("ghost_switch");
  });

  it("isSystemFeatureKey discriminates by kind", () => {
    expect(isSystemFeatureKey("sys_weather_provider")).toBe(true);
    expect(isSystemFeatureKey("gpx_export")).toBe(false);
    expect(isSystemFeatureKey("max_active_trips")).toBe(false);
    expect(isSystemFeatureKey("nope")).toBe(false);
  });
});

describe("free-tier kill switches", () => {
  it("FREE_TOGGLE_FEATURE_KEYS = exactly the toggles granted to the free tier", () => {
    // Kill switches are the free-for-everyone toggles; a paid toggle
    // (gpx_export, group_rides) must NOT appear (it gates fail-closed).
    const expected = TOGGLE_FEATURE_KEYS.filter((key) =>
      (FEATURE_DEFINITIONS[key].tiers as readonly string[]).includes("free"),
    );
    expect([...FREE_TOGGLE_FEATURE_KEYS].sort()).toEqual([...expected].sort());
    expect(FREE_TOGGLE_FEATURE_KEYS).toContain("crash_detection");
    expect(FREE_TOGGLE_FEATURE_KEYS).not.toContain("gpx_export");
    expect(FREE_TOGGLE_FEATURE_KEYS).not.toContain("group_rides");
  });

  it("resolveFeatureKillSwitch is on by default and off only on force_off", () => {
    expect(resolveFeatureKillSwitch("crash_detection", undefined)).toBe(true);
    expect(resolveFeatureKillSwitch("crash_detection", "force_on")).toBe(true);
    expect(resolveFeatureKillSwitch("crash_detection", "force_off")).toBe(
      false,
    );
  });
});

describe("resolveFeature precedence", () => {
  it("falls back to the registry default with no tier, override, or state", () => {
    for (const key of TOGGLE_FEATURE_KEYS) {
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
    expect(Object.keys(snapshot).sort()).toEqual(
      [...TOGGLE_FEATURE_KEYS].sort(),
    );
    expect(snapshot.gpx_export).toBe(true);
    expect(snapshot.group_rides).toBe(false);
  });

  it("resolves the full ladder per tier", () => {
    const free = buildFeatureSnapshot("free", {}, {});
    const pro = buildFeatureSnapshot("pro", {}, {});
    const premium = buildFeatureSnapshot("premium", {}, {});
    // free gets the free-tier line items only
    expect(free.basic_navigation).toBe(true);
    expect(free.road_quality_full_zoom).toBe(false);
    expect(free.group_rides).toBe(false);
    // pro adds the mid-tier line items
    expect(pro.basic_navigation).toBe(true);
    expect(pro.road_quality_full_zoom).toBe(true);
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
    expect(Object.keys(snapshot).sort()).toEqual(
      [...TOGGLE_FEATURE_KEYS].sort(),
    );
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

describe("resolveLimit precedence", () => {
  it("uses the tier value; registry default for unknown tiers", () => {
    expect(resolveLimit("max_active_trips", "free", undefined, undefined)).toBe(
      1,
    );
    expect(
      resolveLimit("max_active_trips", "pro", undefined, undefined),
    ).toBeNull();
    expect(
      resolveLimit("max_active_trips", "premium", undefined, undefined),
    ).toBeNull();
    expect(resolveLimit("max_active_trips", null, undefined, undefined)).toBe(
      1,
    );
    expect(
      resolveLimit("max_active_trips", "hacked", undefined, undefined),
    ).toBe(1);
  });

  it("per-user override replaces the tier value in both directions", () => {
    expect(resolveLimit("max_active_trips", "free", 10, undefined)).toBe(10);
    expect(resolveLimit("max_active_trips", "pro", 0, undefined)).toBe(0);
    expect(
      resolveLimit("max_active_trips", "free", null, undefined),
    ).toBeNull();
  });

  it("global override replaces the tier layer for users without an override", () => {
    expect(
      resolveLimit("max_active_trips", "free", undefined, null),
    ).toBeNull();
    expect(resolveLimit("max_active_trips", "pro", undefined, 3)).toBe(3);
  });

  it("an explicit per-user restriction survives a global raise (min wins)", () => {
    // launch mode (global null = unlimited) must not disarm "this spammer gets 0"
    expect(resolveLimit("max_active_trips", "free", 0, null)).toBe(0);
  });

  it("a global clamp beats a support-raised user (min wins)", () => {
    expect(resolveLimit("max_active_trips", "free", 10, 3)).toBe(3);
    expect(resolveLimit("max_active_trips", "free", null, 3)).toBe(3);
  });
});

describe("buildLimitSnapshot", () => {
  it("resolves every limit key", () => {
    const snapshot = buildLimitSnapshot("free", {}, {});
    expect(Object.keys(snapshot).sort()).toEqual(
      [...LIMIT_FEATURE_KEYS].sort(),
    );
    expect(snapshot.max_active_trips).toBe(1);
  });

  it("ignores unknown keys in override maps (stale rows never widen the set)", () => {
    const snapshot = buildLimitSnapshot(
      "free",
      { ghost_limit: null },
      { other_ghost: null },
    );
    // The snapshot carries exactly the registry limit keys — the stale
    // override/state keys never widen it.
    expect(Object.keys(snapshot).sort()).toEqual(
      [...LIMIT_FEATURE_KEYS].sort(),
    );
    expect(snapshot).not.toHaveProperty("ghost_limit");
    expect(snapshot).not.toHaveProperty("other_ghost");
    expect(snapshot.max_active_trips).toBe(1);
  });

  it("combines all layers", () => {
    expect(
      buildLimitSnapshot(
        "free",
        { max_active_trips: 5 },
        { max_active_trips: 2 },
      ).max_active_trips,
    ).toBe(2);
  });
});

describe("getFeatureLimit", () => {
  it("reads a present value including null (unlimited)", () => {
    expect(getFeatureLimit({ max_active_trips: 4 }, "max_active_trips")).toBe(
      4,
    );
    expect(
      getFeatureLimit({ max_active_trips: null }, "max_active_trips"),
    ).toBeNull();
  });

  it("missing keys return the most-restrictive fallback, never unlimited", () => {
    expect(getFeatureLimit({}, "max_active_trips")).toBe(0);
    expect(getFeatureLimit({}, "max_active_trips", 1)).toBe(1);
  });

  it("prototype-collision keys fall back", () => {
    expect(getFeatureLimit({}, "toString")).toBe(0);
    expect(getFeatureLimit({}, "constructor")).toBe(0);
  });
});

describe("isWithinLimit", () => {
  it("null is always within (unlimited)", () => {
    expect(isWithinLimit(null, 10_000)).toBe(true);
  });
  it("true strictly below the limit, false at or above it", () => {
    expect(isWithinLimit(1, 0)).toBe(true);
    expect(isWithinLimit(1, 1)).toBe(false);
    expect(isWithinLimit(1, 2)).toBe(false);
    expect(isWithinLimit(0, 0)).toBe(false);
  });
});

describe("upgrade-tier derivation", () => {
  it("exposes the limit-exceeded wire code", () => {
    expect(FEATURE_LIMIT_EXCEEDED).toBe("FEATURE_LIMIT_EXCEEDED");
  });

  it("finds the lowest tier ABOVE the current one that grants a toggle", () => {
    // free rider missing the toggle → the granting tier above them
    expect(upgradeTierForFeature("offline_maps", "free")).toBe("pro"); // pro-and-up
    expect(upgradeTierForFeature("group_rides", "free")).toBe("premium"); // premium-only
    // pro rider still lacking a premium-only toggle → premium
    expect(upgradeTierForFeature("group_rides", "pro")).toBe("premium");
  });

  it("returns null when the current tier already grants the toggle (off by override, not tier)", () => {
    // free already grants an all-tiers toggle → no dead-end "Upgrade to Free"
    expect(upgradeTierForFeature("basic_navigation", "free")).toBeNull();
    // pro grants a pro-and-up toggle → a force_off/revoke, not tier; no upgrade helps
    expect(upgradeTierForFeature("offline_maps", "pro")).toBeNull();
    // premium grants a premium-only toggle → no higher tier to offer
    expect(upgradeTierForFeature("group_rides", "premium")).toBeNull();
  });

  it("finds the lowest tier that raises a numeric limit (no override binding)", () => {
    // max_active_trips: free=1, pro=null (unlimited), premium=null.
    // resolvedLimit === the tier default → no override, upgrade is meaningful.
    expect(upgradeTierForLimit("max_active_trips", "free", 1)).toBe("pro");
    // already unlimited on pro → nothing more generous
    expect(upgradeTierForLimit("max_active_trips", "pro", null)).toBeNull();
    // max_trip_collaborators: free=0, pro=5, premium=null
    expect(upgradeTierForLimit("max_trip_collaborators", "free", 0)).toBe(
      "pro",
    );
    expect(upgradeTierForLimit("max_trip_collaborators", "pro", 5)).toBe(
      "premium",
    );
  });

  it("returns null when an override clamps the limit below the tier default (upgrade can't lift it)", () => {
    // Pro's default is unlimited (null); a resolved cap of 1 means a per-user or
    // global override replaced it → upgrading to Premium wouldn't help.
    expect(upgradeTierForLimit("max_active_trips", "pro", 1)).toBeNull();
    // Free's default is 1; a resolved cap of 0 is an override → no dead-end CTA.
    expect(upgradeTierForLimit("max_active_trips", "free", 0)).toBeNull();
  });

  it("gates the road-quality zoom prompt: upgrade only when a higher tier lifts the cap", () => {
    // road_quality_max_zoom: free=12, pro=null, premium=null. This is the exact
    // gate QualityMap uses to decide whether to OPEN the zoom-upgrade modal (the
    // clamp still applies to everyone regardless).
    // Free rider at the tier-default cap → Pro lifts it → prompt.
    expect(upgradeTierForLimit("road_quality_max_zoom", "free", 12)).toBe(
      "pro",
    );
    // Anonymous/Free under an operator override (z5 ≠ free default 12) → no tier
    // lifts it → no dead-end prompt.
    expect(upgradeTierForLimit("road_quality_max_zoom", "free", 5)).toBeNull();
    // Pro/Premium under a finite override → already top-of-stack for the default,
    // and the override isn't tier-liftable → no prompt.
    expect(upgradeTierForLimit("road_quality_max_zoom", "pro", 8)).toBeNull();
    expect(
      upgradeTierForLimit("road_quality_max_zoom", "premium", 12),
    ).toBeNull();
  });
});
