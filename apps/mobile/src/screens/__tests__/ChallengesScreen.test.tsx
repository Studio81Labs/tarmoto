/**
 * ChallengesScreen — US-29 list + expand + join flow.
 */
import { buildFeatureSnapshot } from "@tarmoto/shared";
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import ChallengesScreen from "../ChallengesScreen";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import type { Challenge, ChallengeDetail } from "@/types";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("@/services/api", () => ({
  api: {
    listChallenges: jest.fn(),
    getChallenge: jest.fn(),
    joinChallenge: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

beforeAll(() => {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "rider@example.com",
      display_name: "Rider",
      phone: null,
      avatar_url: null,
      bio: null,
      language: "en",
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: {
        units: "metric",
        daily_km: 200,
        min_quality: 1,
        road_types: [],
        record_gps: true,
        crash_detection: true,
      },
      subscription_tier: "free",
      features: buildFeatureSnapshot("free", {}, {}),
      created_at: "2026-01-01T00:00:00Z",
    },
    isAuthenticated: true,
    isLoading: false,
  });
});

const baseChallenge: Challenge = {
  id: "c1",
  title: "May Distance",
  description: "Ride 200 km in May",
  metric: "total_km",
  target: 200,
  starts_at: "2026-05-01T00:00:00Z",
  // Far enough in the future that "Ends today" never matches in CI.
  ends_at: "2026-12-31T00:00:00Z",
  reward_badge_key: null,
  participant_count: 12,
};

const baseDetail: ChallengeDetail = {
  ...baseChallenge,
  my_progress: null,
  my_completed: null,
  leaderboard: [
    {
      rank: 1,
      user_id: "user-2",
      display_name: "Speedy",
      progress: 180,
      completed: false,
    },
    {
      rank: 2,
      user_id: "user-1",
      display_name: "Rider",
      progress: 90,
      completed: false,
    },
  ],
};

describe("ChallengesScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the active challenge list with metadata pills", async () => {
    mockedApi.listChallenges.mockResolvedValue([baseChallenge]);
    render(<ChallengesScreen />);

    await waitFor(() => expect(screen.getByText("May Distance")).toBeTruthy());
    expect(screen.getByText("Ride 200 km in May")).toBeTruthy();
    expect(screen.getByText("200 km")).toBeTruthy();
    expect(screen.getByText("12 riders")).toBeTruthy();
  });

  it("renders an empty state when no challenges are active", async () => {
    mockedApi.listChallenges.mockResolvedValue([]);
    render(<ChallengesScreen />);
    await waitFor(() =>
      expect(screen.getByText("No active challenges")).toBeTruthy(),
    );
  });

  it("loads and displays leaderboard when a card is expanded, then joins on tap", async () => {
    mockedApi.listChallenges.mockResolvedValue([baseChallenge]);
    mockedApi.getChallenge.mockResolvedValue(baseDetail);
    mockedApi.joinChallenge.mockResolvedValue({
      challenge_id: "c1",
      joined_at: "2026-05-01T10:00:00Z",
    });

    render(<ChallengesScreen />);
    await waitFor(() => expect(screen.getByText("May Distance")).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Expand May Distance details"));
      // Flush the detail fetch promise.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Leaderboard")).toBeTruthy();
    expect(screen.getByText(/Speedy/)).toBeTruthy();
    // The current user is highlighted.
    expect(screen.getByText(/Rider \(you\)/)).toBeTruthy();

    // Once joined the detail is re-fetched: stub the second response to
    // include `my_progress` so the join button disappears.
    mockedApi.getChallenge.mockResolvedValue({
      ...baseDetail,
      my_progress: 0,
    });

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Join challenge May Distance"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedApi.joinChallenge).toHaveBeenCalledWith("c1");
  });
});
