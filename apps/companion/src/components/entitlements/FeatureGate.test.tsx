import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
  // UpgradePrompt's Checkout kill-switch gate — live, as in production.
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { FeatureGate } from "./FeatureGate";

describe("FeatureGate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("renders children when the feature is enabled", () => {
    useFeatureMock.mockReturnValue({ enabled: true, isLoading: false });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.getByText("Group rides UI")).toBeTruthy();
  });

  it("renders the upgrade prompt when locked", () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.queryByText("Group rides UI")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Upgrade to Premium/i }),
    ).toBeTruthy();
  });

  it("renders neither children nor prompt while loading", () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: true });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.queryByText("Group rides UI")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
