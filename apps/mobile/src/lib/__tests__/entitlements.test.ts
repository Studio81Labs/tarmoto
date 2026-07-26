import type { SubscriptionTier } from "@tarmoto/shared";
import type { User } from "@/types";
import { tierLabel, withPreservedEntitlements } from "@/lib/entitlements";

// Passthrough translator: the catalog keys ARE the English labels
// (key === value), so the label is the key it resolves.
const identity = (k: string): string => k;

it("tierLabel maps each tier to its catalog label", () => {
  const cases: Record<SubscriptionTier, string> = {
    free: "Free",
    pro: "Pro",
    premium: "Premium",
  };
  for (const [tier, label] of Object.entries(cases)) {
    expect(tierLabel(tier as SubscriptionTier, identity)).toBe(label);
  }
});

it("tierLabel routes the key through the provided translator", () => {
  const t = jest.fn((k: string) => `«${k}»`);
  expect(tierLabel("pro", t)).toBe("«Pro»");
  expect(t).toHaveBeenCalledWith("Pro");
});

describe("withPreservedEntitlements", () => {
  const current = {
    id: "u1",
    subscription_tier: "free",
    features: { gpx_export: false },
    limits: { road_quality_max_zoom: 12 },
    display_name: "Old",
  } as unknown as User;

  it("keeps the current entitlement slices but takes the incoming editable fields", () => {
    const incoming = {
      id: "u1",
      // A stale profile response still carrying the pre-downgrade entitlements.
      subscription_tier: "premium",
      features: { gpx_export: true },
      limits: { road_quality_max_zoom: null },
      display_name: "New",
    } as unknown as User;

    const merged = withPreservedEntitlements(current, incoming);
    // Entitlements preserved from the store (single-writer)…
    expect(merged.subscription_tier).toBe("free");
    expect(merged.features).toEqual({ gpx_export: false });
    expect(merged.limits).toEqual({ road_quality_max_zoom: 12 });
    // …editable fields from the incoming response.
    expect((merged as { display_name?: string }).display_name).toBe("New");
  });

  it("returns the incoming profile unchanged when there is no current user", () => {
    const incoming = { id: "u1", subscription_tier: "pro" } as unknown as User;
    expect(withPreservedEntitlements(null, incoming)).toBe(incoming);
  });

  it("takes the incoming slices when the current profile lacks them (legacy cache)", () => {
    // An upgraded install's cached profile predates features/limits.
    const legacy = { id: "u1", display_name: "Old" } as unknown as User;
    const incoming = {
      id: "u1",
      subscription_tier: "pro",
      features: { gpx_export: true },
      limits: { road_quality_max_zoom: null },
      display_name: "New",
    } as unknown as User;

    const merged = withPreservedEntitlements(legacy, incoming);
    // Legacy undefined slices must NOT clobber the incoming complete snapshot.
    expect(merged.subscription_tier).toBe("pro");
    expect(merged.features).toEqual({ gpx_export: true });
    expect(merged.limits).toEqual({ road_quality_max_zoom: null });
    expect((merged as { display_name?: string }).display_name).toBe("New");
  });
});
