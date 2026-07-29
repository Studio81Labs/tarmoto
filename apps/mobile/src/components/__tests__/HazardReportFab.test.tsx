/**
 * HazardReportFab — covers the two interactions and the long-press
 * tap-suppression guard that prevents an accidental no-arg navigation
 * after the rider releases a long-press.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import HazardReportFab from "../HazardReportFab";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = () => ReactLib.createElement(Text, null, "icon");
  return { Icon: MockIcon };
});

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

describe("HazardReportFab", () => {
  beforeEach(() => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
  });
  it("opens the report screen with no preselected type on tap", async () => {
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    await fireEvent.press(screen.getByLabelText("Report hazard"));

    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });

  it("preselects the hazard type from the long-press quick-pick", async () => {
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    await fireEvent(screen.getByLabelText("Report hazard"), "longPress");

    await fireEvent.press(screen.getByLabelText("Report Ice"));

    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith("ice");
  });

  it("suppresses the tap that fires on release after a long-press", async () => {
    // RN's gesture system can fire `onPress` on release after a
    // long-press has already opened the menu. Without the guard, the
    // rider would land on the form with no preselected type while the
    // quick-pick is still on screen.
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    await fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    await fireEvent.press(screen.getByLabelText("Report hazard"));

    expect(onOpenReport).not.toHaveBeenCalled();

    // The next tap (a fresh interaction) goes through normally.
    await fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });

  it("does not swallow the next tap after a long-press → quick-pick select cycle", async () => {
    // Pressability mostly DOESN'T fire the trailing onPress on release,
    // so the suppression flag would stick at true and silently swallow
    // the next legitimate tap if it weren't reset on menu-close paths.
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    await fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    await fireEvent.press(screen.getByLabelText("Report Pothole"));
    expect(onOpenReport).toHaveBeenLastCalledWith("pothole");

    // Fresh tap on the FAB after the menu closed via tile select must
    // still navigate (with no preselect). If the ref weren't reset on
    // close, this call would be silently swallowed.
    await fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(2);
    expect(onOpenReport).toHaveBeenLastCalledWith();
  });

  it("does not swallow the next tap after a long-press → backdrop dismiss cycle", async () => {
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    await fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    await fireEvent.press(screen.getByLabelText("Close hazard quick-pick"));

    // Fresh tap on the FAB after backdrop dismiss must still navigate.
    await fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });

  it("renders no affordance when hazard_reporting is operator-disabled", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    const onOpenReport = jest.fn();
    await render(<HazardReportFab onOpenReport={onOpenReport} />);

    // No FAB to tap — the only tap/long-press entry is gone.
    expect(screen.queryByLabelText("Report hazard")).toBeNull();
  });
});
