/**
 * JoinTripScreen — US-8 join-by-code error handling.
 *
 * This screen consumes an already-reserved personal invite via
 * `POST /trips/:tripId/join`, which enforces no collaborator cap (the
 * owner's `max_trip_collaborators` cap is checked at invite CREATION and
 * on the public share-link join, neither of which this screen calls). So
 * there is nothing tier-specific to handle here — a bad/revoked code is a
 * plain 403 surfaced through the generic error path.
 */
import React from "react";
import {
  act,
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

const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const routeParams = { tripId: "trip-1", inviteCode: "TARMOTO-42" };

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ replace: mockReplace, goBack: mockGoBack }),
  useRoute: () => ({ params: routeParams }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/api", () => ({
  api: {
    joinTrip: jest.fn(),
  },
  // `getUserFacingErrorMessage` surfaces `error.message` when the error
  // carries `localizedUserMessage`; mirror that flag so the generic path
  // exercises the real behaviour.
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

import JoinTripScreen from "../JoinTripScreen";
import { ApiError, api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

const mockedApi = api as jest.Mocked<typeof api>;

describe("JoinTripScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
  });

  it("shows the generic error message when the join fails", async () => {
    mockedApi.joinTrip.mockRejectedValueOnce(
      new ApiError("Invalid trip or invite code", 403, {
        message: "Invalid trip or invite code",
      }),
    );

    await render(<JoinTripScreen />);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    await waitFor(() =>
      expect(screen.getByText("Invalid trip or invite code")).toBeTruthy(),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("navigates to the trip on a successful join", async () => {
    mockedApi.joinTrip.mockResolvedValueOnce(undefined);

    await render(<JoinTripScreen />);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith("TripDetail", {
        tripId: "trip-1",
      }),
    );
  });

  it("closes when trip_planning is operator-disabled (deep-link entry)", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);

    await render(<JoinTripScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("does NOT join when trip_planning is killed while the form is open", async () => {
    // Screen still mounted (reactive flag true), but the sync guard blocks join.
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);

    await render(<JoinTripScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    expect(mockedApi.joinTrip).not.toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("keeps the join but suppresses navigation when trip_planning is killed mid-request", async () => {
    // Kill lands WHILE joinTrip is awaiting: the join succeeded (rider is now a
    // member), so don't navigate to TripDetail; the reactive teardown effect
    // bounces to the trips list once `submitting` clears.
    mockedApi.joinTrip.mockImplementationOnce(async () => {
      (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      return undefined;
    });

    const { rerender } = await render(<JoinTripScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    expect(mockedApi.joinTrip).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    await act(async () => rerender(<JoinTripScreen />));
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });
});
