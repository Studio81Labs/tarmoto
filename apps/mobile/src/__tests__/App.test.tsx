import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import App from "../../App";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { startDisplayPreferencesSyncMonitor } from "@/services/displayPreferencesSyncMonitor";
import { startLanguagePreferenceSyncMonitor } from "@/services/languagePreferenceSyncMonitor";
import { startEntitlementsRefreshMonitor } from "@/services/entitlementsRefreshMonitor";
import { startSystemSwitchRefreshMonitor } from "@/services/systemSwitchRefreshMonitor";
import { setCachedSystemSwitchStates } from "@/services/systemSwitchCache";
import { api } from "@/services/api";
import { useAuthStore, usePreferencesStore } from "@/stores";
import { getFormatters } from "@/format";
import {
  detectDeviceFormatLocale,
  detectDeviceLocale,
  detectDeviceTimeZone,
} from "@/i18n/deviceLocale";
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
    getConfigFlags: jest.fn(),
    syncDeviceTimezone: jest.fn(),
    updateProfile: jest.fn(),
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

jest.mock("@/services/systemSwitchRefreshMonitor", () => ({
  startSystemSwitchRefreshMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/systemSwitchCache", () => ({
  setCachedSystemSwitchStates: jest.fn(),
}));

jest.mock("@/services/entitlementsRefreshMonitor", () => ({
  startEntitlementsRefreshMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/offlineDownloadRevocationMonitor", () => ({
  startOfflineDownloadRevocationMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/timezoneSyncMonitor", () => ({
  startTimezoneSyncMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/displayPreferencesSyncMonitor", () => ({
  startDisplayPreferencesSyncMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/services/languagePreferenceSyncMonitor", () => ({
  startLanguagePreferenceSyncMonitor: jest.fn(() => jest.fn()),
}));

jest.mock("@/i18n/deviceLocale", () => ({
  detectDeviceLocale: jest.fn(() => "en-GB"),
  detectDeviceFormatLocale: jest.fn(() => "en-GB"),
  detectDeviceTimeZone: jest.fn(() => "Europe/Prague"),
}));

describe("App auth locale hydration", () => {
  beforeEach(() => {
    jest.mocked(startCommuteHazardMonitor).mockClear();
    jest.mocked(startDisplayPreferencesSyncMonitor).mockClear();
    jest.mocked(startLanguagePreferenceSyncMonitor).mockClear();
    jest.mocked(startSystemSwitchRefreshMonitor).mockClear();
    jest.mocked(setCachedSystemSwitchStates).mockReset();
    jest.mocked(api.getConfigFlags).mockReset();
    jest.mocked(api.updateProfile).mockReset();
    jest.mocked(api.cacheProfile).mockReset();
    jest.mocked(api.isAuthenticated).mockReset().mockReturnValue(false);
    mockMonitorLocales.length = 0;
    mockProviderLocale = undefined;
    jest.mocked(detectDeviceFormatLocale).mockReturnValue("en-GB");
    jest.mocked(detectDeviceLocale).mockReturnValue("en-GB");
    jest.mocked(detectDeviceTimeZone).mockReturnValue("Europe/Prague");
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      bootstrapSettled: false,
    });
    usePreferencesStore.getState().setDistanceUnit("metric");
    usePreferencesStore.setState({
      uiLocaleOverride: null,
      pendingUiLocaleSync: null,
    });
  });

  it("gates the entitlement refresh behind the cold-start bootstrap settling", async () => {
    await render(<App />);
    const deps = jest
      .mocked(startEntitlementsRefreshMonitor)
      .mock.calls.at(-1)?.[0];
    expect(deps).toBeDefined();

    jest.mocked(api.isAuthenticated).mockReturnValue(true);

    // Baseline not settled yet — the optimistic setUser(cached) has already
    // cleared isLoading, but the full /users/me is still in flight. An
    // entitlement-only refresh here would merge onto the stale cached profile,
    // so hold it back.
    await act(async () => {
      useAuthStore.setState({ bootstrapSettled: false });
    });
    expect(deps?.isAuthenticated()).toBe(false);

    // Baseline settled → refreshes may proceed.
    await act(async () => {
      useAuthStore.setState({ bootstrapSettled: true });
    });
    expect(deps?.isAuthenticated()).toBe(true);

    // Signed out → never.
    jest.mocked(api.isAuthenticated).mockReturnValue(false);
    expect(deps?.isAuthenticated()).toBe(false);
  });

  it("wires the system-switch monitor to fetch /config/flags and persist the states", async () => {
    // Guards the critical cache-population path: a wiring regression (e.g. a
    // missing `getConfigFlags` or a dropped `setCachedSystemSwitchStates`) would
    // leave the accelerometer kill switch silently default-ON. Without asserting
    // it here, the swallowed TypeError inside `refreshQuietly` hides the break.
    const states = { sys_accel_collection: "force_off" } as const;
    jest.mocked(api.getConfigFlags).mockResolvedValue(states);

    await render(<App />);

    const deps = jest
      .mocked(startSystemSwitchRefreshMonitor)
      .mock.calls.at(-1)?.[0];
    expect(deps).toBeDefined();

    await act(async () => {
      await deps?.refresh();
    });

    expect(api.getConfigFlags).toHaveBeenCalledTimes(1);
    expect(setCachedSystemSwitchStates).toHaveBeenCalledWith(states);
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

  it("syncs a device-local language without reverting newer profile fields", async () => {
    jest.mocked(api.isAuthenticated).mockReturnValue(true);
    jest.mocked(api.updateProfile).mockResolvedValue({} as User);
    await render(<App />);
    await act(() => {
      useAuthStore.getState().setUser({
        id: "language-user",
        language: null,
        preferences: { units: "imperial" },
      } as unknown as User);
      usePreferencesStore.getState().selectUiLocale("en", "language-user");
    });
    await waitFor(() =>
      expect(startLanguagePreferenceSyncMonitor).toHaveBeenCalled(),
    );

    const monitor = jest
      .mocked(startLanguagePreferenceSyncMonitor)
      .mock.calls.at(-1)?.[0];
    await act(async () => {
      await monitor?.sync({
        locale: "en",
        ownerUserId: "language-user",
      });
    });

    expect(api.updateProfile).toHaveBeenCalledWith({ language: "en" });
    expect(useAuthStore.getState().user).toMatchObject({
      id: "language-user",
      language: "en",
      preferences: { units: "imperial" },
    });
    expect(usePreferencesStore.getState()).toMatchObject({
      uiLocaleOverride: "en",
      pendingUiLocaleSync: null,
    });
    expect(api.cacheProfile).toHaveBeenCalledWith(useAuthStore.getState().user);
  });

  it("hydrates formatter units from the authenticated profile", async () => {
    await render(<App />);

    await act(() => {
      useAuthStore.getState().setUser({
        language: "en",
        preferences: { units: "imperial" },
      } as unknown as User);
    });

    await waitFor(() => {
      expect(usePreferencesStore.getState().distanceUnit).toBe("imperial");
      expect(getFormatters().distanceKm(10)).toBe("6.2 mi");
    });
  });

  it("keeps regional formatting device-owned when the account was mirrored by another device", async () => {
    await render(<App />);

    await act(() => {
      useAuthStore.getState().setUser({
        language: "en",
        preferences: {
          format_locale: "ar-EG",
          timezone: "America/New_York",
        },
      } as unknown as User);
    });

    expect(getFormatters().locale).toBe("en-GB");
    expect(getFormatters().timeZone).toBe("Europe/Prague");
  });

  it("refreshes provider formatting when foreground detection changes", async () => {
    await render(<App />);
    await act(() => {
      useAuthStore.getState().setUser({
        id: "travelling-user",
        language: "en",
        preferences: {
          format_locale: "en-GB",
          timezone: "Europe/Prague",
        },
      } as unknown as User);
    });
    await waitFor(() =>
      expect(startDisplayPreferencesSyncMonitor).toHaveBeenCalled(),
    );

    jest.mocked(detectDeviceFormatLocale).mockReturnValue("ar-EG");
    jest.mocked(detectDeviceTimeZone).mockReturnValue("Africa/Cairo");
    const monitor = jest
      .mocked(startDisplayPreferencesSyncMonitor)
      .mock.calls.at(-1)?.[0];
    const detected = monitor?.currentDevicePreferences();
    expect(detected).toEqual({
      uiLocale: "en-GB",
      formatLocale: "ar-EG",
      timeZone: "Africa/Cairo",
    });

    await act(() => {
      if (detected) monitor?.onDevicePreferencesDetected?.(detected);
    });

    expect(getFormatters().locale).toBe("ar-EG");
    expect(getFormatters().timeZone).toBe("Africa/Cairo");
  });

  it("refreshes signed-out UI locale from the device on foreground", async () => {
    useAuthStore.setState({ isLoading: false });
    await render(<App />);
    await waitFor(() =>
      expect(startDisplayPreferencesSyncMonitor).toHaveBeenCalled(),
    );

    jest.mocked(detectDeviceLocale).mockReturnValue("de-DE");
    const monitor = jest
      .mocked(startDisplayPreferencesSyncMonitor)
      .mock.calls.at(-1)?.[0];
    const detected = monitor?.currentDevicePreferences();

    await act(() => {
      if (detected) monitor?.onDevicePreferencesDetected?.(detected);
    });

    expect(mockProviderLocale).toBe("de-DE");
  });

  it("defaults an authenticated unit-less profile to metric", async () => {
    usePreferencesStore.getState().setDistanceUnit("imperial");
    await render(<App />);
    expect(getFormatters().distanceKm(10)).toBe("6.2 mi");

    await act(() => {
      useAuthStore.getState().setUser({
        id: "unit-less-user",
        language: "en",
        preferences: {},
      } as unknown as User);
    });

    await waitFor(() => {
      expect(usePreferencesStore.getState().distanceUnit).toBe("metric");
      expect(getFormatters().distanceKm(10)).toBe("10 km");
    });
  });

  it("restarts display preference sync when profile hydration replaces cached preferences", async () => {
    await render(<App />);

    await act(() => {
      useAuthStore.getState().setUser({
        id: "warm-user",
        language: "en",
        preferences: {
          format_locale: "en-US",
          timezone: "UTC",
        },
      } as unknown as User);
    });
    expect(startDisplayPreferencesSyncMonitor).toHaveBeenCalledTimes(1);

    // The first monitor write publishes the device-derived values.
    await act(() => {
      useAuthStore.getState().setUser({
        id: "warm-user",
        language: "en",
        preferences: {
          format_locale: "cs-CZ",
          timezone: "Europe/Prague",
        },
      } as unknown as User);
    });
    expect(startDisplayPreferencesSyncMonitor).toHaveBeenCalledTimes(2);

    // A slower bootstrap GET can still publish its stale snapshot. Changing
    // either device-derived profile field must restart the monitor immediately
    // so it reconciles again instead of waiting for another foreground event.
    await act(() => {
      useAuthStore.getState().setUser({
        id: "warm-user",
        language: "en",
        preferences: {
          format_locale: "en-US",
          timezone: "UTC",
        },
      } as unknown as User);
    });
    expect(startDisplayPreferencesSyncMonitor).toHaveBeenCalledTimes(3);
  });

  it("merges a background display sync into the latest interactive preferences", async () => {
    const cached = {
      id: "race-user",
      language: "en",
      preferences: {
        units: "metric",
        format_locale: "en-US",
        timezone: "UTC",
      },
    } as unknown as User;
    const staleResponse = {
      ...cached,
      preferences: {
        ...cached.preferences,
        format_locale: "cs-CZ",
        timezone: "Europe/Prague",
      },
    } as unknown as User;
    let resolveUpdate!: (user: User) => void;
    jest.mocked(api.updateProfile).mockImplementation(
      () =>
        new Promise<User>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    await render(<App />);
    await act(() => {
      useAuthStore.getState().setUser(cached);
    });
    const sync = jest.mocked(startDisplayPreferencesSyncMonitor).mock
      .calls[0]?.[0].sync;
    expect(sync).toBeDefined();
    const syncPromise = sync?.("race-user", {
      format_locale: "cs-CZ",
      timezone: "Europe/Prague",
    });

    // The rider changes units while the background PATCH is in flight. Its
    // response still contains the older metric snapshot.
    await act(() => {
      useAuthStore.getState().setUser({
        ...cached,
        preferences: { ...cached.preferences, units: "imperial" },
      } as unknown as User);
    });
    await act(async () => {
      resolveUpdate(staleResponse);
      await syncPromise;
    });

    const merged = useAuthStore.getState().user;
    expect(merged?.preferences).toEqual({
      units: "imperial",
      format_locale: "cs-CZ",
      timezone: "Europe/Prague",
    });
    expect(api.cacheProfile).toHaveBeenCalledWith(merged);
  });
});
