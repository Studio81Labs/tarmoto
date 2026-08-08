import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { KillSwitchGate } from "./KillSwitchGate";

const killSwitchMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => killSwitchMock(key),
}));
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (s: string) => s,
}));

describe("KillSwitchGate", () => {
  it("renders children while the switch is ON", () => {
    killSwitchMock.mockReturnValue({ enabled: true, isResolved: true });
    render(
      <KillSwitchGate feature="community_access">
        <p>community</p>
      </KillSwitchGate>,
    );
    expect(screen.getByText("community")).toBeInTheDocument();
  });

  it("renders children while the flag map is UNRESOLVED — fails safe", () => {
    // The whole reason this defaults on. A kill switch that blanked the surface
    // on every page load, or on a slow network, would cause more outage than it
    // prevents.
    killSwitchMock.mockReturnValue({ enabled: true, isResolved: false });
    render(
      <KillSwitchGate feature="community_access">
        <p>community</p>
      </KillSwitchGate>,
    );
    expect(screen.getByText("community")).toBeInTheDocument();
  });

  it("hides children and explains, without an upgrade CTA, when killed", () => {
    // Deliberately not an upsell: an operator kill is not something a rider can
    // buy past, so offering a purchase would be misleading.
    killSwitchMock.mockReturnValue({ enabled: false, isResolved: true });
    render(
      <KillSwitchGate feature="community_access">
        <p>community</p>
      </KillSwitchGate>,
    );
    expect(screen.queryByText("community")).not.toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/upgrade/i)).not.toBeInTheDocument();
  });

  it("honours an explicit fallback, including rendering nothing", () => {
    killSwitchMock.mockReturnValue({ enabled: false, isResolved: true });
    const { container } = render(
      <KillSwitchGate feature="gpx_import" fallback={null}>
        <p>importer</p>
      </KillSwitchGate>,
    );
    expect(screen.queryByText("importer")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("asks about the feature it was given", () => {
    killSwitchMock.mockReturnValue({ enabled: true, isResolved: true });
    render(
      <KillSwitchGate feature="trip_planning">
        <p>planner</p>
      </KillSwitchGate>,
    );
    expect(killSwitchMock).toHaveBeenCalledWith("trip_planning");
  });
});
