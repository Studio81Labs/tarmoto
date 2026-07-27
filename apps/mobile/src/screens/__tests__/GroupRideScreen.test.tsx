import React from "react";
import { Alert } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import GroupRideScreen from "../GroupRideScreen";
import { api } from "@/services/api";
import {
  groupRideSocket,
  type GroupRideSocketHandlers,
} from "@/services/groupRideSocket";
import type { GroupRideDetail } from "@/types";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

let mockTranslate = (message: string, values?: Record<string, unknown>) =>
  values
    ? message.replace(
        "{value0}",
        typeof values.value0 === "string" ? values.value0 : "",
      )
    : message;

jest.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => mockTranslate,
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

jest.mock("@maplibre/maplibre-react-native", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactLib.createElement(ReactLib.Fragment, null, children);
  return {
    Camera: () => null,
    GeoJSONSource: Passthrough,
    Layer: () => null,
    Map: Passthrough,
  };
});

jest.mock("@/services/api", () => ({
  api: {
    createGroupRide: jest.fn(),
    getGroupRide: jest.fn(),
    joinGroupRide: jest.fn(),
    leaveGroupRide: jest.fn(),
    endGroupRide: jest.fn(),
  },
}));

jest.mock("@/services/groupRideSocket", () => ({
  groupRideSocket: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    publishPosition: jest.fn(),
  },
}));

jest.mock("@/stores", () => ({
  // Entitled snapshot (features + limits present) so the #M2 group_rides gate
  // resolves and renders the create/join UI these active-mode tests exercise —
  // without the slices the gate would fail closed to a spinner.
  useAuthStore: (
    selector: (state: {
      user: {
        id: string;
        subscription_tier: string;
        features: Record<string, boolean>;
        limits: Record<string, unknown>;
      };
    }) => unknown,
  ) =>
    selector({
      user: {
        id: "rider-1",
        subscription_tier: "premium",
        features: { group_rides: true },
        limits: {},
      },
    }),
  useRideStore: (
    selector: (state: { location: null; isRiding: boolean }) => unknown,
  ) => selector({ location: null, isRiding: false }),
}));

const groupRide: GroupRideDetail = {
  id: "group-ride-1",
  owner_id: "rider-1",
  name: "Sunday ride",
  code: "ABCDEF",
  started_at: "2026-07-27T12:00:00.000Z",
  ended_at: null,
  members: [],
};

describe("GroupRideScreen", () => {
  const createGroupRideMock = api.createGroupRide as jest.MockedFunction<
    typeof api.createGroupRide
  >;
  const getGroupRideMock = api.getGroupRide as jest.MockedFunction<
    typeof api.getGroupRide
  >;
  const connectMock = groupRideSocket.connect as jest.MockedFunction<
    typeof groupRideSocket.connect
  >;
  const disconnectMock = groupRideSocket.disconnect as jest.MockedFunction<
    typeof groupRideSocket.disconnect
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTranslate = (message, values) =>
      values
        ? message.replace(
            "{value0}",
            typeof values.value0 === "string" ? values.value0 : "",
          )
        : message;
    createGroupRideMock.mockResolvedValue(groupRide);
    getGroupRideMock.mockResolvedValue(groupRide);
  });

  it("keeps the live socket connected across locale changes and uses the latest translator", async () => {
    let handlers: GroupRideSocketHandlers | undefined;
    connectMock.mockImplementation((_groupRideId, nextHandlers) => {
      handlers = nextHandlers;
    });

    const view = await render(<GroupRideScreen />);
    await fireEvent.changeText(
      screen.getByPlaceholderText("e.g. Sunday Dolomites"),
      "Sunday ride",
    );
    await fireEvent.press(screen.getByText("Create"));

    await waitFor(() =>
      expect(connectMock).toHaveBeenCalledWith(
        groupRide.id,
        expect.any(Object),
      ),
    );
    expect(disconnectMock).not.toHaveBeenCalled();

    mockTranslate = (message, values) =>
      `sv:${values?.value0 ? message.replace("{value0}", String(values.value0)) : message}`;
    await view.rerender(<GroupRideScreen />);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).not.toHaveBeenCalled();

    await act(async () => {
      handlers?.onJoined({
        group_ride_id: groupRide.id,
        user_id: "rider-2",
        display_name: "Ada",
        at: "2026-07-27T12:01:00.000Z",
      });
    });

    expect(alertSpy).toHaveBeenCalledWith("sv:Group ride", "sv:Ada joined.");
  });
});
