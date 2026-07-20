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
import { resolveLocale, t as translate } from "@/i18n";

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
    register: jest.fn(),
  },
}));

jest.mock("@/i18n", () => {
  const actual = jest.requireActual<typeof import("@/i18n")>("@/i18n");
  return {
    ...actual,
    resolveLocale: jest.fn(actual.resolveLocale),
    t: jest.fn(actual.t),
  };
});

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
  const registerMock = api.register as jest.MockedFunction<typeof api.register>;
  const resolveLocaleMock = jest.mocked(resolveLocale);
  const translateMock = jest.mocked(translate);

  beforeEach(() => {
    loginMock.mockReset();
    registerMock.mockReset();
    mockSetUser.mockReset();
    resolveLocaleMock.mockClear();
    translateMock.mockClear();
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

    await render(<LinkAccountScreen />);

    expect(screen.getByDisplayValue("rider@example.com")).toBeTruthy();

    await fireEvent.changeText(
      screen.getByLabelText("Password"),
      "secret-pass",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Link account" }));

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
    expect(resolveLocaleMock).toHaveBeenCalledWith("en");
    expect(translateMock).toHaveBeenCalledWith(
      "Account linked. We're now syncing rides, bikes, and profile details to this phone.",
      undefined,
      "en",
    );
  });

  it("creates a new account from the registration mode", async () => {
    registerMock.mockResolvedValueOnce({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      user: {
        id: "user-2",
        email: "new@example.com",
        display_name: "New Rider",
        language: "en",
      },
    } as Awaited<ReturnType<typeof api.register>>);

    await render(<LinkAccountScreen />);
    await fireEvent.press(
      screen.getByRole("button", { name: "Create account mode" }),
    );
    await fireEvent.changeText(
      screen.getByLabelText("Display name"),
      "New Rider",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Email"),
      "new@example.com",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Password"),
      "secret-pass",
    );
    await fireEvent.press(screen.getByTestId("auth-submit"));

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith(
        "new@example.com",
        "secret-pass",
        "New Rider",
      ),
    );
    expect(mockSetUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@example.com" }),
    );
    expect(await screen.findByText(/account created/i)).toBeTruthy();
    expect(resolveLocaleMock).toHaveBeenCalledWith("en");
    expect(translateMock).toHaveBeenCalledWith(
      "Account created. Your rides, bikes, trips, and preferences will now sync.",
      undefined,
      "en",
    );
  });
});
