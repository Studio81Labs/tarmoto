import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SystemSwitchGate } from "./SystemSwitchGate";

const systemSwitchMock = vi.hoisted(() => vi.fn());
const killSwitchMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEntitlements", () => ({
  useSystemSwitch: (key: string) => systemSwitchMock(key),
  // Present so the cross-check below can prove this gate reads the SYSTEM
  // registry rather than the kill-switch one — the two answer different
  // questions from different override tables.
  useFeatureKillSwitch: (key: string) => killSwitchMock(key),
}));
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (s: string) => s,
}));

describe("SystemSwitchGate", () => {
  it("renders children while the switch is ON", () => {
    systemSwitchMock.mockReturnValue({ enabled: true, isResolved: true });
    render(
      <SystemSwitchGate feature="sys_poi_ratings">
        <p>reviews</p>
      </SystemSwitchGate>,
    );
    expect(screen.getByText("reviews")).toBeInTheDocument();
  });

  it("renders children while the flag map is UNRESOLVED — fails safe", () => {
    // Same reasoning as `KillSwitchGate`: blanking a subsystem on every cold
    // load, or on a slow network, causes more outage than it prevents.
    systemSwitchMock.mockReturnValue({ enabled: true, isResolved: false });
    render(
      <SystemSwitchGate feature="sys_poi_ratings">
        <p>reviews</p>
      </SystemSwitchGate>,
    );
    expect(screen.getByText("reviews")).toBeInTheDocument();
  });

  it("hides children and explains, without an upgrade CTA, when off", () => {
    // A `sys_*` switch is an operator pausing a subsystem, not a tier
    // boundary — there is nothing to buy, so offering a purchase would be a
    // lie about why the surface is gone.
    systemSwitchMock.mockReturnValue({ enabled: false, isResolved: true });
    render(
      <SystemSwitchGate feature="sys_poi_ratings">
        <p>reviews</p>
      </SystemSwitchGate>,
    );
    expect(screen.queryByText("reviews")).not.toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/upgrade/i)).not.toBeInTheDocument();
  });

  it("honours an explicit fallback, including rendering nothing", () => {
    systemSwitchMock.mockReturnValue({ enabled: false, isResolved: true });
    const { container } = render(
      <SystemSwitchGate feature="sys_gamification" fallback={null}>
        <p>badges</p>
      </SystemSwitchGate>,
    );
    expect(screen.queryByText("badges")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("asks about the feature it was given", () => {
    systemSwitchMock.mockReturnValue({ enabled: true, isResolved: true });
    render(
      <SystemSwitchGate feature="sys_gamification">
        <p>badges</p>
      </SystemSwitchGate>,
    );
    expect(systemSwitchMock).toHaveBeenCalledWith("sys_gamification");
  });

  it("reads the SYSTEM registry, not the kill-switch one", () => {
    // The mistake this component's separate key type exists to prevent. If it
    // ever resolved through `useFeatureKillSwitch`, a `sys_*` key would be
    // looked up in the wrong override table and answer the wrong question —
    // silently, and only on an operator flip.
    systemSwitchMock.mockReturnValue({ enabled: false, isResolved: true });
    killSwitchMock.mockReturnValue({ enabled: true, isResolved: true });
    render(
      <SystemSwitchGate feature="sys_poi_ratings">
        <p>reviews</p>
      </SystemSwitchGate>,
    );
    expect(killSwitchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("reviews")).not.toBeInTheDocument();
  });
});
