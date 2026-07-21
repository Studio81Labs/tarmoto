/**
 * BadgesScreen — US-28 grid render + tier separation.
 */
import { buildFeatureSnapshot, buildLimitSnapshot } from "@tarmoto/shared";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import BadgesScreen from "../BadgesScreen";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";

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
    listUserBadges: jest.fn(),
    checkBadges: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

beforeAll(() => {
  // The screen reads `user.id` from the auth store. Seeding once is
  // simpler than a per-test mock because every spec needs the same id.
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
      limits: buildLimitSnapshot("free", {}, {}),
      created_at: "2026-01-01T00:00:00Z",
    },
    isAuthenticated: true,
    isLoading: false,
  });
});

describe("BadgesScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.checkBadges.mockResolvedValue({ newly_earned: [] });
  });

  it("splits earned and locked badges into separate sections", async () => {
    mockedApi.listUserBadges.mockResolvedValue([
      {
        key: "total_distance",
        category: "distance",
        tier: "silver",
        earned_at: "2026-04-01T00:00:00Z",
        progress: { current: 1500, bronze: 100, silver: 1000, gold: 10000 },
      },
      {
        key: "single_ride",
        category: "distance",
        tier: null,
        earned_at: null,
        progress: { current: 25, bronze: 50, silver: 200, gold: 500 },
      },
    ]);

    await render(<BadgesScreen />);

    await waitFor(() => expect(screen.getByText("Road Warrior")).toBeTruthy());
    expect(screen.getByText("Earned (1)")).toBeTruthy();
    expect(screen.getByText("In progress (1)")).toBeTruthy();
    // The earned badge shows its tier label.
    expect(screen.getByText("SILVER")).toBeTruthy();
    expect(
      screen.getByLabelText("Road Warrior, Silver tier earned"),
    ).toBeTruthy();
    // The unearned badge shows the next milestone (bronze).
    expect(screen.getByText(/25 \/ 50/)).toBeTruthy();
    expect(
      screen.getByLabelText("Iron Butt, locked, 50% to Bronze"),
    ).toBeTruthy();
  });

  it("renders the brand-new-rider empty CTA when nothing has progressed", async () => {
    mockedApi.listUserBadges.mockResolvedValue([
      {
        key: "total_distance",
        category: "distance",
        tier: null,
        earned_at: null,
        progress: { current: 0, bronze: 100, silver: 1000, gold: 10000 },
      },
    ]);

    await render(<BadgesScreen />);

    await waitFor(() => expect(screen.getByText("No badges yet")).toBeTruthy());
    expect(
      screen.getByText("Earn your first badge by completing a ride."),
    ).toBeTruthy();
  });

  it("calls checkBadges before listing so newly-earned tiers appear immediately", async () => {
    mockedApi.listUserBadges.mockResolvedValue([]);
    await render(<BadgesScreen />);
    await waitFor(() => expect(mockedApi.listUserBadges).toHaveBeenCalled());
    expect(mockedApi.checkBadges).toHaveBeenCalled();
  });
});
