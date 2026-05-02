/**
 * AchievementsScreen — hub navigation + summary line.
 */
import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import AchievementsScreen from "../AchievementsScreen";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";

const mockNavigate = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

jest.mock("@/services/api", () => ({
  api: {
    listUserBadges: jest.fn(),
    listChallenges: jest.fn(),
    getExplorationStats: jest.fn(),
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
      created_at: "2026-01-01T00:00:00Z",
    },
    isAuthenticated: true,
    isLoading: false,
  });
});

describe("AchievementsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.listUserBadges.mockResolvedValue([
      {
        key: "k1",
        name: "Road Warrior",
        description: "",
        category: "distance",
        tier: "silver",
        earned_at: "2026-04-01T00:00:00Z",
        progress: { current: 1500, bronze: 100, silver: 1000, gold: 10000 },
      },
      {
        key: "k2",
        name: "Iron Butt",
        description: "",
        category: "distance",
        tier: null,
        earned_at: null,
        progress: { current: 0, bronze: 50, silver: 200, gold: 500 },
      },
    ]);
    mockedApi.listChallenges.mockResolvedValue([
      {
        id: "c1",
        title: "T",
        description: "",
        metric: "total_km",
        target: 100,
        starts_at: "2026-05-01T00:00:00Z",
        ends_at: "2026-12-31T00:00:00Z",
        reward_badge_key: null,
        participant_count: 1,
      },
    ]);
    mockedApi.getExplorationStats.mockResolvedValue({
      ridden_segments: 100,
      total_segments: 800,
      percent_explored: 12.5,
      total_distance_km: 1234.5,
    });
  });

  it("summarises each surface and routes the rider on tap", async () => {
    render(<AchievementsScreen />);

    await waitFor(() =>
      expect(
        screen.getByText(/1 of 2 earned · SILVER tier reached/),
      ).toBeTruthy(),
    );
    expect(screen.getByText("1 active challenge")).toBeTruthy();
    expect(
      screen.getByText(/12\.5% explored · 100 of 800 segments ridden/),
    ).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Open Badges"));
    expect(mockNavigate).toHaveBeenCalledWith("Badges");

    fireEvent.press(screen.getByLabelText("Open Challenges"));
    expect(mockNavigate).toHaveBeenCalledWith("Challenges");

    fireEvent.press(screen.getByLabelText("Open Personal road map"));
    expect(mockNavigate).toHaveBeenCalledWith("PersonalRoadMap");
  });

  it("surfaces an error banner when every source fails so the rider isn't shown empty defaults", async () => {
    mockedApi.listUserBadges.mockRejectedValue(new Error("Network down"));
    mockedApi.listChallenges.mockRejectedValue(new Error("Network down"));
    mockedApi.getExplorationStats.mockRejectedValue(new Error("Network down"));

    render(<AchievementsScreen />);

    // Without the all-settled flow this would have rendered "0 of 0
    // earned" + "No active challenges right now" — the misleading state
    // the review flagged. With the fix the banner appears and the
    // summary lines stay on the "Loading…" placeholder.
    await waitFor(() => expect(screen.getByText("Network down")).toBeTruthy());
    expect(screen.queryByText("0 of 0 earned")).toBeNull();
    expect(screen.queryByText("No active challenges right now")).toBeNull();
  });

  it("renders a soft-warning banner when only some sources fail", async () => {
    mockedApi.listChallenges.mockRejectedValue(new Error("Slow"));

    render(<AchievementsScreen />);

    // Working sources still render their summaries — the rider gets
    // partial value rather than a blank screen — but the banner makes
    // the staleness visible.
    await waitFor(() =>
      expect(
        screen.getByText(/1 of 2 earned · SILVER tier reached/),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText("Some achievements couldn't load. Pull to refresh."),
    ).toBeTruthy();
  });
});
