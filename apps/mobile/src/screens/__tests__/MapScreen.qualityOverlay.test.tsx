/**
 * Screen-level enforcement of the road-quality zoom clamp (PR #1086). The hook
 * math is covered in MapScreen.entitlement.test; this asserts the actual JSX
 * boundary — that the quality `Layer` receives the resolved cap as its
 * `maxzoom`, and that a degenerate (hidden) cap removes the source entirely so
 * the overlay can't render past the free ceiling.
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";

// Capture the props MapLibre elements receive so we can assert the Layer's
// maxzoom. `testID` = the element `id` so we can target the quality layer/source.
jest.mock("@maplibre/maplibre-react-native", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  const stub =
    (name: string) =>
    ({
      children,
      id,
      maxzoom,
    }: {
      children?: React.ReactNode;
      id?: string;
      maxzoom?: number;
    }) =>
      ReactLib.createElement(View, { testID: id ?? name, maxzoom }, children);
  return {
    Camera: stub("Camera"),
    GeoJSONSource: stub("GeoJSONSource"),
    Layer: stub("Layer"),
    Map: stub("Map"),
    UserLocation: stub("UserLocation"),
    VectorSource: stub("VectorSource"),
  };
});

import { QualityOverlaySource } from "../MapScreen.qualityOverlay";

const baseProps = {
  show: true,
  visible: true,
  regionKey: "online",
  tileUrl: "https://tiles.example/{z}/{x}/{y}",
  style: {} as never,
};

const LAYER = "tarmoto-quality-lines";
const SOURCE = "tarmoto-quality";

it("feeds the free cap (12) straight to the quality Layer maxzoom", async () => {
  await render(<QualityOverlaySource {...baseProps} maxzoom={12} />);
  expect(screen.getByTestId(SOURCE)).toBeTruthy();
  expect(screen.getByTestId(LAYER).props.maxzoom).toBe(12);
});

it("feeds the unlimited ceiling (22) to the quality Layer maxzoom", async () => {
  await render(<QualityOverlaySource {...baseProps} maxzoom={22} />);
  expect(screen.getByTestId(LAYER).props.maxzoom).toBe(22);
});

it("removes the source entirely on a degenerate (not-visible) cap", async () => {
  await render(
    <QualityOverlaySource {...baseProps} visible={false} maxzoom={10} />,
  );
  expect(screen.queryByTestId(SOURCE)).toBeNull();
  expect(screen.queryByTestId(LAYER)).toBeNull();
});

it("renders nothing when the overlay toggle is off", async () => {
  await render(
    <QualityOverlaySource {...baseProps} show={false} maxzoom={12} />,
  );
  expect(screen.queryByTestId(SOURCE)).toBeNull();
});
