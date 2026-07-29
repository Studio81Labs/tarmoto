/**
 * ProfileScreen — US-27 own-profile coverage.
 *
 * Drives the screen's network calls through `@/services/api` mocks and the
 * auth store through `@/stores` mocks; we don't exercise actual axios.
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
const mockSetOptions = jest.fn();

jest.mock("@react-navigation/native", () => ({
  // useFocusEffect runs its callback on mount in real react-navigation,
  // mirror that with React's effect so the screen's data fetch fires.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactLib = require("react");
    // Run on mount only — that's enough for the screen's data fetch
    // path. Skipping `cb` from the deps list is intentional, mirrors
    // how the real `useFocusEffect` is invoked once per focus event.
    ReactLib.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === "function" ? cleanup : undefined;
    }, []); // eslint-disable-line
  },
  useNavigation: () => ({
    navigate: mockNavigate,
    setOptions: mockSetOptions,
  }),
}));

const mockSetUser = jest.fn();
const mockApplyProfileUpdate = jest.fn();
const mockLogout = jest.fn();
const mockAuthState: {
  user: {
    id: string;
    email: string;
    display_name: string;
    avatar_url?: string | null;
    bio?: string | null;
    home_region?: string | null;
    preferences: Record<string, unknown>;
    created_at: string;
  } | null;
} = {
  user: {
    id: "user-1",
    email: "rider@tarmoto.app",
    display_name: "Rider One",
    avatar_url: null,
    bio: null,
    home_region: null,
    preferences: { units: "metric" },
    created_at: "2025-04-01T10:00:00.000Z",
  },
};

jest.mock("@/stores", () => {
  const snapshot = () => ({
    user: mockAuthState.user,
    setUser: mockSetUser,
    applyProfileUpdate: mockApplyProfileUpdate,
    logout: mockLogout,
  });
  const useAuthStore = (selector: (state: unknown) => unknown) =>
    selector(snapshot());
  // The avatar-rollback path reads the live store via getState().
  useAuthStore.getState = snapshot;
  return { useAuthStore };
});

jest.mock("@/services/api", () => ({
  api: {
    getPublicProfile: jest.fn(),
    getMyProfile: jest.fn(),
    listUserBadges: jest.fn(),
    listUserSharedRides: jest.fn(),
    uploadAvatar: jest.fn(),
    logout: jest.fn(),
  },
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

jest.mock("@/services/photoCapture", () => ({
  capturePhoto: jest.fn(),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

import ProfileScreen from "../ProfileScreen";
import { api } from "@/services/api";
import { capturePhoto } from "@/services/photoCapture";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

const mockedApi = api as jest.Mocked<typeof api>;
const mockedCapture = capturePhoto as jest.MockedFunction<typeof capturePhoto>;

describe("ProfileScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    mockAuthState.user = {
      id: "user-1",
      email: "rider@tarmoto.app",
      display_name: "Rider One",
      avatar_url: null,
      bio: null,
      home_region: null,
      preferences: { units: "metric" },
      created_at: "2025-04-01T10:00:00.000Z",
    };
    mockedApi.getPublicProfile.mockResolvedValue({
      id: "user-1",
      display_name: "Rider One",
      avatar_url: null,
      bio: "Weekend rider",
      home_region: "Beskydy",
      created_at: "2025-04-01T10:00:00.000Z",
      follower_count: 12,
      following_count: 7,
      total_distance_km: 1234,
      shared_ride_count: 3,
      is_following: null,
      follows_you: null,
      is_self: true,
    });
    mockedApi.listUserBadges.mockResolvedValue([
      {
        key: "total_distance",
        category: "explore",
        tier: "bronze",
        earned_at: "2025-12-01T10:00:00.000Z",
        progress: { current: 1, bronze: 1, silver: 5, gold: 10 },
      },
    ]);
    mockedApi.getMyProfile.mockResolvedValue({
      joined_at: "2025-04-01T10:00:00.000Z",
      total_hours: 42.5,
      total_rides: 18,
      total_distance_km: 1234.5,
      roads_discovered: 73,
      hazards_reported: 6,
      follower_count: 12,
      following_count: 7,
      badges_earned: 1,
    });
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      total_views: 0,
      limit: 5,
      offset: 0,
    });
  });

  it("renders the rider's display name and follower/following counts after fetch", async () => {
    await render(<ProfileScreen />);

    await waitFor(() => {
      expect(mockedApi.getPublicProfile).toHaveBeenCalledWith("user-1");
    });
    expect(await screen.findByText("Rider One")).toBeTruthy();
    expect(screen.getByText("Weekend rider")).toBeTruthy();
    expect(screen.getByText("Beskydy")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    // 1 earned badge in fixture
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("renders riding totals from the me-profile summary (#334)", async () => {
    await render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockedApi.getMyProfile).toHaveBeenCalledTimes(1),
    );
    // Compact "X km · Yh · N rides" line. Distance is rounded to whole km
    // and `total_hours` is rounded to whole hours so the meta line stays
    // dense. Stat values come from the fixture in `beforeEach`.
    expect(await screen.findByText("1,235 km · 43h · 18 rides")).toBeTruthy();
  });

  it("falls back gracefully when the me-profile call fails", async () => {
    mockedApi.getMyProfile.mockRejectedValueOnce(new Error("offline"));

    await render(<ProfileScreen />);

    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    // The header still renders the public-profile fields even if the
    // summary endpoint is unreachable — the screen does not surface an
    // error banner for the missing summary, the riding stat line just
    // disappears.
    expect(await screen.findByText("Rider One")).toBeTruthy();
    // The riding-stat line uses a "·" separator, so its absence proves
    // the line wasn't rendered when the summary call failed.
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("hides stat segments that round down to zero so a brand-new rider doesn't see '0 km · 0h'", async () => {
    // 0.3 km / 0.4h pass a naïve `> 0` guard but `Math.round` collapses
    // them to 0; the line must skip those segments outright.
    mockedApi.getMyProfile.mockResolvedValueOnce({
      joined_at: "2025-04-01T10:00:00.000Z",
      total_hours: 0.4,
      total_rides: 1,
      total_distance_km: 0.3,
      roads_discovered: 0,
      hazards_reported: 0,
      follower_count: 0,
      following_count: 0,
      badges_earned: 0,
    });

    await render(<ProfileScreen />);

    await waitFor(() =>
      expect(mockedApi.getMyProfile).toHaveBeenCalledTimes(1),
    );
    // Only the ride count survives the rounding floor.
    expect(await screen.findByText("1 ride")).toBeTruthy();
    expect(screen.queryByText(/0 km/)).toBeNull();
    expect(screen.queryByText(/0h/)).toBeNull();
  });

  it("opens the EditProfile modal when Edit profile is tapped", async () => {
    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await fireEvent.press(screen.getByLabelText("Edit profile"));
    expect(mockNavigate).toHaveBeenCalledWith("EditProfile");
  });

  it("navigates to the followers list when the Followers tile is tapped", async () => {
    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await fireEvent.press(screen.getByLabelText("12 followers, open list"));
    expect(mockNavigate).toHaveBeenCalledWith("Followers", {
      userId: "user-1",
      displayName: "Rider One",
    });
  });

  it("makes the follower/following tiles non-interactive when community_access is killed", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    // The counts still render (own profile is unaffected) but tapping them
    // does NOT open the (blocked) community list — no push-then-goBack flash.
    await fireEvent.press(screen.getByLabelText("12 followers, open list"));
    await fireEvent.press(
      screen.getByLabelText("Following 7 riders, open list"),
    );
    expect(mockNavigate).not.toHaveBeenCalledWith(
      "Followers",
      expect.anything(),
    );
    expect(mockNavigate).not.toHaveBeenCalledWith(
      "Following",
      expect.anything(),
    );
  });

  it("clears the auth store when sign out is confirmed", async () => {
    jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === "destructive");
      destructive?.onPress?.();
    });
    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await fireEvent.press(screen.getByLabelText("Sign out"));

    expect(mockedApi.logout).toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalled();
  });

  it("uploads a new avatar and writes the result back to the auth store", async () => {
    mockedCapture.mockResolvedValue({
      status: "captured",
      photo: {
        uri: "file:///tmp/avatar.jpg",
        mimeType: "image/jpeg",
        fileName: "avatar.jpg",
      },
      source: "library",
    });
    mockedApi.uploadAvatar.mockResolvedValue({
      id: "user-1",
      email: "rider@tarmoto.app",
      display_name: "Rider One",
      avatar_url: "https://cdn.example.com/u/1.png",
      bio: null,
      home_region: null,
      preferences: { units: "metric" },
      created_at: "2025-04-01T10:00:00.000Z",
    } as never);

    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Change avatar"));
    });

    await waitFor(() =>
      expect(mockedApi.uploadAvatar).toHaveBeenCalledWith({
        uri: "file:///tmp/avatar.jpg",
        mimeType: "image/jpeg",
        fileName: "avatar.jpg",
      }),
    );
    // Optimistic local URI goes through setUser; the persisted result
    // publishes through applyProfileUpdate (which preserves entitlements).
    expect(mockSetUser).toHaveBeenCalled();
    expect(mockApplyProfileUpdate).toHaveBeenCalled();
    const lastCall = mockApplyProfileUpdate.mock.calls.at(-1)?.[0] as {
      avatar_url: string;
    };
    expect(lastCall.avatar_url).toBe("https://cdn.example.com/u/1.png");
  });

  it("optimistic write uses the live store, not the pre-picker snapshot", async () => {
    // The native picker awaits; a foreground refresh publishes a downgrade
    // while it's open. The optimistic setUser must build on the LIVE (fresh)
    // store — changing only avatar_url — not resurrect the pre-picker profile.
    mockedCapture.mockImplementation(async () => {
      // Simulate the refresh landing during the picker await.
      mockAuthState.user = {
        ...mockAuthState.user!,
        // A downgrade published mid-picker.
        subscription_tier: "free",
        features: { gpx_export: false },
      } as never;
      return {
        status: "captured",
        photo: { uri: "file:///tmp/avatar.jpg" },
        source: "library",
      } as never;
    });
    mockedApi.uploadAvatar.mockResolvedValue({
      id: "user-1",
      avatar_url: "https://cdn.example.com/u/1.png",
    } as never);

    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Change avatar"));
    });

    // The optimistic setUser carries the DOWNGRADED entitlements from the live
    // store plus the new avatar — not the pre-picker premium snapshot.
    const optimistic = mockSetUser.mock.calls.at(0)?.[0] as {
      avatar_url: string;
      subscription_tier: string;
      features: { gpx_export: boolean };
    };
    expect(optimistic.avatar_url).toBe("file:///tmp/avatar.jpg");
    expect(optimistic.subscription_tier).toBe("free");
    expect(optimistic.features.gpx_export).toBe(false);
  });

  it("reverts the optimistic avatar when upload fails", async () => {
    mockedCapture.mockResolvedValue({
      status: "captured",
      photo: { uri: "file:///tmp/avatar.jpg" },
      source: "library",
    });
    mockedApi.uploadAvatar.mockRejectedValue(new Error("offline"));

    await render(<ProfileScreen />);
    await waitFor(() => expect(mockedApi.getPublicProfile).toHaveBeenCalled());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Change avatar"));
    });

    await waitFor(() => expect(mockedApi.uploadAvatar).toHaveBeenCalled());
    // First call: optimistic local uri. Last call: revert to previous user.
    const last = mockSetUser.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({
      id: "user-1",
      avatar_url: null,
    });
    expect(await screen.findByText("Could not upload avatar.")).toBeTruthy();
  });

  it("renders sign-in prompt when no user is authenticated", async () => {
    mockAuthState.user = null;
    await render(<ProfileScreen />);
    expect(await screen.findByText("Sign in to see your profile")).toBeTruthy();
  });
});
