import { isFeatureEnabled, type FeatureFlagMap } from "./feature-flags";

describe("isFeatureEnabled", () => {
  const flags: FeatureFlagMap = { group_rides: true, beta_ui: false };

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
    const withOwnToString: FeatureFlagMap = { toString: true };
    expect(isFeatureEnabled(withOwnToString, "toString")).toBe(true);
  });
});
