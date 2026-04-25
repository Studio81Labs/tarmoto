/**
 * HazardReportFab — covers the two interactions and the long-press
 * tap-suppression guard that prevents an accidental no-arg navigation
 * after the rider releases a long-press.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import HazardReportFab from "../HazardReportFab";

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactStub = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  return function MockIcon() {
    return ReactStub.createElement(Text, null, "icon");
  };
});

describe("HazardReportFab", () => {
  it("opens the report screen with no preselected type on tap", () => {
    const onOpenReport = jest.fn();
    render(<HazardReportFab onOpenReport={onOpenReport} />);

    fireEvent.press(screen.getByLabelText("Report hazard"));

    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });

  it("preselects the hazard type from the long-press quick-pick", () => {
    const onOpenReport = jest.fn();
    render(<HazardReportFab onOpenReport={onOpenReport} />);

    fireEvent(screen.getByLabelText("Report hazard"), "longPress");

    fireEvent.press(screen.getByLabelText("Report Ice"));

    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith("ice");
  });

  it("suppresses the tap that fires on release after a long-press", () => {
    // RN's gesture system can fire `onPress` on release after a
    // long-press has already opened the menu. Without the guard, the
    // rider would land on the form with no preselected type while the
    // quick-pick is still on screen.
    const onOpenReport = jest.fn();
    render(<HazardReportFab onOpenReport={onOpenReport} />);

    fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    fireEvent.press(screen.getByLabelText("Report hazard"));

    expect(onOpenReport).not.toHaveBeenCalled();

    // The next tap (a fresh interaction) goes through normally.
    fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });

  it("does not swallow the next tap after a long-press → quick-pick select cycle", () => {
    // Pressability mostly DOESN'T fire the trailing onPress on release,
    // so the suppression flag would stick at true and silently swallow
    // the next legitimate tap if it weren't reset on menu-close paths.
    const onOpenReport = jest.fn();
    render(<HazardReportFab onOpenReport={onOpenReport} />);

    fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    fireEvent.press(screen.getByLabelText("Report Pothole"));
    expect(onOpenReport).toHaveBeenLastCalledWith("pothole");

    // Fresh tap on the FAB after the menu closed via tile select must
    // still navigate (with no preselect). If the ref weren't reset on
    // close, this call would be silently swallowed.
    fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(2);
    expect(onOpenReport).toHaveBeenLastCalledWith();
  });

  it("does not swallow the next tap after a long-press → backdrop dismiss cycle", () => {
    const onOpenReport = jest.fn();
    render(<HazardReportFab onOpenReport={onOpenReport} />);

    fireEvent(screen.getByLabelText("Report hazard"), "longPress");
    fireEvent.press(screen.getByLabelText("Close hazard quick-pick"));

    // Fresh tap on the FAB after backdrop dismiss must still navigate.
    fireEvent.press(screen.getByLabelText("Report hazard"));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith();
  });
});
