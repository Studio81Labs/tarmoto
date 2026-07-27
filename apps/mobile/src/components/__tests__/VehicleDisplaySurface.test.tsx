import React from "react";
import { render, screen } from "@testing-library/react-native";
import VehicleDisplaySurface from "../VehicleDisplaySurface";
import { setActiveFormatContext } from "@/format";
import { useVehicleDisplayStore } from "@/stores/vehicleDisplay";

describe("VehicleDisplaySurface", () => {
  beforeEach(() => {
    useVehicleDisplayStore.setState({
      snapshot: {
        title: "Sunday Alps",
        polyline: [
          { lat: 49.5, lng: 18.1 },
          { lat: 49.6, lng: 18.2 },
        ],
        currentLocation: { lat: 49.55, lng: 18.15 },
        nextManeuver: { type: "turn-right", roadName: "B500" },
        distanceToNextM: 1609.344,
        remainingM: 12400,
        offRoute: false,
        offRouteDistanceM: 0,
        rideStats: {
          rideType: "trip",
          speedKmh: 62,
          distanceKm: 44.3,
          durationSeconds: 4020,
        },
        banner: null,
      },
    });
  });

  afterEach(() => {
    useVehicleDisplayStore.setState({ snapshot: null });
    setActiveFormatContext({
      locale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("uses the active native format seam when mounted outside FormatProvider", async () => {
    const format = setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "imperial",
    });

    await render(<VehicleDisplaySurface />);

    expect(screen.getByText(format.distanceM(1609.344))).toBeTruthy();
    expect(screen.getByText(format.speed(62))).toBeTruthy();
    expect(screen.getByText(format.distanceKm(44.3))).toBeTruthy();
    expect(screen.getByText(format.distanceM(12400))).toBeTruthy();
    expect(screen.queryByText("62 km/h")).toBeNull();
  });
});
