import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";

// Bare-stub TouchableOpacity to a Pressable-equivalent that doesn't pull
// in the Animated path. fireEvent.press triggers a renderer init under
// the real TouchableOpacity that fails inside jest because the bundled
// react-native-renderer's React version drifts from the hoisted React
// in the test runtime — irrelevant to behaviour we're asserting.
jest.mock(
  "react-native/Libraries/Components/Touchable/TouchableOpacity",
  () => {
    const ReactLib = require("react");
    const { Pressable } = require("react-native");
    return {
      __esModule: true,
      default: function TouchableOpacityStub(
        props: Record<string, unknown> & { children?: React.ReactNode },
      ) {
        return ReactLib.createElement(Pressable, props, props.children);
      },
    };
  },
);
import RideDetailScreen from "../RideDetailScreen";
import { api } from "@/services/api";
import type { RideDetail } from "@/types";

const mockGoBack = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute: () => ({ params: { rideId: "ride-1" } }),
}));

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

// MapLibre native components don't run in jsdom; stub them to plain
// Views/empty render so the screen tree mounts.
jest.mock("@maplibre/maplibre-react-native", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  function Pass(props: { children?: React.ReactNode }) {
    return ReactLib.createElement(View, null, props.children);
  }
  return {
    Map: Pass,
    Camera: () => null,
    Layer: () => null,
    GeoJSONSource: Pass,
  };
});

jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: {
    TemporaryDirectoryPath: "/tmp",
    writeFile: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: jest.fn().mockResolvedValue({ success: true }) },
}));

jest.mock("@/services/api", () => ({
  api: {
    getRide: jest.fn(),
    exportRideGpx: jest.fn(),
  },
}));

const RIDE: RideDetail = {
  id: "ride-1",
  started_at: "2026-04-17T14:32:00",
  distance_km: 42.5,
  duration_min: 90,
  avg_speed: 45,
  avg_road_quality: 4.0,
  ride_type: "free",
  status: "completed",
  route_geometry: [
    { lat: 49.0, lng: 18.0 },
    { lat: 49.1, lng: 18.1 },
    { lat: 49.2, lng: 18.2 },
  ],
  max_speed: 95,
  elevation_gain: 320,
  elevation_loss: 280,
  curve_count: 12,
  max_lean_angle: 32,
  fuel_estimate_l: 4.2,
  lean_distribution: {
    "0_10": 60,
    "10_20": 25,
    "20_30": 12,
    "30_plus": 3,
  },
  segments: [
    {
      road_segment_id: "s1",
      quality_reading: 4.5,
      speed_avg: 60,
      lean_angle_max: 20,
    },
    {
      road_segment_id: "s2",
      quality_reading: 3.0,
      speed_avg: 40,
      lean_angle_max: 12,
    },
  ],
};

describe("RideDetailScreen", () => {
  const getRideMock = api.getRide as jest.MockedFunction<typeof api.getRide>;
  const exportGpxMock = api.exportRideGpx as jest.MockedFunction<
    typeof api.exportRideGpx
  >;
  const writeFileMock = RNFS.writeFile as jest.MockedFunction<
    typeof RNFS.writeFile
  >;
  const shareOpenMock = RNShare.open as jest.MockedFunction<
    typeof RNShare.open
  >;

  beforeEach(() => {
    getRideMock.mockReset();
    exportGpxMock.mockReset();
    writeFileMock.mockClear();
    shareOpenMock.mockClear();
  });

  it("renders ride stats after fetching the ride detail", async () => {
    getRideMock.mockResolvedValueOnce(RIDE);

    render(<RideDetailScreen />);

    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());
    expect(screen.getByText(/Apr 17, 2026/)).toBeTruthy();
    expect(screen.getByText("1h 30m")).toBeTruthy();
    // "Good" appears both in the summary card and the histogram row —
    // both are valid renderings of the bucketed average. We just need
    // any of them to assert the score crossed into the "good" band.
    expect(screen.getAllByText("Good").length).toBeGreaterThan(0);
    expect(screen.getByText("45 km/h")).toBeTruthy();
    expect(screen.getByText("95 km/h")).toBeTruthy();
    expect(screen.getByText("+320 m")).toBeTruthy();
    expect(screen.getByText("-280 m")).toBeTruthy();
    expect(screen.getByText("4.2 L")).toBeTruthy();
    expect(screen.getByText("32°")).toBeTruthy();
    expect(screen.getByLabelText("Share ride")).toBeTruthy();
    expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy();
  });

  it("counts only segments that contributed to the histogram in the meta line", async () => {
    // Pre-fix: the meta line read `segments.length` directly while
    // the bars came from `segmentQualityHistogram`, which silently
    // dropped rows with non-finite or `quality_reading <= 0`. The
    // header would then claim more segments than the bars summed
    // to, contradicting the same card's bars and the polyline's
    // no-data treatment.
    const rideWithMissing: RideDetail = {
      ...RIDE,
      segments: [
        ...RIDE.segments,
        // Two no-data rows that the histogram drops.
        {
          road_segment_id: "s3",
          quality_reading: 0,
          speed_avg: 0,
          lean_angle_max: 0,
        },
        {
          road_segment_id: "s4",
          quality_reading: Number.NaN,
          speed_avg: 0,
          lean_angle_max: 0,
        },
      ],
    };
    getRideMock.mockResolvedValueOnce(rideWithMissing);

    render(<RideDetailScreen />);

    // 4 segments in the fixture, only 2 contribute to the histogram —
    // the meta line must show the lower count to agree with the bars.
    await waitFor(() => expect(screen.getByText("2 segments")).toBeTruthy());
    expect(screen.queryByText("4 segments")).toBeNull();
  });

  it("shows an error state and a retry button when the fetch fails", async () => {
    getRideMock.mockRejectedValueOnce(new Error("offline"));

    render(<RideDetailScreen />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load ride/i)).toBeTruthy(),
    );
    expect(screen.getByText("offline")).toBeTruthy();
  });

  it("exports GPX as a file attachment via the system share sheet", async () => {
    getRideMock.mockResolvedValueOnce(RIDE);
    exportGpxMock.mockResolvedValueOnce("<gpx>…</gpx>");

    render(<RideDetailScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy(),
    );

    fireEvent.press(screen.getByLabelText("Export ride as GPX"));

    await waitFor(() => expect(exportGpxMock).toHaveBeenCalledWith("ride-1"));
    // The screen must write the bytes to disk and share that path —
    // sharing via `message` would deliver plain text instead of a
    // GPX attachment downstream apps can import.
    await waitFor(() =>
      expect(writeFileMock).toHaveBeenCalledWith(
        expect.stringContaining("tarmoto-ride-ride-1.gpx"),
        "<gpx>…</gpx>",
        "utf8",
      ),
    );
    await waitFor(() =>
      expect(shareOpenMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "application/gpx+xml",
          filename: "tarmoto-ride-ride-1.gpx",
        }),
      ),
    );
  });
});
