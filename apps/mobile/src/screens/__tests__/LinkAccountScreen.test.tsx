import { buildFeatureSnapshot, buildLimitSnapshot } from "@tarmoto/shared";
import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import LinkAccountScreen from "../LinkAccountScreen";
import { api } from "@/services/api";

const mockSetUser = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useRoute: () => ({
    params: {
      email: "rider@example.com",
    },
  }),
}));

jest.mock("@/services/api", () => ({
  api: {
    login: jest.fn(),
  },
}));

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = () => ReactLib.createElement(Text, null, "icon");
  return { Icon: MockIcon };
});

jest.mock("@/stores", () => ({
  useAuthStore: (
    selector: (state: { user: null; setUser: typeof mockSetUser }) => unknown,
  ) =>
    selector({
      user: null,
      setUser: mockSetUser,
    }),
}));

describe("LinkAccountScreen", () => {
  const loginMock = api.login as jest.MockedFunction<typeof api.login>;

  beforeEach(() => {
    loginMock.mockReset();
    mockSetUser.mockReset();
  });

  it("prefills the linked email and confirms sync after a successful sign-in", async () => {
    loginMock.mockResolvedValueOnce({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      user: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: null,
        bio: null,
        language: "en",
        home_region: null,
        home_location: null,
        work_location: null,
        preferences: {
          units: "metric",
          daily_km: 250,
          min_quality: 3,
          road_types: ["curvy"],
          record_gps: true,
          crash_detection: true,
        },
        subscription_tier: "free",
        features: buildFeatureSnapshot("free", {}, {}),
        limits: buildLimitSnapshot("free", {}, {}),
        created_at: "2026-04-23T08:00:00.000Z",
      },
    });

    render(<LinkAccountScreen />);

    expect(screen.getByDisplayValue("rider@example.com")).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText("Password"), "secret-pass");
    fireEvent.press(screen.getByRole("button", { name: "Link account" }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith(
        "rider@example.com",
        "secret-pass",
      ),
    );
    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "rider@example.com",
      }),
    );
    expect(
      await screen.findByText(/now syncing rides, bikes, and profile details/i),
    ).toBeTruthy();
  });
});
