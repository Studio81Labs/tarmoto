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
        capability={{ limit: "max_active_trips" }}
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
  });

  it("renders the message without a CTA when the target tier is null", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips" }}
        currentTier="premium"
        message="You're already unlimited."
      />,
    );
    expect(screen.getByText("You're already unlimited.")).toBeTruthy();
    // premium is already unlimited for max_active_trips → no upgrade target
    expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
  });
});
