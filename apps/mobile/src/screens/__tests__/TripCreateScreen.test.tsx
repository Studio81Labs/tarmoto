/**
 * #M3 — TripCreateScreen's reactive `max_active_trips` safety net.
 *
 * TripsScreen's FAB is the proactive gate (see TripsScreen.test.tsx), but
 * a revoke between that snapshot check and this screen's request landing
 * (or a rider who deep-links straight here) still needs to reach the
 * backend's `POST /trips` / `/trips/:id/generate` / `/trips/import`. Both
 * `handleGenerate` and `handleImport` must recognize the 403
 * `FEATURE_LIMIT_EXCEEDED` body and open the same upsell instead of the
 * generic error banner + alert.
 */
import React from "react";
import { Alert } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import type { ImportedRoute } from "@tarmoto/shared";

const mockReplace = jest.fn();
const mockGoBack = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ replace: mockReplace, goBack: mockGoBack }),
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

jest.mock("@/services/tripDraftCleanup", () => ({
  reconcileTripDraftCleanup: jest.fn(),
}));

jest.mock("@/services/api", () => ({
  api: {
    createTrip: jest.fn(),
    generateTripRoute: jest.fn(),
    importTripFromRoute: jest.fn(),
    deleteTrip: jest.fn().mockResolvedValue(undefined),
    getAuthenticatedUserId: jest.fn(() => "u1"),
  },
  // Mirrors the real `ApiError` shape (status + body) closely enough for
  // `instanceof` checks in the screen's catch blocks to hold.
  ApiError: class ApiError extends Error {
    readonly localizedUserMessage = true as const;
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

jest.mock("@/services/tripImport", () => ({
  pickAndParseRoute: jest.fn(),
  routeToImportRequest: jest.fn(),
}));

// The reactive limit-403 net fires a fire-and-forget entitlement refresh —
// stub it so the tests don't need the full auth/api refresh wiring.
jest.mock("@/services/entitlementsRefresh", () => ({
  refreshEntitlementsNow: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

import TripCreateScreen from "../TripCreateScreen";
import { ApiError, api } from "@/services/api";
import { pickAndParseRoute, routeToImportRequest } from "@/services/tripImport";
import { refreshEntitlementsNow } from "@/services/entitlementsRefresh";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { reconcileTripDraftCleanup } from "@/services/tripDraftCleanup";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";

const mockedApi = api as jest.Mocked<typeof api>;
const mockedPickAndParseRoute = pickAndParseRoute as jest.MockedFunction<
  typeof pickAndParseRoute
>;
const mockedRouteToImportRequest = routeToImportRequest as jest.MockedFunction<
  typeof routeToImportRequest
>;

function limitExceededError(limit = 1): ApiError {
  return new ApiError("Feature limit exceeded", 403, {
    statusCode: 403,
    error: "Forbidden",
    message: `Feature limit exceeded: max_active_trips (limit ${limit}, current ${limit})`,
    code: FEATURE_LIMIT_EXCEEDED,
    feature: "max_active_trips",
    limit,
    current: limit,
  });
}

describe("TripCreateScreen reactive max_active_trips safety net (#M3)", () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps the factory impl but a prior mockReturnValue leaks —
    // re-assert the fail-SAFE default each test.
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  });

  afterEach(() => alertSpy.mockRestore());

  it("opens the upgrade prompt (not the generic error alert) when Generate hits a 403 FEATURE_LIMIT_EXCEEDED", async () => {
    mockedApi.createTrip.mockRejectedValueOnce(limitExceededError(1));

    await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });

    expect(screen.getByText("Upgrade required")).toBeTruthy();
    expect(
      screen.getByText("Free riders can keep 1 active trip. Upgrade for more."),
    ).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    // The generic failure path must NOT also fire — this is a distinct
    // branch, not a fallback on top of it.
    expect(alertSpy).not.toHaveBeenCalledWith(
      "Generation failed",
      expect.anything(),
    );
    expect(screen.queryByText(/Unable to generate trip/)).toBeNull();
  });

  it("shows a retryable error (not the stale-tier prompt) when the tier refresh fails on a Generate 403", async () => {
    // The 403 fires, but the follow-up tier refresh FAILS. Opening the limit
    // prompt now would derive its copy from a possibly-stale snapshot — the
    // dead-end the refresh exists to prevent — so we surface a retryable error
    // and NO prompt instead.
    (
      refreshEntitlementsNow as jest.MockedFunction<
        typeof refreshEntitlementsNow
      >
    ).mockResolvedValueOnce(false);
    mockedApi.createTrip.mockRejectedValueOnce(limitExceededError(1));

    await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });

    expect(
      screen.getByText(
        "Couldn't verify your plan. Check your connection and try again.",
      ),
    ).toBeTruthy();
    // No prompt built from the unverified tier.
    expect(screen.queryByText("Upgrade required")).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("opens the upgrade prompt when Import hits a 403 FEATURE_LIMIT_EXCEEDED", async () => {
    mockedPickAndParseRoute.mockResolvedValueOnce({
      ok: true,
      route: { name: "Imported route" } as unknown as ImportedRoute,
      filename: "route.gpx",
    });
    mockedRouteToImportRequest.mockReturnValueOnce({
      title: "Imported route",
      source_format: "gpx",
      geometry: [
        { lat: 49.2, lng: 16.6 },
        { lat: 49.21, lng: 16.61 },
      ],
    });
    mockedApi.importTripFromRoute.mockRejectedValueOnce(limitExceededError(1));

    await render(<TripCreateScreen />);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Import GPX or KML file"));
    });

    expect(screen.getByText("Upgrade required")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalledWith(
      "Import failed",
      expect.anything(),
    );
  });

  it("still shows the generic error alert for a non-limit failure (unchanged behavior)", async () => {
    mockedApi.createTrip.mockRejectedValueOnce(
      new ApiError("The server is temporarily unavailable.", 500, {
        message: "boom",
      }),
    );

    await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });

    expect(screen.queryByText("Upgrade required")).toBeNull();
    expect(alertSpy).toHaveBeenCalledWith(
      "Generation failed",
      "The server is temporarily unavailable.",
    );
  });

  it("hides the Import button when gpx_import is operator-disabled", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "gpx_import",
    );

    await render(<TripCreateScreen />);

    expect(screen.queryByLabelText("Import GPX or KML file")).toBeNull();
  });

  it("does NOT open the picker if gpx_import is killed between render and tap", async () => {
    // Button still shown this render (reactive flag true), but the synchronous
    // guard sees the kill — the picker/POST must not fire.
    (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "gpx_import",
    );

    await render(<TripCreateScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Import GPX or KML file"));
    });

    expect(mockedPickAndParseRoute).not.toHaveBeenCalled();
  });

  it("does NOT POST if gpx_import is killed AFTER the picker resolves", async () => {
    // Entry guard passed, picker returned a parsed route, THEN the operator
    // flips gpx_import off — the pre-POST recheck must abort the import.
    mockedPickAndParseRoute.mockImplementationOnce(async () => {
      // Simulate the switch flipping off while the picker promise was pending.
      (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
        (key: string) => key !== "gpx_import",
      );
      return {
        ok: true,
        route: { name: "Imported route" } as unknown as ImportedRoute,
        filename: "route.gpx",
      };
    });

    await render(<TripCreateScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Import GPX or KML file"));
    });

    expect(mockedPickAndParseRoute).toHaveBeenCalledTimes(1);
    expect(mockedApi.importTripFromRoute).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("closes the screen when trip_planning is operator-disabled", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "trip_planning",
    );

    await render(<TripCreateScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("does NOT createTrip when trip_planning is killed while the form is open", async () => {
    // Screen still mounted (reactive flag true this render), but the sync guard
    // in handleGenerate sees the kill.
    (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "trip_planning",
    );

    await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });

    expect(mockedApi.createTrip).not.toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("cleans up the draft and skips route generation if trip_planning flips off after createTrip", async () => {
    // Mid-flight: the initial guard passed and createTrip persisted a draft,
    // THEN the operator kills the planner. The second write must not fire, and
    // the orphaned draft (draftTripId is lost when the screen pops) must be
    // deleted so it doesn't consume a max_active_trips slot.
    mockedApi.createTrip.mockImplementationOnce(async () => {
      (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
        (key: string) => key !== "trip_planning",
      );
      return { id: "trip-1" } as never;
    });

    await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });

    expect(mockedApi.createTrip).toHaveBeenCalledTimes(1);
    expect(mockedApi.generateTripRoute).not.toHaveBeenCalled();
    // The persisted draft is routed through the reconciler (which retries a
    // failed delete via the foreground drain) rather than orphaned.
    expect(reconcileTripDraftCleanup).toHaveBeenCalledWith("trip-1", "u1");
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("reconciles a HELD draft when trip_planning is killed after a failed generation", async () => {
    // createTrip succeeds but generateTripRoute fails → draftTripId is retained
    // for retry. If the planner is then killed, the navigate-back effect pops
    // the screen and would lose that component-local id — it must reconcile the
    // held draft first so it doesn't orphan.
    mockedApi.createTrip.mockResolvedValueOnce({ id: "trip-1" } as never);
    mockedApi.generateTripRoute.mockRejectedValueOnce(
      new Error("route engine down"),
    );

    const { rerender } = await render(<TripCreateScreen />);
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText("e.g. Beskydy weekend"),
        "Alps loop",
      );
    });
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Generate trip"));
    });
    // Draft held (create ok, generate failed).
    expect(mockedApi.createTrip).toHaveBeenCalledTimes(1);
    expect(mockedApi.generateTripRoute).toHaveBeenCalledTimes(1);
    (reconcileTripDraftCleanup as jest.Mock).mockClear();

    // Operator kills the planner → the navigate-back effect reconciles the held
    // draft before popping.
    (useFeatureKillSwitchActive as jest.Mock).mockImplementation(
      (key: string) => key !== "trip_planning",
    );
    await act(async () => rerender(<TripCreateScreen />));

    expect(reconcileTripDraftCleanup).toHaveBeenCalledWith("trip-1", "u1");
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("does NOT importTripFromRoute if trip_planning flips off during the picker", async () => {
    // Importing also creates a trip, so the pre-POST recheck must cover
    // trip_planning too (not just gpx_import).
    mockedPickAndParseRoute.mockImplementationOnce(async () => {
      (isFeatureKillSwitchActive as jest.Mock).mockImplementation(
        (key: string) => key !== "trip_planning",
      );
      return {
        ok: true,
        route: { name: "Imported route" } as unknown as ImportedRoute,
        filename: "route.gpx",
      };
    });

    await render(<TripCreateScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Import GPX or KML file"));
    });

    expect(mockedApi.importTripFromRoute).not.toHaveBeenCalled();
  });
});
