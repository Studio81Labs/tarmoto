import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

// Defaults reproduce the steady state: Checkout live, and the free rider most
// of these cases describe. `sys_billing_checkout` is exercised on its own
// below; the routing hook has its own suite in `hooks/useUpgradeRouting`.
const { billing } = vi.hoisted(() => ({
  billing: { checkoutEnabled: true, needsCheckout: true },
}));
vi.mock("@/hooks", () => ({
  useSystemSwitch: () => ({
    enabled: billing.checkoutEnabled,
    isResolved: true,
  }),
  useUpgradeRouting: () => ({
    needsCheckout: billing.needsCheckout,
    isResolved: true,
  }),
}));

import { UpgradePrompt } from "./UpgradePrompt";

describe("UpgradePrompt", () => {
  beforeEach(() => {
    billing.checkoutEnabled = true;
    billing.needsCheckout = true;
  });

  it("derives the target tier for a limit and renders the CTA + message", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
        currentTier="free"
        message="You've hit your limit."
      />,
    );
    expect(screen.getByText("You've hit your limit.")).toBeTruthy();
    // max_active_trips free→pro
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeTruthy();
  });

  it("renders a modal dialog with a dismiss control", () => {
    render(
      <UpgradePrompt
        variant="modal"
        capability={{ feature: "group_rides" }}
        currentTier="free"
        message="Group rides need Premium."
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // group_rides is premium-only
    expect(
      screen.getByRole("button", { name: /Upgrade to Premium/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Upgrade required" }),
    ).toBeTruthy();
  });

  it("titles the modal neutrally (no upgrade framing) when there is no target tier", () => {
    // Pro clamped to 1 by an override → no higher tier lifts it. The modal must
    // not say "Upgrade required" or offer a billing CTA that can't help.
    render(
      <UpgradePrompt
        variant="modal"
        capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
        currentTier="pro"
        message="You've reached your trip limit on the Pro plan."
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Limit reached" })).toBeTruthy();
    expect(screen.queryByText("Upgrade required")).toBeNull();
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
    // Dismiss is still available.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("suppresses the CTA and titles neutrally when suppressUpgrade is set (owner-scoped cap)", () => {
    // A Free editor would normally get an Upgrade CTA, but the cap belongs to
    // the trip OWNER — upgrading the editor's plan can't lift it.
    render(
      <UpgradePrompt
        variant="modal"
        capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
        currentTier="free"
        message="The trip owner has reached their trip limit."
        suppressUpgrade
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Limit reached" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
  });

  it("renders the message without a CTA when the target tier is null", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips", resolvedLimit: null }}
        currentTier="premium"
        message="You're already unlimited."
      />,
    );
    expect(screen.getByText("You're already unlimited.")).toBeTruthy();
    // premium is already unlimited for max_active_trips → no upgrade target
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
  });

  it("shows no CTA when an override clamps the limit below the tier default", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
        currentTier="pro"
        message="You've reached your trip limit."
      />,
    );
    expect(screen.getByText("You've reached your trip limit.")).toBeTruthy();
    // Pro's default is unlimited; a resolved cap of 1 is an override, not tier —
    // upgrading to Premium wouldn't lift it, so no dead-end CTA.
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
  });

  it("shows no CTA when the current tier already grants a toggle that resolved off (override, not tier)", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ feature: "offline_maps" }}
        currentTier="pro"
        message="Offline maps are unavailable right now."
      />,
    );
    expect(
      screen.getByText("Offline maps are unavailable right now."),
    ).toBeTruthy();
    // offline_maps is granted on pro → a force_off/revoke, not a tier gap;
    // upgrading can't restore it, so no dead-end "Upgrade to Pro" CTA.
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
  });

  describe("sys_billing_checkout", () => {
    it("drops the inline CTA when Checkout is killed and this rider needs it", () => {
      billing.checkoutEnabled = false;
      render(
        <UpgradePrompt
          variant="inline"
          capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
          currentTier="free"
          message="You've hit your limit."
        />,
      );
      // The billing page can't start a subscription, so the CTA would land the
      // rider somewhere nothing can proceed. The limit still gets explained.
      expect(screen.getByText("You've hit your limit.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
    });

    it("drops the modal CTA and titles it neutrally when Checkout is killed", () => {
      billing.checkoutEnabled = false;
      render(
        <UpgradePrompt
          variant="modal"
          capability={{ feature: "group_rides" }}
          currentTier="free"
          message="Group rides need Premium."
          onClose={() => {}}
        />,
      );
      // An operator kill isn't something a rider can buy past, so no upgrade
      // framing — this reuses the existing no-target neutral state.
      expect(
        screen.getByRole("heading", { name: "Limit reached" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    });

    it("keeps the CTA for a rider whose upgrade routes through the portal", () => {
      billing.checkoutEnabled = false;
      billing.needsCheckout = false;
      render(
        <UpgradePrompt
          variant="modal"
          capability={{ feature: "group_rides" }}
          currentTier="pro"
          message="Group rides need Premium."
          onClose={() => {}}
        />,
      );
      // The switch kills Checkout only — a Pro rider changes plan through
      // `subscription_update` on the portal, which stays open. Blanking their
      // CTA would strand them for a failure that isn't on their path.
      expect(
        screen.getByRole("button", { name: /Upgrade to Premium/i }),
      ).toBeTruthy();
    });

    it("keeps the CTA while the switch is unresolved (fails safe)", () => {
      // `useSystemSwitch` reports enabled until a `force_off` is CONFIRMED, so
      // a slow or failed `/config/flags` must never blank a working upsell.
      billing.checkoutEnabled = true;
      render(
        <UpgradePrompt
          variant="inline"
          capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
          currentTier="free"
          message="You've hit your limit."
        />,
      );
      expect(
        screen.getByRole("button", { name: /Upgrade to Pro/i }),
      ).toBeTruthy();
    });

    it("drops the CTA on a live flip, without a remount", () => {
      // A fresh element each time — React bails out of re-rendering a subtree
      // whose element is referentially identical, which would hide the flip.
      const prompt = () => (
        <UpgradePrompt
          variant="inline"
          capability={{ limit: "max_active_trips", resolvedLimit: 1 }}
          currentTier="free"
          message="You've hit your limit."
        />
      );
      const { rerender } = render(prompt());
      expect(
        screen.getByRole("button", { name: /Upgrade to Pro/i }),
      ).toBeTruthy();
      // The operator flips the switch mid-session; the poll lands it on the
      // next render rather than waiting for the prompt to be remounted.
      billing.checkoutEnabled = false;
      rerender(prompt());
      expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
    });
  });
});
