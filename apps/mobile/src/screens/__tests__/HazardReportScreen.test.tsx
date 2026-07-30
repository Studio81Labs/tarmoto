/**
 * HazardReportScreen — US-4 AC #9.
 *
 * Coverage:
 *   - form validation: submit button is disabled until a type is picked
 *   - offline queueing: api status `queued` triggers the offline alert
 *   - live success: store is updated, screen dismissed, haptic fires
 *   - preselected type from the long-press FAB menu lands selected
 *   - camera permission denial path surfaces an inline notice
 *
 * Service boundaries are mocked, not the navigation primitive itself
 * (we mock `useNavigation` / `useRoute` to capture intent).
 */

import React from "react";
import { Alert } from "react-native";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import HazardReportScreen from "../HazardReportScreen";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { capturePhoto } from "@/services/photoCapture";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockAddHazard = jest.fn();

let mockRouteParams: { preselectedType?: string } | undefined = undefined;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock("@/services/api", () => ({
  api: {
    submitHazardReport: jest.fn(),
  },
  // Real constructor so the screen's `err instanceof ApiError` cap-detection
  // holds against a thrown ApiError.
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

jest.mock("@/services/location", () => ({
  locationService: {
    getLastLocation: jest.fn(),
    getCurrentLocation: jest.fn(),
  },
}));

jest.mock("@/services/photoCapture", () => ({
  capturePhoto: jest.fn(),
}));

jest.mock("react-native-haptic-feedback", () => ({
  __esModule: true,
  default: { trigger: jest.fn() },
}));

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = () => ReactLib.createElement(Text, null, "icon");
  return { Icon: MockIcon };
});

jest.mock("@/stores", () => ({
  useHazardStore: (
    selector: (state: { addHazard: typeof mockAddHazard }) => unknown,
  ) => selector({ addHazard: mockAddHazard }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

const submitMock = api.submitHazardReport as jest.MockedFunction<
  typeof api.submitHazardReport
>;
const getLastLocationMock =
  locationService.getLastLocation as jest.MockedFunction<
    typeof locationService.getLastLocation
  >;
const getCurrentLocationMock =
  locationService.getCurrentLocation as jest.MockedFunction<
    typeof locationService.getCurrentLocation
  >;
const capturePhotoMock = capturePhoto as jest.MockedFunction<
  typeof capturePhoto
>;
const hapticTriggerMock =
  ReactNativeHapticFeedback.trigger as jest.MockedFunction<
    typeof ReactNativeHapticFeedback.trigger
  >;

function makeLocation(timestamp = Date.now()) {
  return {
    lat: 49.82,
    lng: 18.26,
    speed: 0,
    accuracy: 8,
    altitude: 0,
    timestamp,
  };
}

function makeHazard() {
  return {
    id: "hazard-1",
    lat: 49.82,
    lng: 18.26,
    hazard_type: "pothole" as const,
    severity: "medium" as const,
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: "rider-1",
    road_name: null,
    created_at: "2026-04-25T08:00:00.000Z",
    expires_at: "2026-04-26T08:00:00.000Z",
  };
}

describe("HazardReportScreen", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockGoBack.mockReset();
    mockAddHazard.mockReset();
    submitMock.mockReset();
    getLastLocationMock.mockReset();
    getCurrentLocationMock.mockReset();
    capturePhotoMock.mockReset();
    hapticTriggerMock.mockReset();
    mockRouteParams = undefined;
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    // Default: cache has a fresh fix and the on-mount one-shot returns
    // an even fresher one. Tests that exercise the Map-tab path (no
    // cached fix, async resolves later) override these.
    getLastLocationMock.mockReturnValue(makeLocation());
    getCurrentLocationMock.mockResolvedValue(makeLocation());
  });

  it("disables submit until a hazard type is selected", async () => {
    await render(<HazardReportScreen />);

    const submit = screen.getByLabelText("Submit hazard report");
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));

    expect(submit.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("submits live and dismisses with haptic confirmation", async () => {
    submitMock.mockResolvedValueOnce({
      status: "uploaded",
      hazard: makeHazard(),
      pending: 0,
    });

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));
    await fireEvent.press(screen.getByLabelText("High severity"));
    await fireEvent.changeText(
      screen.getByLabelText("Note"),
      "after the bridge",
    );
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith({
      lat: 49.82,
      lng: 18.26,
      hazardType: "pothole",
      severity: "high",
      note: "after the bridge",
      photoUri: undefined,
    });
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    expect(mockAddHazard).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hazard-1" }),
    );
    expect(hapticTriggerMock).toHaveBeenCalledWith(
      "notificationSuccess",
      expect.any(Object),
    );
  });

  it("closes the form when hazard_reporting is operator-disabled (deep-link entry)", async () => {
    // The FAB is hidden when off, but the deep-link / CarPlay-voice entry
    // opens this screen directly — a kill must close it.
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);

    await render(<HazardReportScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("does NOT submit when the switch is flipped off while the form is open", async () => {
    // Screen stays mounted (reactive flag still true this render) but the
    // synchronous re-read at submit time sees the kill — belt-and-braces.
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);

    await render(<HazardReportScreen />);
    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    expect(submitMock).not.toHaveBeenCalled();
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("queues offline reports and surfaces the offline alert to the rider", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    submitMock.mockResolvedValueOnce({ status: "queued", pending: 1 });

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Gravel"));
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    expect(alertSpy).toHaveBeenCalledWith(
      "Report queued",
      expect.stringContaining("offline"),
    );
    // Optimistic store update is skipped for queued reports — there's
    // no server-issued id to dedupe against later.
    expect(mockAddHazard).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("preselects a hazard type from route params (long-press quick-pick)", async () => {
    mockRouteParams = { preselectedType: "ice" };

    await render(<HazardReportScreen />);

    expect(
      screen.getByLabelText("Hazard type Ice").props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      screen.getByLabelText("Submit hazard report").props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it("surfaces an inline notice when camera permission is denied", async () => {
    capturePhotoMock.mockResolvedValueOnce({
      status: "permission-denied",
      source: "camera",
    });

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Take photo with camera"));

    expect(await screen.findByText(/camera access denied/i)).toBeTruthy();
    // No submit was attempted — the rider can still proceed without
    // a photo.
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("attaches a captured photo and includes its uri in the submit", async () => {
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      photo: { uri: "file:///tmp/photo.jpg", fileName: "photo.jpg" },
    });
    submitMock.mockResolvedValueOnce({
      status: "uploaded",
      hazard: makeHazard(),
      pending: 0,
    });

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Pick photo from library"));
    expect(await screen.findByText("photo.jpg")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Hazard type Roadworks"));
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        photoUri: "file:///tmp/photo.jpg",
        hazardType: "roadworks",
      }),
    );
  });

  it("acquires a fresh GPS fix when no cached location is available (Map tab path)", async () => {
    // Map-tab open: location service isn't running, so getLastLocation
    // returns null. The screen must call getCurrentLocation to land a
    // real fix before the rider can submit.
    getLastLocationMock.mockReturnValue(null);
    getCurrentLocationMock.mockResolvedValueOnce(makeLocation());
    submitMock.mockResolvedValueOnce({
      status: "uploaded",
      hazard: makeHazard(),
      pending: 0,
    });

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));

    // Submit becomes enabled only after the async fix resolves —
    // accessibilityState reflects the current canSubmit boolean.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit hazard report").props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
    expect(getCurrentLocationMock).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Submit hazard report"));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 49.82, lng: 18.26 }),
    );
  });

  it("blocks submit when the cached fix is stale until the rider refreshes", async () => {
    const stale = Date.now() - 60_000; // 60s ago — past the 30s threshold
    getLastLocationMock.mockReturnValue(makeLocation(stale));
    // Async refresh on mount also returns a stale fix (the GPS chip
    // hasn't seen movement yet); only the explicit Refresh tap pulls
    // a fresh one.
    getCurrentLocationMock.mockResolvedValueOnce(makeLocation(stale));
    getCurrentLocationMock.mockResolvedValueOnce(makeLocation());

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));

    // Stale fix → submit stays disabled even with a hazard type chosen.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit hazard report").props.accessibilityState,
      ).toMatchObject({ disabled: true }),
    );

    // Tapping Refresh pulls the fresh fix (mock #2) → submit enables.
    await fireEvent.press(screen.getByLabelText("Refresh location"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit hazard report").props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
  });

  it("recomputes staleness at submit time so an idle form can't slip through with old GPS", async () => {
    // Render-time isLocationStale boolean would be `false` (location is
    // fresh on mount), so canSubmit is true. We then advance the wall
    // clock past the 30s threshold WITHOUT triggering a re-render —
    // the only authoritative gate is the submit-time recompute.
    const realNow = Date.now;
    const baseTime = realNow.call(Date);
    getLastLocationMock.mockReturnValue(makeLocation(baseTime));
    getCurrentLocationMock.mockResolvedValueOnce(makeLocation(baseTime));

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Pothole"));
    // Wait for async on-mount fix to land so submit is enabled.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit hazard report").props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );

    // Advance the wall clock past the threshold; React doesn't
    // re-render so isLocationStale stays `false` in the captured
    // closure. The submit handler must re-check.
    Date.now = jest.fn(() => baseTime + 60_000);
    try {
      await fireEvent.press(screen.getByLabelText("Submit hazard report"));
      expect(await screen.findByText(/location is stale/i)).toBeTruthy();
      expect(submitMock).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it("shows an error banner if the API rejects the report", async () => {
    submitMock.mockRejectedValueOnce(new Error("Validation failed"));

    await render(<HazardReportScreen />);

    await fireEvent.press(screen.getByLabelText("Hazard type Other"));
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    expect(await screen.findByText("Couldn't submit the report.")).toBeTruthy();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("shows a clean daily-limit message on a hazard_reports_per_day 403", async () => {
    const { ApiError } = jest.requireMock("@/services/api") as {
      ApiError: new (m: string, s: number, b: unknown) => Error;
    };
    submitMock.mockRejectedValueOnce(
      new ApiError("Feature limit exceeded", 403, {
        code: "FEATURE_LIMIT_EXCEEDED",
        feature: "hazard_reports_per_day",
        limit: 50,
        current: 50,
      }),
    );
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    await render(<HazardReportScreen />);
    await fireEvent.press(screen.getByLabelText("Hazard type Other"));
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));

    // Friendly rate-limit copy, NOT the raw "Feature limit exceeded" string.
    expect(
      await screen.findByText(
        "You've reached today's hazard-report limit. Try again later.",
      ),
    ).toBeTruthy();
    expect(alertSpy).toHaveBeenCalledWith(
      "Daily limit reached",
      "You've reached today's hazard-report limit. Try again later.",
    );
    alertSpy.mockRestore();
  });

  it("reuses the already-uploaded photo URL when retrying after the daily cap", async () => {
    // Codex P2: the photo is uploaded before the cap 403; a retry must reuse
    // that URL rather than upload another orphan copy.
    const { ApiError } = jest.requireMock("@/services/api") as {
      ApiError: new (m: string, s: number, b: unknown) => Error;
    };
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      photo: { uri: "file:///tmp/photo.jpg", fileName: "photo.jpg" },
    });
    // First submit: cap-rejected, but the upload already happened and its URL
    // rides on the error.
    const capError = new ApiError("Feature limit exceeded", 403, {
      code: "FEATURE_LIMIT_EXCEEDED",
      feature: "hazard_reports_per_day",
    });
    (capError as { uploadedPhotoUrl?: string }).uploadedPhotoUrl =
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-1-abc.jpg";
    submitMock.mockRejectedValueOnce(capError);
    submitMock.mockResolvedValueOnce({
      status: "uploaded",
      hazard: makeHazard(),
      pending: 0,
    });
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    await render(<HazardReportScreen />);
    await fireEvent.press(screen.getByLabelText("Pick photo from library"));
    expect(await screen.findByText("photo.jpg")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Hazard type Roadworks"));

    // First (cap-rejected) submit.
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));

    // Retry — must carry the cached remote URL and NOT re-upload.
    await fireEvent.press(screen.getByLabelText("Submit hazard report"));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        photoUrl:
          "https://app.tarmoto.test/uploads/hazard-photos/user-1-1-abc.jpg",
      }),
    );
    alertSpy.mockRestore();
  });
});
