import type { SubscriptionTier } from "@tarmoto/shared";
import { tierLabel } from "@/lib/entitlements";

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
