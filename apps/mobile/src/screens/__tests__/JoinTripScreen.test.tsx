/**
 * JoinTripScreen — US-8 join-by-code 403 handling.
 *
 * The trip owner's `max_trip_collaborators` cap is enforced server-side on
 * join. The cap belongs to the owner and is invisible to the joiner, so
 * there is no proactive gate here — only graceful 403 handling that swaps
 * in an owner-cap message instead of the generic API error text.
 */
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";

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
const routeParams = { tripId: "trip-1", inviteCode: "TARMOTO-42" };

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ replace: mockReplace }),
  useRoute: () => ({ params: routeParams }),
}));

jest.mock("@/services/api", () => ({
  api: {
    joinTrip: jest.fn(),
  },
  // The screen narrows the owner collaborator-cap 403 with
  // `isFeatureLimitError`, which does `err instanceof ApiError`; the mock
  // must expose a real constructor so `instanceof` doesn't throw. It also
  // mirrors the real `localizedUserMessage` flag so the generic (non-limit)
  // path exercises the real `getUserFacingErrorMessage` behaviour of
  // surfacing `error.message` instead of the translated fallback.
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

const mockedApi = api as jest.Mocked<typeof api>;

describe("JoinTripScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the owner collaborator-cap message on a FEATURE_LIMIT_EXCEEDED 403", async () => {
    mockedApi.joinTrip.mockRejectedValueOnce(
      new ApiError("Feature limit exceeded", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_trip_collaborators",
        limit: 5,
        current: 5,
      }),
    );

    await render(<JoinTripScreen />);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "The trip owner has reached their collaborator limit.",
        ),
      ).toBeTruthy(),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("shows the generic error message for a non-limit error", async () => {
    mockedApi.joinTrip.mockRejectedValueOnce(
      new ApiError("Trip not found", 404, { message: "Trip not found" }),
    );

    await render(<JoinTripScreen />);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Join trip"));
    });

    await waitFor(() =>
      expect(screen.getByText("Trip not found")).toBeTruthy(),
    );
    expect(
      screen.queryByText(
        "The trip owner has reached their collaborator limit.",
      ),
    ).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
