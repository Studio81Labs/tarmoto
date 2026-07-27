import React from "react";
import { Alert } from "react-native";
import {
  act,
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
import { ApiError, api } from "@/services/api";
import { useAuthStore } from "@/stores";
import type { RideDetail } from "@/types";

const mockGoBack = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute: () => ({ params: { rideId: "ride-1" } }),
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
  // The screen narrows a stale-entitlement 403 with `err instanceof
  // ApiError`; the mock must expose a real constructor so `instanceof`
  // doesn't throw on the rejection built in the 403-net test below.
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

const RIDE: RideDetail = {
  id: "ride-1",
  ride_type: "free",
  status: "completed",
  started_at: "2026-04-17T14:32:00",
  ended_at: "2026-04-17T16:02:00",
  distance_km: 42.5,
  duration_min: 90,
  avg_speed: 45,
  avg_road_quality: 4.0,
  avg_curviness: null,
  bike_id: null,
  name: null,
  viewer_is_owner: true,
  rider_id: "rider-1",
  rider_name: "Test Rider",
  rider_avatar_url: null,
  share_token: null,
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
      road_name: null,
      quality_reading: 4.5,
      speed_avg: 60,
      speed_max: null,
      lean_angle_max: 20,
    },
    {
      road_segment_id: "s2",
      road_name: null,
      quality_reading: 3.0,
      speed_avg: 40,
      speed_max: null,
      lean_angle_max: 12,
    },
  ],
};

// Entitled by default so the pre-existing export assertions keep holding
// once `ShareActions` reads `useFeature("gpx_export")` /
// `useEntitlements()` (both back onto this store) — see per-test
// overrides below for the disabled/unresolved/403 gate cases.
// `advanced_ride_stats: true` keeps the #M5 elevation/max-lean/lean-
// breakdown tiles unlocked by default too, so the pre-existing assertions
// on the real values (`+320 m` etc.) keep holding.
const ENTITLED_USER = {
  id: "u1",
  subscription_tier: "free",
  features: { gpx_export: true, advanced_ride_stats: true },
  limits: {},
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
    useAuthStore.setState({ user: ENTITLED_USER as never });
  });

  afterEach(() => act(() => useAuthStore.setState({ user: null })));

  it("renders ride stats after fetching the ride detail", async () => {
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);

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
    expect(screen.getByText("4.2L")).toBeTruthy();
    expect(screen.getByText("32°")).toBeTruthy();
    expect(screen.getByLabelText("Share ride")).toBeTruthy();
    expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy();
  });

  // #M5: advanced_ride_stats — resolved + entitled renders the real paid
  // values (elevation/max-lean/lean-distribution), not locked placeholders.
  it("renders real elevation, max lean, and lean breakdown values when advanced_ride_stats is entitled", async () => {
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);

    await waitFor(() => expect(screen.getByText("+320 m")).toBeTruthy());
    expect(screen.getByText("-280 m")).toBeTruthy();
    expect(screen.getByText("32°")).toBeTruthy();
    // Lean breakdown renders its real bucket rows, not the locked teaser.
    expect(screen.getByText("0–10°")).toBeTruthy();
    expect(screen.getByText("30°+")).toBeTruthy();
    expect(screen.queryByText("Advanced stats are a Pro feature.")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
  });

  // #M5: resolved + NOT entitled shows locked teaser tiles instead of the
  // real values, and a single shared UpgradePrompt backs every locked tile.
  it("shows locked teaser tiles instead of paid stats when advanced_ride_stats is disabled", async () => {
    useAuthStore.setState({
      user: {
        ...ENTITLED_USER,
        features: { gpx_export: true, advanced_ride_stats: false },
      } as never,
    });
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);

    // Non-paid stats still render normally.
    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());
    expect(screen.getByText("45 km/h")).toBeTruthy();

    // Paid values must never leak.
    expect(screen.queryByText("+320 m")).toBeNull();
    expect(screen.queryByText("-280 m")).toBeNull();
    expect(screen.queryByText("32°")).toBeNull();
    expect(screen.queryByText("0–10°")).toBeNull();

    // Locked teaser affordance: Ascent, Descent, and Max lean tiles all
    // read "Pro"; the lean breakdown card shows its own upsell hint.
    expect(screen.getAllByText("Pro")).toHaveLength(3);
    expect(screen.getByText("Advanced stats are a Pro feature.")).toBeTruthy();

    // Tapping the locked Ascent tile opens the shared upgrade prompt.
    await fireEvent.press(
      screen.getByLabelText("Ascent — Pro stat. Tap to upgrade."),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Advanced stats are a Pro feature."),
      ).toHaveLength(2),
    );

    // Dismiss, then confirm the SAME prompt also opens from the locked
    // lean-breakdown card — i.e. one shared modal, not one per tile.
    await fireEvent.press(screen.getByText("Dismiss"));
    await waitFor(() =>
      expect(
        screen.getAllByText("Advanced stats are a Pro feature."),
      ).toHaveLength(1),
    );
    await fireEvent.press(
      screen.getByLabelText("Lean breakdown — Pro stat. Tap to upgrade."),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Advanced stats are a Pro feature."),
      ).toHaveLength(2),
    );
  });

  it("uses neutral (no-upgrade) copy when advanced_ride_stats is force-off for a top-tier rider", async () => {
    // A Premium rider with advanced_ride_stats force-disabled by an operator:
    // upgradeTierForFeature has no target, so the teaser must not say "Tap to
    // upgrade" and the modal must show neutral copy + "Limit reached".
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "premium",
        features: { gpx_export: true, advanced_ride_stats: false },
        limits: {},
      } as never,
    });
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);
    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());

    // Neutral tile affordance — no "Tap to upgrade".
    expect(screen.getByLabelText("Ascent — Pro stat.")).toBeTruthy();
    expect(
      screen.queryByLabelText("Ascent — Pro stat. Tap to upgrade."),
    ).toBeNull();

    await fireEvent.press(screen.getByLabelText("Ascent — Pro stat."));

    // The neutral copy shows in both the lean-card hint and the opened modal.
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "Advanced stats aren't available on your current plan.",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText("Limit reached")).toBeTruthy();
    expect(screen.queryByText("Upgrade required")).toBeNull();
    // The upgrade-directive copy must be absent everywhere.
    expect(screen.queryByText("Advanced stats are a Pro feature.")).toBeNull();
  });

  it("refetches the ride when advanced_ride_stats flips from disabled to enabled", async () => {
    // Opened while disabled: the backend stripped the paid fields to null, so
    // the ride on screen shows locked tiles.
    useAuthStore.setState({
      user: {
        ...ENTITLED_USER,
        features: { gpx_export: true, advanced_ride_stats: false },
      } as never,
    });
    getRideMock.mockResolvedValue(RIDE);

    await render(<RideDetailScreen />);
    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());
    expect(getRideMock).toHaveBeenCalledTimes(1);

    // A foreground refresh grants the feature — the stale stripped ride must be
    // refetched so the now-unlocked tiles show real data instead of dashes.
    await act(async () => {
      useAuthStore.setState({
        user: {
          ...ENTITLED_USER,
          features: { gpx_export: true, advanced_ride_stats: true },
        } as never,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getRideMock).toHaveBeenCalledTimes(2));
  });

  it("keeps the current ride visible when the background stats-refetch fails", async () => {
    useAuthStore.setState({
      user: {
        ...ENTITLED_USER,
        features: { gpx_export: true, advanced_ride_stats: false },
      } as never,
    });
    // First (initial) load succeeds; the background refetch on enable rejects.
    getRideMock
      .mockResolvedValueOnce(RIDE)
      .mockRejectedValueOnce(new Error("offline"));

    await render(<RideDetailScreen />);
    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());

    await act(async () => {
      useAuthStore.setState({
        user: {
          ...ENTITLED_USER,
          features: { gpx_export: true, advanced_ride_stats: true },
        } as never,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getRideMock).toHaveBeenCalledTimes(2));
    // The failed silent refetch must NOT blank the ride to the error screen —
    // the already-rendered ride stays put.
    expect(screen.getByText("42.5 km")).toBeTruthy();
    expect(screen.queryByText("Couldn't load ride")).toBeNull();
  });

  it("still refetches when advanced_ride_stats enables DURING the initial load", async () => {
    useAuthStore.setState({
      user: {
        ...ENTITLED_USER,
        features: { gpx_export: true, advanced_ride_stats: false },
      } as never,
    });
    // Hold the initial load open so the entitlement flips while it's pending.
    let resolveInitial: (r: RideDetail) => void = () => {};
    getRideMock
      .mockImplementationOnce(
        () =>
          new Promise<RideDetail>((res) => {
            resolveInitial = res;
          }),
      )
      .mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);

    // Flip to enabled while the initial getRide is still in flight — the
    // transition must be RECORDED (not lost to the phase-guard) and deferred.
    await act(async () => {
      useAuthStore.setState({
        user: {
          ...ENTITLED_USER,
          features: { gpx_export: true, advanced_ride_stats: true },
        } as never,
      });
      await Promise.resolve();
    });

    // The (stripped) initial response lands → phase ready drains the pending
    // refetch.
    await act(async () => {
      resolveInitial(RIDE);
      await Promise.resolve();
    });

    await waitFor(() => expect(getRideMock).toHaveBeenCalledTimes(2));
  });

  // #M5: fail closed — while the entitlement snapshot is unresolved, treat
  // the rider as not-entitled (locked), never as entitled. This matters
  // even though the paid fields are null anyway for a non-entitled rider:
  // the gate must key off the snapshot, not off the data shape.
  it("fails closed to locked teaser tiles while the entitlement snapshot is unresolved", async () => {
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);

    await waitFor(() => expect(screen.getByText("42.5 km")).toBeTruthy());
    expect(screen.getAllByText("Pro")).toHaveLength(3);
    expect(screen.queryByText("+320 m")).toBeNull();
    expect(screen.queryByText("-280 m")).toBeNull();
    expect(screen.queryByText("32°")).toBeNull();
    expect(screen.queryByText("0–10°")).toBeNull();
    expect(screen.getByText("Advanced stats are a Pro feature.")).toBeTruthy();
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
          road_name: null,
          quality_reading: 0,
          speed_avg: 0,
          speed_max: null,
          lean_angle_max: 0,
        },
        {
          road_segment_id: "s4",
          road_name: null,
          quality_reading: Number.NaN,
          speed_avg: 0,
          speed_max: null,
          lean_angle_max: 0,
        },
      ],
    };
    getRideMock.mockResolvedValueOnce(rideWithMissing);

    await render(<RideDetailScreen />);

    // 4 segments in the fixture, only 2 contribute to the histogram —
    // the meta line must show the lower count to agree with the bars.
    await waitFor(() => expect(screen.getByText("2 segments")).toBeTruthy());
    expect(screen.queryByText("4 segments")).toBeNull();
  });

  it("shows an error state and a retry button when the fetch fails", async () => {
    getRideMock.mockRejectedValueOnce(new Error("offline"));

    await render(<RideDetailScreen />);

    await waitFor(() =>
      expect(screen.getAllByText(/Couldn't load ride/i).length).toBeGreaterThan(
        0,
      ),
    );
  });

  it("exports GPX as a file attachment via the system share sheet", async () => {
    getRideMock.mockResolvedValueOnce(RIDE);
    exportGpxMock.mockResolvedValueOnce("<gpx>…</gpx>");

    await render(<RideDetailScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy(),
    );

    await fireEvent.press(screen.getByLabelText("Export ride as GPX"));

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

  it("opens the upgrade prompt instead of exporting when gpx_export is disabled", async () => {
    useAuthStore.setState({
      user: {
        ...ENTITLED_USER,
        features: { gpx_export: false },
      } as never,
    });
    getRideMock.mockResolvedValueOnce(RIDE);

    await render(<RideDetailScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy(),
    );

    await fireEvent.press(screen.getByLabelText("Export ride as GPX"));

    await waitFor(() =>
      expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy(),
    );
    expect(exportGpxMock).not.toHaveBeenCalled();
    expect(shareOpenMock).not.toHaveBeenCalled();
  });

  it("opens the upgrade prompt on a stale-entitlement 403 from the export call", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    getRideMock.mockResolvedValueOnce(RIDE);
    exportGpxMock.mockRejectedValueOnce(
      new ApiError("Feature unavailable: gpx_export", 403, {
        message: "Feature unavailable: gpx_export",
      }),
    );

    await render(<RideDetailScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText("Export ride as GPX")).toBeTruthy(),
    );

    await fireEvent.press(screen.getByLabelText("Export ride as GPX"));

    await waitFor(() =>
      expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy(),
    );
    expect(shareOpenMock).not.toHaveBeenCalled();
    // Must not also fall through to the generic error toast.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("hides GPX export/upgrade for a non-owner viewing a shared ride", async () => {
    // Backend export requires ownership, so a non-owner would only ever get
    // "Ride not found" — and a free viewer must not be nudged to upgrade for
    // an action that ownership, not tier, gates.
    useAuthStore.setState({
      user: { ...ENTITLED_USER, features: { gpx_export: false } } as never,
    });
    getRideMock.mockResolvedValueOnce({ ...RIDE, viewer_is_owner: false });

    await render(<RideDetailScreen />);
    // Share stays available to any viewer; only the GPX export is gated.
    await waitFor(() =>
      expect(screen.getByLabelText("Share ride")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Export ride as GPX")).toBeNull();
    expect(screen.queryByText("GPX export is a Pro feature.")).toBeNull();
  });
});
