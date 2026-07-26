/**
 * Verifies that the SettingsScreen bulk-export flow:
 *  - calls the right backend endpoint per format,
 *  - persists the response to the OS temp directory,
 *  - hands the file to the system share sheet via `react-native-share`,
 *  - tolerates rider cancellation without raising a dialog.
 *
 * Mocks the picker / native modules at the boundary so the test runs
 * in jest without driving any platform code.
 */
import React from "react";
import { Alert } from "react-native";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";

const mockSetUser = jest.fn();
const mockApplyProfileUpdate = jest.fn();
const mockSetDistanceUnit = jest.fn();
let mockVoiceNavEnabled = true;
// Entitled by default so the pre-existing GPX export assertions keep
// holding once `BulkExportCard` reads `useFeature("gpx_export")` /
// `useEntitlements()` (both back onto this mocked store) — flipped false
// in the gate tests below. CSV is never gated, so it has no equivalent.
let mockGpxEnabled = true;

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

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: {
    TemporaryDirectoryPath: "/tmp",
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: jest.fn().mockResolvedValue({ success: true }) },
}));

jest.mock("@/services/api", () => ({
  api: {
    exportAllRidesGpx: jest.fn().mockResolvedValue("<gpx></gpx>"),
    exportAllRidesCsv: jest.fn().mockResolvedValue("id,distance\n1,42"),
    updateProfile: jest.fn(),
  },
  // `BulkExportCard` narrows a stale-entitlement 403 with `err instanceof
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

jest.mock("@/hooks", () => ({
  usePendingUploads: () => ({
    count: 0,
    isRetrying: false,
    lastFlushed: null,
    retry: jest.fn(),
  }),
  usePendingHazardReports: () => ({
    count: 0,
    isRetrying: false,
    lastResult: null,
    retry: jest.fn(),
  }),
}));

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock("@/stores", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      user: {
        id: "u1",
        email: "x@example.com",
        display_name: "x",
        subscription_tier: "free",
        features: { gpx_export: mockGpxEnabled },
        limits: {},
        preferences: {
          units: "metric",
          daily_km: 200,
          min_quality: 3,
          road_types: [],
          record_gps: true,
          crash_detection: false,
        },
      },
      setUser: mockSetUser,
      applyProfileUpdate: mockApplyProfileUpdate,
    }),
  useOfflineStore: (selector: (s: unknown) => unknown) =>
    selector({ regions: [] }),
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({
      minQuality: 3,
      setMinQuality: jest.fn(),
      fuelRangeKm: 250,
      setFuelRangeKm: jest.fn(),
      weatherAlertsEnabled: true,
      setWeatherAlertsEnabled: jest.fn(),
      voiceNavEnabled: mockVoiceNavEnabled,
      setVoiceNavEnabled: jest.fn(),
      voiceNavVolume: 1,
      setVoiceNavVolume: jest.fn(),
      voiceNavLanguage: "auto",
      setVoiceNavLanguage: jest.fn(),
      voiceNavVerbose: true,
      setVoiceNavVerbose: jest.fn(),
      distanceUnit: "metric",
      setDistanceUnit: mockSetDistanceUnit,
    }),
}));

import SettingsScreen from "../SettingsScreen";
import { ApiError, api } from "@/services/api";

beforeEach(() => {
  jest.clearAllMocks();
  mockVoiceNavEnabled = true;
  mockGpxEnabled = true;
});

describe("SettingsScreen bulk export", () => {
  it("keeps display-unit controls visible when voice navigation is disabled", async () => {
    mockVoiceNavEnabled = false;

    await render(<SettingsScreen />);

    expect(screen.getByText("Distance units")).toBeTruthy();
    expect(screen.getByLabelText("Imperial")).toBeTruthy();
    expect(screen.queryByText("Spoken language")).toBeNull();
  });

  it("persists a distance-unit change to the authenticated profile", async () => {
    const updatedUser = { id: "u1", preferences: { units: "imperial" } };
    jest.mocked(api.updateProfile).mockResolvedValueOnce(updatedUser as never);

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Imperial"));

    expect(mockSetDistanceUnit).toHaveBeenCalledWith("imperial");
    await waitFor(() => {
      expect(api.updateProfile).toHaveBeenCalledWith({
        preferences: { units: "imperial" },
      });
      expect(mockApplyProfileUpdate).toHaveBeenCalledWith(updatedUser);
    });
  });

  it("rolls back an optimistic distance-unit change when persistence fails", async () => {
    jest
      .mocked(api.updateProfile)
      .mockRejectedValueOnce(new Error("Network unavailable"));

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Imperial"));

    await waitFor(() => {
      expect(mockSetDistanceUnit).toHaveBeenNthCalledWith(1, "imperial");
      expect(mockSetDistanceUnit).toHaveBeenNthCalledWith(2, "metric");
      expect(screen.getByText("Couldn't update preference.")).toBeTruthy();
    });
  });

  it("downloads the GPX bundle and opens the share sheet", async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as GPX"));

    await waitFor(() => {
      expect(api.exportAllRidesGpx).toHaveBeenCalledTimes(1);
    });
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      "/tmp/tarmoto-rides.gpx",
      "<gpx></gpx>",
      "utf8",
    );
    expect(RNShare.open).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "application/gpx+xml",
        filename: "tarmoto-rides.gpx",
        failOnCancel: false,
      }),
    );
  });

  it("downloads the CSV bundle and opens the share sheet", async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as CSV"));

    await waitFor(() => {
      expect(api.exportAllRidesCsv).toHaveBeenCalledTimes(1);
    });
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      "/tmp/tarmoto-rides.csv",
      "id,distance\n1,42",
      "utf8",
    );
    expect(RNShare.open).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text/csv",
        filename: "tarmoto-rides.csv",
      }),
    );
  });

  it("blocks parallel exports while one is in flight", async () => {
    // Initialise to a no-op so TS doesn't narrow `resolveGpx` to `null`
    // after the in-callback assignment — control-flow analysis won't
    // re-widen across closure boundaries, and the optional-chained call
    // below would otherwise be typed as `never`.
    let resolveGpx: (value: string) => void = () => undefined;
    (api.exportAllRidesGpx as jest.Mock).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveGpx = resolve;
      }),
    );

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as GPX"));
    // CSV button should be disabled — calling press still works in the
    // stub, so we assert via call counts on the API.
    await fireEvent.press(screen.getByLabelText("Export all rides as CSV"));

    expect(api.exportAllRidesGpx).toHaveBeenCalledTimes(1);
    expect(api.exportAllRidesCsv).not.toHaveBeenCalled();

    resolveGpx("<gpx></gpx>");
    await waitFor(() => {
      expect(RNShare.open).toHaveBeenCalledTimes(1);
    });
  });

  it("opens the upgrade prompt instead of exporting GPX when gpx_export is disabled", async () => {
    mockGpxEnabled = false;

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as GPX"));

    await waitFor(() =>
      expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy(),
    );
    expect(api.exportAllRidesGpx).not.toHaveBeenCalled();
    expect(RNShare.open).not.toHaveBeenCalled();
  });

  it("still allows CSV export when gpx_export is disabled", async () => {
    mockGpxEnabled = false;

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as CSV"));

    await waitFor(() => {
      expect(api.exportAllRidesCsv).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("GPX export is a Pro feature.")).toBeNull();
  });

  it("opens the upgrade prompt on a stale-entitlement 403 from the GPX export call", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    (api.exportAllRidesGpx as jest.Mock).mockRejectedValueOnce(
      new ApiError("Feature unavailable: gpx_export", 403, {
        message: "Feature unavailable: gpx_export",
      }),
    );

    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByLabelText("Export all rides as GPX"));

    await waitFor(() =>
      expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy(),
    );
    expect(RNShare.open).not.toHaveBeenCalled();
    // Must not also fall through to the generic error toast.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
