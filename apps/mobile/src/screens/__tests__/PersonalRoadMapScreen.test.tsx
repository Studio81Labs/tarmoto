/**
 * PersonalRoadMapScreen — US-30 stats card + nearby unridden list +
 * map style helper.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import PersonalRoadMapScreen, { __test } from "../PersonalRoadMapScreen";
import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

// Captures the props each MapLibre element is handed, so the tile URL and
// source-layer this screen asks for are assertable (#1279).
const mockMapLibreProps: {
  VectorSource: Record<string, unknown>[];
  Layer: Record<string, unknown>[];
} = {
  VectorSource: [],
  Layer: [],
};

jest.mock("@maplibre/maplibre-react-native", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  const stub = (name: string) =>
    function Stub({
      children,
      ...props
    }: {
      children?: React.ReactNode;
    } & Record<string, unknown>) {
      if (name === "VectorSource" || name === "Layer") {
        mockMapLibreProps[name].push(props);
      }
      return ReactLib.createElement(View, { testID: name }, children);
    };
  return {
    Map: stub("Map"),
    Camera: stub("Camera"),
    UserLocation: stub("UserLocation"),
    VectorSource: stub("VectorSource"),
    Layer: stub("Layer"),
  };
});

jest.mock("@/services/api", () => ({
  api: {
    getExplorationStats: jest.fn(),
    getRiddenSegments: jest.fn(),
    getNearbyUnriddenSegments: jest.fn(),
  },
}));

jest.mock("@/services/location", () => ({
  locationService: {
    getCurrentLocation: jest.fn().mockResolvedValue({
      lat: 49.2,
      lng: 16.6,
      speed: 0,
      accuracy: 5,
      altitude: 0,
      timestamp: Date.now(),
    }),
  },
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

const mockedApi = api as jest.Mocked<typeof api>;

describe("PersonalRoadMapScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    mockedApi.getExplorationStats.mockResolvedValue({
      ridden_segments: 100,
      total_segments: 800,
      percent_explored: 12.5,
      total_distance_km: 1234.5,
    });
    mockedApi.getRiddenSegments.mockResolvedValue({
      segments: [
        {
          id: "seg-1",
          last_ridden_at: "2026-04-15T10:00:00Z",
          last_quality_score: 4.0,
          ride_count: 2,
        },
      ],
    });
    mockedApi.getNearbyUnriddenSegments.mockResolvedValue([
      {
        id: "u1",
        road_name: "Forest Road",
        length_m: 2400,
        quality_score: 4.5,
        surface_type: "asphalt",
        distance_m: 800,
      },
    ]);
  });

  it("renders the stats card and the nearby unridden list", async () => {
    await render(<PersonalRoadMapScreen />);

    await waitFor(() => expect(screen.getByText("12.5%")).toBeTruthy());
    expect(screen.getByText("of 800 segments")).toBeTruthy();
    expect(screen.getByText("1,234.5 km")).toBeTruthy();
    expect(
      screen.getByText("1 segment highlighted for the selected period"),
    ).toBeTruthy();
    expect(screen.getByText("Forest Road")).toBeTruthy();
    // Distance is rendered in metres for sub-1km values.
    expect(screen.getByText(/800 m from you/)).toBeTruthy();
    // Quality tile source is mounted when the overlay is enabled.
    expect(screen.getByTestId("VectorSource")).toBeTruthy();
  });

  it("drops the quality tile source when road_quality_overlay is killed", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    await render(<PersonalRoadMapScreen />);

    await waitFor(() => expect(screen.getByText("12.5%")).toBeTruthy());
    // The stats/map chrome still render, but the quality VectorSource — which
    // would request the operator-pulled tiles — is gone.
    expect(screen.queryByTestId("VectorSource")).toBeNull();
  });

  it("renders the empty CTA for a brand-new rider with no recorded rides", async () => {
    mockedApi.getRiddenSegments.mockResolvedValue({ segments: [] });
    await render(<PersonalRoadMapScreen />);
    await waitFor(() =>
      expect(screen.getByText("No rides recorded yet")).toBeTruthy(),
    );
  });
});

describe("buildPersonalLineStyle", () => {
  it("returns a uniform-dim style when the rider has no ridden segments", () => {
    const style = __test.buildPersonalLineStyle([]);
    // No `match` expression — `line-color` is a flat string.
    expect(typeof style.paint["line-color"]).toBe("string");
  });

  it("emits a single grouped match expression so ids aren't duplicated per stop", () => {
    const style = __test.buildPersonalLineStyle(["seg-a", "seg-b"]);
    expect(Array.isArray(style.paint["line-color"])).toBe(true);
    const expr = style.paint["line-color"] as unknown[];
    // Grouped form: ["match", ["get", "id"], [labels…], output, fallback]
    expect(expr[0]).toBe("match");
    expect(Array.isArray(expr[2])).toBe(true);
    expect(expr[2]).toEqual(["seg-a", "seg-b"]);
    // Only one entry per id — guards against regressing back to the
    // flat alternating form which repeated each id twice (once per
    // stop) and another two times across lineOpacity.
    expect((expr[2] as string[]).length).toBe(2);
  });

  it("uses the same id list across lineColor and lineOpacity instead of duplicating it", () => {
    const style = __test.buildPersonalLineStyle(["seg-a", "seg-b"]);
    const colorExpr = style.paint["line-color"] as unknown[];
    const opacityExpr = style.paint["line-opacity"] as unknown[];
    expect(opacityExpr[0]).toBe("match");
    expect(opacityExpr[2]).toEqual(colorExpr[2]);
  });
});

/**
 * #1279 — this screen paints RIDDEN vs UNRIDDEN coverage, which is exploration
 * data rather than paid quality detail. Since tile fetches carry identity the
 * backend withholds the `quality` layer above the requester's
 * `road_quality_max_zoom`, so sourcing it from there would blank the whole
 * screen from z13 up for a free rider.
 */
describe("PersonalRoadMapScreen coverage tiles", () => {
  beforeEach(() => {
    mockMapLibreProps.VectorSource.length = 0;
    mockMapLibreProps.Layer.length = 0;
  });

  it("requests the never-clamped surface layer, not the quality one", async () => {
    await render(<PersonalRoadMapScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("VectorSource")).toBeTruthy(),
    );

    const source = mockMapLibreProps.VectorSource[0];
    expect(source).toBeDefined();
    const tiles = source!.tiles as string[];
    expect(tiles[0]).toContain("layers=surface");
    expect(tiles[0]).not.toContain("layers=quality");

    const layer = mockMapLibreProps.Layer.find(
      (l) => l.id === "tarmoto-personal-lines",
    );
    expect(layer?.["source-layer"]).toBe("surface");
  });
});
