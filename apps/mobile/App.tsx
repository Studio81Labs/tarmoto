/**
 * Tarmoto — Know the road before you ride it.
 * React Native App Entry Point
 */

import React, { useEffect, useMemo, useState } from "react";
import { StatusBar, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RootNavigator from "@/navigation/RootNavigator";
import { api } from "@/services/api";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { startPrivacyRefreshMonitor } from "@/services/privacyRefreshMonitor";
import { startTimezoneSyncMonitor } from "@/services/timezoneSyncMonitor";
import { startDisplayPreferencesSyncMonitor } from "@/services/displayPreferencesSyncMonitor";
import type { DeviceDisplayPreferences } from "@/services/displayPreferencesSyncMonitor";
import { startLanguagePreferenceSyncMonitor } from "@/services/languagePreferenceSyncMonitor";
import { brandColorsLight } from "@/theme/brand";
import { bootstrapAuth } from "@/services/authBootstrap";
import { useAuthStore, usePreferencesStore } from "@/stores";
import { I18nProvider } from "@/i18n/I18nProvider";
import {
  detectDeviceFormatLocale,
  detectDeviceLocale,
  detectDeviceTimeZone,
} from "@/i18n/deviceLocale";
import { FormatProvider } from "@/format/FormatProvider";
import {
  canonicalizeFormatLocale,
  isSupportedLocale,
  isValidTimeZone,
} from "@tarmoto/shared";

// Suppress specific warnings in dev
LogBox.ignoreLogs([
  "Non-serializable values were found in the navigation state",
]);

function readDeviceDisplayPreferences(): DeviceDisplayPreferences {
  const detectedLocale = canonicalizeFormatLocale(detectDeviceFormatLocale());
  const detectedZone = detectDeviceTimeZone();
  return {
    formatLocale: detectedLocale,
    timeZone:
      detectedZone && isValidTimeZone(detectedZone) ? detectedZone : null,
  };
}

export default function App() {
  const setUser = useAuthStore((state) => state.setUser);
  const setLoading = useAuthStore((state) => state.setLoading);
  const isAuthLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const units = usePreferencesStore((state) => state.distanceUnit);
  const setDistanceUnit = usePreferencesStore((state) => state.setDistanceUnit);
  const uiLocaleOverride = usePreferencesStore(
    (state) => state.uiLocaleOverride,
  );
  const pendingUiLocaleSync = usePreferencesStore(
    (state) => state.pendingUiLocaleSync,
  );
  const completeUiLocaleSync = usePreferencesStore(
    (state) => state.completeUiLocaleSync,
  );
  const adoptAccountUiLocale = usePreferencesStore(
    (state) => state.adoptAccountUiLocale,
  );
  const deviceLocale = useMemo(detectDeviceLocale, []);
  const [deviceDisplayPreferences, setDeviceDisplayPreferences] = useState(
    readDeviceDisplayPreferences,
  );
  const locale = uiLocaleOverride ?? user?.language ?? deviceLocale;
  const formatLocale =
    deviceDisplayPreferences.formatLocale ??
    deviceLocale ??
    user?.preferences?.format_locale;
  const timeZone =
    deviceDisplayPreferences.timeZone ?? user?.preferences?.timezone;

  // The account is the cross-device source of truth. Hydrate the synchronous
  // MMKV-backed store whenever auth resolves (or the profile changes), while
  // keeping the store subscribed above so a Settings toggle updates every
  // formatter-backed surface immediately. Unit-less accounts explicitly use
  // metric so they cannot inherit the previous device/account preference.
  useEffect(() => {
    if (user) setDistanceUnit(user.preferences?.units ?? "metric");
  }, [user, setDistanceUnit]);

  // Mirror companion's ordinary locale cookie behavior: once no explicit
  // device write is pending, a valid cross-device account change becomes the
  // durable local choice too. Keeping it locally means sign-out does not
  // unexpectedly snap the UI back to the device language.
  useEffect(() => {
    if (
      !pendingUiLocaleSync &&
      user?.language &&
      isSupportedLocale(user.language) &&
      user.language !== uiLocaleOverride
    ) {
      adoptAccountUiLocale(user.language);
    }
  }, [
    adoptAccountUiLocale,
    pendingUiLocaleSync,
    uiLocaleOverride,
    user?.language,
  ]);

  useEffect(() => {
    void bootstrapAuth({
      getSessionSnapshot: () => api.getAuthSessionSnapshot(),
      getCachedProfile: () => api.getCachedProfile(),
      getProfile: () => api.getProfile(),
      cacheProfile: (user) => api.cacheProfile(user),
      setUser,
      setLoading,
    });
  }, [setLoading, setUser]);

  // US-15 AC #2: run a commute hazard check on every cold start and
  // foreground transition. Mounted once at the app root so the monitor
  // keeps running across navigation — CommuteScreen's diff UI remains
  // the view-of-record; this hook just surfaces NEW hazards as a
  // pre-ride alert without forcing the rider to visit that tab first.
  useEffect(() => {
    if (isAuthLoading || !isAuthenticated) return;
    return startCommuteHazardMonitor();
  }, [isAuthLoading, isAuthenticated]);

  // #279 / #501 — keep the local privacy preferences cache in sync
  // with the server on every cold start and foreground transition.
  // Without this hook, an already-authenticated install (or a rider
  // who toggled `road_data_contribution` from the companion while
  // the mobile app stayed signed in) would keep streaming sensor
  // batches until the next login. The backend still drops opted-out
  // payloads server-side, but the cache is what implements the
  // client-side "don't ship / don't burn battery" enforcement.
  useEffect(
    () =>
      startPrivacyRefreshMonitor({
        isAuthenticated: () => api.isAuthenticated(),
        refresh: () => api.refreshPrivacyPreferences(),
      }),
    [],
  );

  // Regional formatting follows the current device rather than whichever
  // browser/phone last wrote the shared profile. Reconcile after auth resolves
  // and on every foreground so account-backed formatting remains correct when
  // the rider changes region or travels across timezones.
  useEffect(() => {
    if (isAuthLoading) return;
    return startDisplayPreferencesSyncMonitor({
      isAuthenticated: () => api.isAuthenticated(),
      currentDevicePreferences: readDeviceDisplayPreferences,
      onDevicePreferencesDetected: (detected) => {
        setDeviceDisplayPreferences((current) =>
          current.formatLocale === detected.formatLocale &&
          current.timeZone === detected.timeZone
            ? current
            : detected,
        );
      },
      currentAccountPreferences: () => {
        const current = useAuthStore.getState().user;
        return current
          ? {
              userId: current.id,
              formatLocale: current.preferences?.format_locale ?? null,
              timeZone: current.preferences?.timezone ?? null,
            }
          : null;
      },
      sync: async (userId, preferences) => {
        await api.updateProfile({ preferences });
        const auth = useAuthStore.getState();
        const current = auth.user;
        if (current?.id !== userId) return;

        // This background PATCH can overlap an interactive Settings write.
        // Merge only the fields owned by this monitor into the latest profile;
        // publishing the whole response could revert unrelated preferences
        // from an older server snapshot (for example, a just-changed unit).
        const merged = {
          ...current,
          preferences: {
            ...current.preferences,
            ...(preferences.format_locale !== undefined
              ? { format_locale: preferences.format_locale }
              : {}),
            ...(preferences.timezone !== undefined
              ? { timezone: preferences.timezone }
              : {}),
          },
        };
        api.cacheProfile(merged);
        auth.setUser(merged);
      },
    });
  }, [
    isAuthLoading,
    isAuthenticated,
    user?.id,
    user?.preferences?.format_locale,
    user?.preferences?.timezone,
  ]);

  // An explicit language choice is device-local first so it updates the UI
  // immediately and survives offline restarts. Reconcile the pending marker
  // with the account in the background; only the still-current choice may
  // publish into auth state, so a slow response cannot revert a newer choice.
  useEffect(() => {
    if (isAuthLoading) return;
    return startLanguagePreferenceSyncMonitor({
      isAuthenticated: () =>
        api.isAuthenticated() && !!useAuthStore.getState().user?.id,
      pendingLocale: () => usePreferencesStore.getState().pendingUiLocaleSync,
      accountLocale: () => useAuthStore.getState().user?.language,
      sync: async (pendingLocale) => {
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return;
        await api.updateProfile({ language: pendingLocale });
        const auth = useAuthStore.getState();
        const current = auth.user;
        const preferences = usePreferencesStore.getState();
        if (
          current?.id !== userId ||
          preferences.pendingUiLocaleSync !== pendingLocale
        ) {
          return;
        }

        const merged = { ...current, language: pendingLocale };
        api.cacheProfile(merged);
        auth.setUser(merged);
        preferences.completeUiLocaleSync(pendingLocale);
      },
      onAlreadySynced: (pendingLocale) => {
        usePreferencesStore.getState().completeUiLocaleSync(pendingLocale);
      },
    });
  }, [
    completeUiLocaleSync,
    isAuthLoading,
    isAuthenticated,
    pendingUiLocaleSync,
    user?.id,
    user?.language,
  ]);

  // #866 — persist the rider's device timezone so the weekly digest sends at
  // their local Sunday 08:00 instead of the server UTC default. Mirrors the
  // privacy monitor: cold start + foreground, auth-gated, best-effort. Without
  // this a mobile-only rider stays at UTC until they open the companion.
  useEffect(
    () =>
      startTimezoneSyncMonitor({
        isAuthenticated: () => api.isAuthenticated(),
        currentTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        sync: () => api.syncDeviceTimezone(),
      }),
    [],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider locale={locale ?? null}>
          <FormatProvider
            locale={formatLocale ?? null}
            timeZone={timeZone ?? null}
            units={units}
          >
            <StatusBar
              barStyle="dark-content"
              backgroundColor={brandColorsLight.bg}
              translucent
            />
            <RootNavigator />
          </FormatProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
