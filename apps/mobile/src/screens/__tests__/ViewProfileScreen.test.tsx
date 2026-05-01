/**
 * ViewProfileScreen — US-27 read-only profile + optimistic follow.
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

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockSetOptions = jest.fn();
const routeParams = { userId: "user-2" };

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    push: mockPush,
    setOptions: mockSetOptions,
  }),
  useRoute: () => ({ params: routeParams }),
}));

jest.mock("@/services/api", () => ({
  api: {
    getPublicProfile: jest.fn(),
    listUserBadges: jest.fn(),
    followUser: jest.fn(),
    unfollowUser: jest.fn(),
  },
  // The screen narrows caught errors with `err instanceof ApiError`; the
  // mock must expose a real constructor so the instanceof check doesn't
  // throw "right-hand side is not callable" on plain `Error` rejections.
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

import ViewProfileScreen from "../ViewProfileScreen";
import { api } from "@/services/api";

const mockedApi = api as jest.Mocked<typeof api>;

function buildProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-2",
    display_name: "Other Rider",
    avatar_url: null,
    bio: "Mountains and curves",
    home_region: "Slovakia",
    created_at: "2024-04-01T10:00:00.000Z",
    follower_count: 3,
    following_count: 1,
    is_following: false,
    is_self: false,
    ...overrides,
  };
}

describe("ViewProfileScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.getPublicProfile.mockResolvedValue(buildProfile());
    mockedApi.listUserBadges.mockResolvedValue([]);
  });

  it("renders the rider profile after fetch", async () => {
    render(<ViewProfileScreen />);

    await waitFor(() =>
      expect(mockedApi.getPublicProfile).toHaveBeenCalledWith("user-2"),
    );
    expect(await screen.findByText("Other Rider")).toBeTruthy();
    expect(screen.getByText("Mountains and curves")).toBeTruthy();
    expect(screen.getByText("Slovakia")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByLabelText("Follow rider")).toBeTruthy();
  });

  it("optimistically toggles to Following and bumps the follower count, then resolves", async () => {
    let resolveFollow: () => void;
    mockedApi.followUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFollow = resolve;
        }),
    );

    render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Follow rider"));
    });

    // Optimistic: button reads "Following", count is 4.
    expect(screen.getByLabelText("Unfollow rider")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(mockedApi.followUser).toHaveBeenCalledWith("user-2");

    await act(async () => {
      resolveFollow!();
      await Promise.resolve();
    });
    // Still "Following" — settled.
    expect(screen.getByLabelText("Unfollow rider")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("optimistically toggles to Follow and decrements the count when unfollowing", async () => {
    mockedApi.getPublicProfile.mockResolvedValue(
      buildProfile({ is_following: true, follower_count: 5 }),
    );
    mockedApi.unfollowUser.mockResolvedValue();

    render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Unfollow rider"));
    });

    expect(mockedApi.unfollowUser).toHaveBeenCalledWith("user-2");
    expect(await screen.findByLabelText("Follow rider")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("reverts the optimistic follow state when the request fails", async () => {
    mockedApi.followUser.mockRejectedValue(new Error("server died"));

    render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Follow rider"));
    });

    // Reverted: still "Follow", count back to 3.
    expect(await screen.findByLabelText("Follow rider")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(await screen.findByText("server died")).toBeTruthy();
  });

  it("hides the follow button when viewing your own profile", async () => {
    mockedApi.getPublicProfile.mockResolvedValue(
      buildProfile({ is_self: true, is_following: null }),
    );
    render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await screen.findByText("Other Rider");
    expect(screen.queryByLabelText("Follow rider")).toBeNull();
    expect(screen.queryByLabelText("Unfollow rider")).toBeNull();
  });

  it("opens followers / following lists from the stat tiles", async () => {
    render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await screen.findByText("Other Rider");

    fireEvent.press(screen.getByLabelText("3 followers, open list"));
    expect(mockPush).toHaveBeenCalledWith("Followers", {
      userId: "user-2",
      displayName: "Other Rider",
    });

    fireEvent.press(screen.getByLabelText("Following 1 riders, open list"));
    expect(mockPush).toHaveBeenCalledWith("Following", {
      userId: "user-2",
      displayName: "Other Rider",
    });
  });
});
