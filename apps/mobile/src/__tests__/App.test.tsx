import React from "react";
import { act, render } from "@testing-library/react-native";
import App from "../../App";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { useAuthStore, usePreferencesStore } from "@/stores";
import { getFormatters } from "@/format";
import type { User } from "@/types";

let mockProviderLocale: string | null | undefined;
const mockMonitorLocales: Array<string | null | undefined> = [];

jest.mock("@/navigation/RootNavigator", () => () => null);

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) =>
    children,
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("@/i18n/I18nProvider", () => ({
  I18nProvider: ({
    children,
    locale,
  }: {
    children: React.ReactNode;
    locale?: string | null;
  }) => {
    mockProviderLocale = locale;
    return children;
  },
}));

jest.mock("@/services/authBootstrap", () => ({
  bootstrapAuth: jest.fn(),
}));

jest.mock("@/services/api", () => ({
  api: {
    getAuthSessionSnapshot: jest.fn(),
    getCachedProfile: jest.fn(),
    getProfile: jest.fn(),
    cacheProfile: jest.fn(),
    isAuthenticated: jest.fn(),
    refreshPrivacyPreferences: jest.fn(),
    syncDeviceTimezone: jest.fn(),
  },
}));

jest.mock("@/services/commuteHazardNotifier", () => ({
  startCommuteHazardMonitor: jest.fn(() => {
    mockMonitorLocales.push(mockProviderLocale);
    return jest.fn();
  }),
}));

jest.mock("@/services/privacyRefreshMonitor", () => ({
  startPrivacyRefreshMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/timezoneSyncMonitor", () => ({
  startTimezoneSyncMonitor: jest.fn(() => jest.fn()),
}));

describe("App auth locale hydration", () => {
  beforeEach(() => {
    jest.mocked(startCommuteHazardMonitor).mockClear();
    mockMonitorLocales.length = 0;
    mockProviderLocale = undefined;
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
    usePreferencesStore.getState().setDistanceUnit("metric");
  });

  it("starts commute alerts only after the authenticated locale renders", async () => {
    await render(<App />);

    expect(startCommuteHazardMonitor).not.toHaveBeenCalled();

    await act(() => {
      useAuthStore.getState().setUser({
        language: "cs",
      } as unknown as User);
    });

    expect(startCommuteHazardMonitor).toHaveBeenCalledTimes(1);
    expect(mockMonitorLocales).toEqual(["cs"]);
  });

  it("updates formatter-backed UI when the local distance setting changes", async () => {
    await render(<App />);

    expect(getFormatters().distanceKm(10)).toBe("10 km");

    await act(() => {
      usePreferencesStore.getState().setDistanceUnit("imperial");
    });

    expect(getFormatters().distanceKm(10)).toBe("6.2 mi");
  });
});
