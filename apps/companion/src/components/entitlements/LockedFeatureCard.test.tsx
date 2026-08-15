import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/hooks", () => ({
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
}));

import { LockedFeatureCard } from "./LockedFeatureCard";

describe("LockedFeatureCard", () => {
  it("keeps the section header so the page shows no unexplained gap", () => {
    render(
      <LockedFeatureCard
        stamp="Elevation profile"
        title="Climb & descent"
        message="Upgrade for elevation."
        currentTier="free"
      />,
    );
    expect(screen.getByText("Elevation profile")).toBeInTheDocument();
    expect(screen.getByText("Climb & descent")).toBeInTheDocument();
  });

  it("sells the capability it is GIVEN, not the one it defaults to", () => {
    // The default is `advanced_ride_stats`, which a Pro rider already holds —
    // so a Premium-only surface passing no capability leaves the tier most
    // likely to buy with no upgrade target at all.
    render(
      <LockedFeatureCard
        stamp="Ride analytics"
        title="Advanced analytics"
        message="Premium only."
        capability={{ feature: "advanced_analytics" }}
        currentTier="pro"
      />,
    );
    expect(
      screen.getByRole("button", { name: /upgrade/i }),
    ).toBeInTheDocument();
  });

  it("shows a PRO rider no CTA under the default capability", () => {
    // The behaviour the prop exists to fix, pinned so a later refactor cannot
    // quietly restore the hardcoded capability.
    render(
      <LockedFeatureCard
        stamp="Ride analytics"
        title="Advanced analytics"
        message="Premium only."
        currentTier="pro"
      />,
    );
    expect(
      screen.queryByRole("button", { name: /upgrade/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the message without a CTA until the tier is known", () => {
    render(
      <LockedFeatureCard
        stamp="Ride analytics"
        title="Advanced analytics"
        message="Premium only."
        capability={{ feature: "advanced_analytics" }}
        currentTier={null}
      />,
    );
    expect(screen.getByText("Premium only.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upgrade/i }),
    ).not.toBeInTheDocument();
  });
});
