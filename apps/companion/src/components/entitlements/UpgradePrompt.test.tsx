import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { UpgradePrompt } from "./UpgradePrompt";

describe("UpgradePrompt", () => {
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
});
