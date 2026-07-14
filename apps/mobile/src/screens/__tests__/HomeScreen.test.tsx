import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import HomeScreen from "../HomeScreen";
import type { CommuteRoute } from "@/types";

const mockNavigate = jest.fn();
let mockUseCommuteResult: {
  phase: "loading" | "learning" | "ready" | "error";
  route: CommuteRoute | null;
  newHazardCount: number;
};

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("@/hooks/useCommute", () => ({
  useCommute: () => mockUseCommuteResult,
}));

const baseRoute: CommuteRoute = {
  id: "route-1",
  name: "Home → Work",
  origin: { lat: 49.2, lng: 16.6 },
  destination: { lat: 49.1, lng: 16.75 },
  distance_km: 12.5,
  avg_duration_min: 22,
  avg_quality: 4.2,
  is_primary: true,
  route_geometry: [],
  created_at: "2026-04-20T07:30:00.000Z",
};

describe("HomeScreen", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it("hides the Start commute CTA in the learning state", () => {
    mockUseCommuteResult = {
      phase: "learning",
      route: null,
      newHazardCount: 0,
    };

    render(<HomeScreen />);

    expect(screen.queryByLabelText(/^Start commute /)).toBeNull();
    // The hazard-check card stays available so the rider can still
    // open CommuteScreen and see the onboarding state.
    expect(screen.getByLabelText(/Open commute hazard check/)).toBeTruthy();
  });

  it("shows the Start commute CTA when a primary commute is saved and launches the ride on tap", () => {
    mockUseCommuteResult = {
      phase: "ready",
      route: baseRoute,
      newHazardCount: 0,
    };

    render(<HomeScreen />);

    const cta = screen.getByLabelText("Start commute to Home → Work");
    expect(cta).toBeTruthy();

    fireEvent.press(cta);

    // The CTA jumps cross-tab into RideTab → RideActive with
    // ride_type='commute'. Asserting the full nested-nav payload guards
    // against accidentally regressing to the old in-stack navigate.
    expect(mockNavigate).toHaveBeenCalledWith("RideTab", {
      screen: "RideActive",
      params: { rideType: "commute" },
    });
  });

  it("surfaces the new-hazard count badge on the hazard-check card", () => {
    mockUseCommuteResult = {
      phase: "ready",
      route: baseRoute,
      newHazardCount: 3,
    };

    render(<HomeScreen />);

    // The CTA label includes the count + plural so we assert against the
    // full accessible label rather than scraping the badge's two split
    // text nodes (which break a regex match).
    expect(
      screen.getByLabelText(
        /Open commute hazard check\..*3 new hazards since your last check\./,
      ),
    ).toBeTruthy();
  });
});
