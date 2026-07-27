/**
 * WeatherAlertBanner — US-13.
 *
 * Focus: nothing renders for an empty list, the most severe alert wins
 * top billing, the "+N more" suffix shows up when extra alerts exist,
 * and the detail sheet is gated on `detailOpen` (parent-owned state).
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { WeatherAlertBanner } from "../WeatherAlertBanner";
import type { WeatherAlert } from "@/types";
import { setActiveFormatContext } from "@/format";
import { FormatProvider } from "@/format/FormatProvider";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

function buildAlert(overrides: Partial<WeatherAlert>): WeatherAlert {
  return {
    id: "storm-0",
    kind: "storm",
    severity: "critical",
    lat: 0,
    lng: 0,
    distance_km_from_start: 0,
    title: "Storm warning",
    message: "Severe storm ahead.",
    ...overrides,
  };
}

describe("WeatherAlertBanner", () => {
  beforeEach(() => {
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  it("renders nothing when there are no alerts", async () => {
    const { queryByRole } = await render(
      <WeatherAlertBanner
        alerts={[]}
        detailOpen={false}
        onOpenDetail={jest.fn()}
        onCloseDetail={jest.fn()}
      />,
    );
    expect(queryByRole("button")).toBeNull();
  });

  it("surfaces the highest-severity alert at the top", async () => {
    const wind = buildAlert({
      id: "wind-1",
      kind: "wind",
      severity: "warning",
      title: "High wind ahead",
      message: "75 km/h wind.",
    });
    const storm = buildAlert({
      id: "storm-2",
      kind: "storm",
      severity: "critical",
      title: "Storm warning",
      message: "Severe storm.",
    });

    await render(
      <WeatherAlertBanner
        alerts={[wind, storm]}
        detailOpen={false}
        onOpenDetail={jest.fn()}
        onCloseDetail={jest.fn()}
      />,
    );

    // Critical wins primary billing even though the warning came first
    // in the input array.
    expect(screen.getByText("Storm warning")).toBeTruthy();
    expect(screen.getByText(/Severe storm.*\+1 more/)).toBeTruthy();
  });

  it("calls onOpenDetail when tapped", async () => {
    const handleOpen = jest.fn();
    await render(
      <WeatherAlertBanner
        alerts={[buildAlert({})]}
        detailOpen={false}
        onOpenDetail={handleOpen}
        onCloseDetail={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByRole("button"));
    expect(handleOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the full list inside the detail sheet when detailOpen is true", async () => {
    const a = buildAlert({
      id: "storm-1",
      title: "Storm warning",
      message: "Severe storm.",
      distance_km_from_start: 12,
    });
    const b = buildAlert({
      id: "wind-2",
      kind: "wind",
      severity: "warning",
      title: "High wind ahead",
      message: "75 km/h wind.",
      distance_km_from_start: 28,
    });

    await render(
      <WeatherAlertBanner
        alerts={[a, b]}
        detailOpen
        onOpenDetail={jest.fn()}
        onCloseDetail={jest.fn()}
      />,
    );

    expect(screen.getByText("Weather alerts ahead")).toBeTruthy();
    expect(
      screen.getByText(
        "Severe storm at 0.00,0.00 — consider rerouting or pulling over.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "High wind near 0.00,0.00. Brace for sudden crosswinds.",
      ),
    ).toBeTruthy();
    // Distance is formatted in km when >= 1.
    expect(screen.getByText(/12 km from start/)).toBeTruthy();
  });

  it("uses imperial units consistently in alert copy and distance", async () => {
    const wind = buildAlert({
      id: "wind-imperial",
      kind: "wind",
      severity: "warning",
      wind_kmh: 75,
      distance_km_from_start: 1,
    });

    await render(
      <FormatProvider locale="en-US" timeZone="UTC" units="imperial">
        <WeatherAlertBanner
          alerts={[wind]}
          detailOpen
          onOpenDetail={jest.fn()}
          onCloseDetail={jest.fn()}
        />
      </FormatProvider>,
    );

    expect(
      screen.getAllByText(
        "High wind (46.6 mph) near 0.00,0.00. Brace for sudden crosswinds.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("0.6 mi from start")).toBeTruthy();
  });
});
