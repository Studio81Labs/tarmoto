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
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";

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

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
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
}));

jest.mock("@/hooks", () => ({
  usePendingUploads: () => ({
    count: 0,
    isRetrying: false,
    lastFlushed: null,
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
        preferences: {
          units: "metric",
          daily_km: 200,
          min_quality: 3,
          road_types: [],
          record_gps: true,
          crash_detection: false,
        },
      },
      setUser: jest.fn(),
    }),
  useOfflineStore: (selector: (s: unknown) => unknown) =>
    selector({ regions: [] }),
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({
      minQuality: 3,
      setMinQuality: jest.fn(),
      fuelRangeKm: 250,
      setFuelRangeKm: jest.fn(),
    }),
}));

import SettingsScreen from "../SettingsScreen";
import { api } from "@/services/api";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SettingsScreen bulk export", () => {
  it("downloads the GPX bundle and opens the share sheet", async () => {
    render(<SettingsScreen />);
    fireEvent.press(screen.getByLabelText("Export all rides as GPX"));

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
    render(<SettingsScreen />);
    fireEvent.press(screen.getByLabelText("Export all rides as CSV"));

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
    let resolveGpx: ((value: string) => void) | null = null;
    (api.exportAllRidesGpx as jest.Mock).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveGpx = resolve;
      }),
    );

    render(<SettingsScreen />);
    fireEvent.press(screen.getByLabelText("Export all rides as GPX"));
    // CSV button should be disabled — calling press still works in the
    // stub, so we assert via call counts on the API.
    fireEvent.press(screen.getByLabelText("Export all rides as CSV"));

    expect(api.exportAllRidesGpx).toHaveBeenCalledTimes(1);
    expect(api.exportAllRidesCsv).not.toHaveBeenCalled();

    resolveGpx?.("<gpx></gpx>");
    await waitFor(() => {
      expect(RNShare.open).toHaveBeenCalledTimes(1);
    });
  });
});
