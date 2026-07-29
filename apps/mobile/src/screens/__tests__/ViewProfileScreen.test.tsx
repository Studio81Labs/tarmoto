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

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockSetOptions = jest.fn();
const mockGoBack = jest.fn();
const routeParams = { userId: "user-2" };

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    push: mockPush,
    setOptions: mockSetOptions,
    goBack: mockGoBack,
  }),
  useRoute: () => ({ params: routeParams }),
  // Mirrors the real useFocusEffect: run the callback on mount and
  // whenever its identity changes. SharedRidesSection (rendered inside
  // ViewProfileScreen) relies on it for its initial fetch.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactLib = require("react");
    ReactLib.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === "function" ? cleanup : undefined;
    }, [cb]);
  },
}));

jest.mock("@/services/api", () => ({
  api: {
    getPublicProfile: jest.fn(),
    listUserBadges: jest.fn(),
    listUserSharedRides: jest.fn(),
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
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

import ViewProfileScreen from "../ViewProfileScreen";
import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

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
    total_distance_km: 4200,
    shared_ride_count: 2,
    is_following: false,
    follows_you: false,
    is_self: false,
    ...overrides,
  };
}

describe("ViewProfileScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    mockedApi.getPublicProfile.mockResolvedValue(buildProfile());
    mockedApi.listUserBadges.mockResolvedValue([]);
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      total_views: 0,
      limit: 5,
      offset: 0,
    });
  });

  it("renders the rider profile after fetch", async () => {
    await render(<ViewProfileScreen />);

    await waitFor(() =>
      expect(mockedApi.getPublicProfile).toHaveBeenCalledWith("user-2"),
    );
    expect(await screen.findByText("Other Rider")).toBeTruthy();
    expect(screen.getByText("Mountains and curves")).toBeTruthy();
    expect(screen.getByText("Slovakia")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByLabelText("Follow rider")).toBeTruthy();
    // No incoming follow on the default fixture → no badge.
    expect(screen.queryByText("Follows you")).toBeNull();
  });

  it("shows the 'Follows you' badge when the rider follows the viewer back", async () => {
    mockedApi.getPublicProfile.mockResolvedValue(
      buildProfile({ follows_you: true }),
    );

    await render(<ViewProfileScreen />);

    expect(await screen.findByText("Other Rider")).toBeTruthy();
    expect(screen.getByText("Follows you")).toBeTruthy();
  });

  it("optimistically toggles to Following and bumps the follower count, then resolves", async () => {
    let resolveFollow: () => void;
    mockedApi.followUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFollow = resolve;
        }),
    );

    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Follow rider"));
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

    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Unfollow rider"));
    });

    expect(mockedApi.unfollowUser).toHaveBeenCalledWith("user-2");
    expect(await screen.findByLabelText("Follow rider")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("reverts the optimistic follow state when the request fails", async () => {
    mockedApi.followUser.mockRejectedValue(new Error("server died"));

    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Follow rider"));
    });

    // Reverted: still "Follow", count back to 3.
    expect(await screen.findByLabelText("Follow rider")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(await screen.findByText("Could not update follow.")).toBeTruthy();
  });

  it("hides the follow button when viewing your own profile", async () => {
    mockedApi.getPublicProfile.mockResolvedValue(
      buildProfile({ is_self: true, is_following: null }),
    );
    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await screen.findByText("Other Rider");
    expect(screen.queryByLabelText("Follow rider")).toBeNull();
    expect(screen.queryByLabelText("Unfollow rider")).toBeNull();
  });

  it("opens followers / following lists from the stat tiles", async () => {
    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await screen.findByText("Other Rider");

    await fireEvent.press(screen.getByLabelText("3 followers, open list"));
    expect(mockPush).toHaveBeenCalledWith("Followers", {
      userId: "user-2",
      displayName: "Other Rider",
    });

    await fireEvent.press(
      screen.getByLabelText("Following 1 rider, open list"),
    );
    expect(mockPush).toHaveBeenCalledWith("Following", {
      userId: "user-2",
      displayName: "Other Rider",
    });
  });

  it("closes AND fires no community read when community_access is operator-disabled", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);

    await render(<ViewProfileScreen />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
    // The profile bounces without issuing the community reads.
    expect(mockedApi.getPublicProfile).not.toHaveBeenCalled();
    expect(mockedApi.listUserBadges).not.toHaveBeenCalled();
  });

  it("does not re-read on Retry once community_access is killed mid-error", async () => {
    // Load fails (community on) → error + Retry. Operator then kills the switch;
    // Retry calls fetchProfile directly — the choke-point guard must block it.
    mockedApi.getPublicProfile.mockReset();
    mockedApi.getPublicProfile.mockRejectedValueOnce(new Error("offline"));

    await render(<ViewProfileScreen />);
    await waitFor(() =>
      expect(mockedApi.getPublicProfile).toHaveBeenCalledTimes(1),
    );
    const retry = await screen.findByLabelText("Retry loading profile");

    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    await fireEvent.press(retry);

    // No second community read.
    expect(mockedApi.getPublicProfile).toHaveBeenCalledTimes(1);
  });

  it("does NOT follow/unfollow if community_access is killed at tap time", async () => {
    // Load with the switch ON (profile renders, follow button appears)...
    await render(<ViewProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await screen.findByText("Other Rider");

    // ...then the operator kills the switch exactly as the rider taps Follow.
    (isFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    await fireEvent.press(screen.getByLabelText("Follow rider"));

    expect(mockedApi.followUser).not.toHaveBeenCalled();
  });
});
