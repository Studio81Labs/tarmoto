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
import { translate } from "@/i18n";

beforeEach(() => {
  jest.clearAllMocks();
  mockHazardState = { count: 0, isRetrying: false, lastResult: null };
});

describe("SettingsScreen pending hazard reports", () => {
  it("shows the empty state and no Retry button when there is no backlog", async () => {
    await render(<SettingsScreen />);
    expect(screen.queryByLabelText("Retry pending hazard reports")).toBeNull();
    expect(
      screen.getByText(
        "All your hazard reports are synced to the Tarmoto community.",
      ),
    ).toBeTruthy();
  });

  it("renders the pending count and a Retry now button when there is a backlog", async () => {
    mockHazardState = { count: 3, isRetrying: false, lastResult: null };
    await render(<SettingsScreen />);
    expect(
      screen.getByText(
        "3 hazard reports waiting to upload. We'll retry automatically next time you submit a report.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Retry pending hazard reports")).toBeTruthy();
  });

  it("uses singular phrasing for a single queued report", async () => {
    mockHazardState = { count: 1, isRetrying: false, lastResult: null };
    await render(<SettingsScreen />);
    expect(
      screen.getByText(
        "1 hazard report waiting to upload. We'll retry automatically next time you submit a report.",
      ),
    ).toBeTruthy();
  });

  it("invokes the hook retry on press", async () => {
    mockHazardState = { count: 2, isRetrying: false, lastResult: null };
    await render(<SettingsScreen />);

    await fireEvent.press(
      screen.getByLabelText("Retry pending hazard reports"),
    );

    await waitFor(() => {
      expect(mockHazardRetry).toHaveBeenCalledTimes(1);
    });
  });

  it("renders the success-only outcome after a clean flush", async () => {
    mockHazardState = {
      count: 0,
      isRetrying: false,
      lastResult: { flushed: 3, failed: 0, remaining: 0 },
    };
    await render(<SettingsScreen />);
    expect(screen.getByText("Uploaded 3 reports.")).toBeTruthy();
  });

  it("renders the mixed outcome with failed + still-queued segments", async () => {
    mockHazardState = {
      count: 1,
      isRetrying: false,
      lastResult: { flushed: 2, failed: 1, remaining: 1 },
    };
    await render(<SettingsScreen />);
    expect(
      screen.getByText("Uploaded 2 reports · 1 failed · 1 still queued."),
    ).toBeTruthy();
  });

  it("renders the still-queued-only outcome when the network was down", async () => {
    mockHazardState = {
      count: 2,
      isRetrying: false,
      lastResult: { flushed: 0, failed: 0, remaining: 2 },
    };
    await render(<SettingsScreen />);
    expect(screen.getByText("2 still queued.")).toBeTruthy();
  });
});

describe("formatHazardRetryResult", () => {
  it("returns null while a retry is in flight", () => {
    expect(
      formatHazardRetryResult(
        { flushed: 1, failed: 0, remaining: 0, capReached: false },
        true,
        translate,
      ),
    ).toBeNull();
  });

  it("returns null when nothing has been retried yet", () => {
    expect(formatHazardRetryResult(null, false, translate)).toBeNull();
  });

  it("returns null when the snapshot is empty (defensive)", () => {
    expect(
      formatHazardRetryResult(
        { flushed: 0, failed: 0, remaining: 0, capReached: false },
        false,
        translate,
      ),
    ).toBeNull();
  });

  it("uses success tone for a clean flush", () => {
    expect(
      formatHazardRetryResult(
        { flushed: 2, failed: 0, remaining: 0, capReached: false },
        false,
        translate,
      ),
    ).toEqual({ text: "Uploaded 2 reports.", tone: "success" });
  });

  it.each([
    [{ flushed: 0, failed: 1, remaining: 0, capReached: false }, "1 failed."],
    [
      { flushed: 0, failed: 0, remaining: 1, capReached: false },
      "1 still queued.",
    ],
    [
      { flushed: 1, failed: 1, remaining: 0, capReached: false },
      "Uploaded 1 report · 1 failed.",
    ],
    [
      { flushed: 1, failed: 0, remaining: 1, capReached: false },
      "Uploaded 1 report · 1 still queued.",
    ],
    [
      { flushed: 0, failed: 1, remaining: 1, capReached: false },
      "1 failed · 1 still queued.",
    ],
    [
      { flushed: 2, failed: 1, remaining: 1, capReached: false },
      "Uploaded 2 reports · 1 failed · 1 still queued.",
    ],
  ])("uses warning tone for retry outcome %#", (result, text) => {
    expect(formatHazardRetryResult(result, false, translate)).toEqual({
      text,
      tone: "warning",
    });
  });

  it("explains the daily cap (not a connectivity failure) when capReached with no flush", () => {
    // Codex P2: a rider tapping "Retry now" while blocked by the rolling daily
    // cap must see the limit explanation, not a bare "N still queued".
    expect(
      formatHazardRetryResult(
        { flushed: 0, failed: 0, remaining: 2, capReached: true },
        false,
        translate,
      ),
    ).toEqual({
      text: "You've reached today's hazard-report limit. 2 reports will retry later.",
      tone: "warning",
    });
  });

  it("reports partial flush + daily cap when some drained before the limit", () => {
    expect(
      formatHazardRetryResult(
        { flushed: 1, failed: 0, remaining: 2, capReached: true },
        false,
        translate,
      ),
    ).toEqual({
      text: "Uploaded 1 report · daily limit reached. 2 reports will retry later.",
      tone: "warning",
    });
  });
});
