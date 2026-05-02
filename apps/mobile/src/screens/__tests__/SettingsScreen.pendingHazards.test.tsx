/**
 * Verifies the Settings hazard-report retry surface (#338):
 *  - the pending count is rendered when there's a backlog
 *  - "Retry now" calls the hook's retry()
 *  - after the drain resolves, the result toast composes
 *    "Uploaded N · M failed · K still queued" from the hook's snapshot
 *  - with no backlog, the empty-state copy renders and no button shows
 *
 * The hook itself is mocked so this test stays focused on the card's
 * rendering contract — the queue/drain semantics are covered in
 * `usePendingHazardReports.test.tsx` and `hazardQueue.test.ts`.
 */
import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";

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
    writeFile: jest.fn(),
  },
}));

jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: jest.fn() },
}));

jest.mock("@/services/api", () => ({
  api: {
    exportAllRidesGpx: jest.fn(),
    exportAllRidesCsv: jest.fn(),
    updateProfile: jest.fn(),
  },
}));

const mockSensorRetry = jest.fn();
const mockHazardRetry = jest.fn();

interface HazardOutcome {
  flushed: number;
  failed: number;
  remaining: number;
}

let mockHazardState = {
  count: 0,
  isRetrying: false,
  lastResult: null as HazardOutcome | null,
};

jest.mock("@/hooks", () => ({
  usePendingUploads: () => ({
    count: 0,
    isRetrying: false,
    lastFlushed: null,
    retry: mockSensorRetry,
  }),
  usePendingHazardReports: () => ({
    ...mockHazardState,
    retry: mockHazardRetry,
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
      weatherAlertsEnabled: true,
      setWeatherAlertsEnabled: jest.fn(),
    }),
}));

import SettingsScreen, { formatHazardRetryResult } from "../SettingsScreen";

beforeEach(() => {
  jest.clearAllMocks();
  mockHazardState = { count: 0, isRetrying: false, lastResult: null };
});

describe("SettingsScreen pending hazard reports", () => {
  it("shows the empty state and no Retry button when there is no backlog", () => {
    render(<SettingsScreen />);
    expect(screen.queryByLabelText("Retry pending hazard reports")).toBeNull();
    expect(
      screen.getByText(
        "All your hazard reports are synced to the Tarmoto community.",
      ),
    ).toBeTruthy();
  });

  it("renders the pending count and a Retry now button when there is a backlog", () => {
    mockHazardState = { count: 3, isRetrying: false, lastResult: null };
    render(<SettingsScreen />);
    expect(
      screen.getByText(
        "3 hazard reports waiting to upload. We'll retry automatically next time you submit a report.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Retry pending hazard reports")).toBeTruthy();
  });

  it("uses singular phrasing for a single queued report", () => {
    mockHazardState = { count: 1, isRetrying: false, lastResult: null };
    render(<SettingsScreen />);
    expect(
      screen.getByText(
        "1 hazard report waiting to upload. We'll retry automatically next time you submit a report.",
      ),
    ).toBeTruthy();
  });

  it("invokes the hook retry on press", async () => {
    mockHazardState = { count: 2, isRetrying: false, lastResult: null };
    render(<SettingsScreen />);

    fireEvent.press(screen.getByLabelText("Retry pending hazard reports"));

    await waitFor(() => {
      expect(mockHazardRetry).toHaveBeenCalledTimes(1);
    });
  });

  it("renders the success-only outcome after a clean flush", () => {
    mockHazardState = {
      count: 0,
      isRetrying: false,
      lastResult: { flushed: 3, failed: 0, remaining: 0 },
    };
    render(<SettingsScreen />);
    expect(screen.getByText("Uploaded 3 reports.")).toBeTruthy();
  });

  it("renders the mixed outcome with failed + still-queued segments", () => {
    mockHazardState = {
      count: 1,
      isRetrying: false,
      lastResult: { flushed: 2, failed: 1, remaining: 1 },
    };
    render(<SettingsScreen />);
    expect(
      screen.getByText("Uploaded 2 reports · 1 failed · 1 still queued."),
    ).toBeTruthy();
  });

  it("renders the still-queued-only outcome when the network was down", () => {
    mockHazardState = {
      count: 2,
      isRetrying: false,
      lastResult: { flushed: 0, failed: 0, remaining: 2 },
    };
    render(<SettingsScreen />);
    expect(screen.getByText("2 still queued.")).toBeTruthy();
  });
});

describe("formatHazardRetryResult", () => {
  it("returns null while a retry is in flight", () => {
    expect(
      formatHazardRetryResult({ flushed: 1, failed: 0, remaining: 0 }, true),
    ).toBeNull();
  });

  it("returns null when nothing has been retried yet", () => {
    expect(formatHazardRetryResult(null, false)).toBeNull();
  });

  it("returns null when the snapshot is empty (defensive)", () => {
    expect(
      formatHazardRetryResult({ flushed: 0, failed: 0, remaining: 0 }, false),
    ).toBeNull();
  });

  it("uses success tone for a clean flush", () => {
    expect(
      formatHazardRetryResult({ flushed: 2, failed: 0, remaining: 0 }, false),
    ).toEqual({ text: "Uploaded 2 reports.", tone: "success" });
  });

  it("uses warning tone when anything still failed or queued", () => {
    expect(
      formatHazardRetryResult({ flushed: 0, failed: 0, remaining: 1 }, false),
    ).toEqual({ text: "1 still queued.", tone: "warning" });
    expect(
      formatHazardRetryResult({ flushed: 1, failed: 1, remaining: 0 }, false),
    ).toEqual({ text: "Uploaded 1 report · 1 failed.", tone: "warning" });
  });
});
