/**
 * FollowersScreen — US-27 list rendering + tap-to-profile.
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

const mockPush = jest.fn();
const mockGoBack = jest.fn();
const routeParams = { userId: "user-2", displayName: "Other Rider" };

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ push: mockPush, goBack: mockGoBack }),
  useRoute: () => ({ params: routeParams }),
}));

jest.mock("@/services/api", () => ({
  api: {
    listFollowers: jest.fn(),
    listFollowing: jest.fn(),
  },
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

import FollowersScreen from "../FollowersScreen";
import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

const mockedApi = api as jest.Mocked<typeof api>;

describe("FollowersScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
  });

  it("renders followers and navigates to a tapped profile", async () => {
    mockedApi.listFollowers.mockResolvedValue([
      {
        user_id: "user-3",
        display_name: "Jane Rider",
        followed_at: "2026-01-15T10:00:00.000Z",
      },
      {
        user_id: "user-4",
        display_name: "John Rider",
        followed_at: "2025-11-02T10:00:00.000Z",
      },
    ]);

    await render(<FollowersScreen />);

    expect(await screen.findByText("Jane Rider")).toBeTruthy();
    expect(screen.getByText("John Rider")).toBeTruthy();
    expect(mockedApi.listFollowers).toHaveBeenCalledWith("user-2");

    await fireEvent.press(screen.getByLabelText("Open Jane Rider's profile"));
    expect(mockPush).toHaveBeenCalledWith("ViewProfile", {
      userId: "user-3",
    });
  });

  it("shows an empty state when there are no followers", async () => {
    mockedApi.listFollowers.mockResolvedValue([]);

    await render(<FollowersScreen />);

    expect(
      await screen.findByText("Other Rider has no followers yet."),
    ).toBeTruthy();
  });

  it("surfaces a load error and offers retry", async () => {
    mockedApi.listFollowers.mockRejectedValueOnce(new Error("offline"));

    await render(<FollowersScreen />);

    expect(await screen.findByText("Could not load list.")).toBeTruthy();

    mockedApi.listFollowers.mockResolvedValueOnce([
      {
        user_id: "user-3",
        display_name: "Jane Rider",
        followed_at: "2026-01-15T10:00:00.000Z",
      },
    ]);

    await fireEvent.press(screen.getByText("Retry"));
    await waitFor(() =>
      expect(mockedApi.listFollowers).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("Jane Rider")).toBeTruthy();
  });

  it("closes the list AND fires no community read when community_access is operator-disabled", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    mockedApi.listFollowers.mockResolvedValue([]);

    await render(<FollowersScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    // The list bounces without ever issuing the follower-graph read.
    expect(mockedApi.listFollowers).not.toHaveBeenCalled();
  });
});
