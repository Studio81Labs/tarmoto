/**
 * Tarmoto — Know the road before you ride it.
 * React Native App Entry Point
 */

import React, { useEffect, useMemo } from "react";
import { StatusBar, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RootNavigator from "@/navigation/RootNavigator";
import { api } from "@/services/api";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { startPrivacyRefreshMonitor } from "@/services/privacyRefreshMonitor";
import { startTimezoneSyncMonitor } from "@/services/timezoneSyncMonitor";
import { brandColorsLight } from "@/theme/brand";
import { bootstrapAuth } from "@/services/authBootstrap";
import { useAuthStore, usePreferencesStore } from "@/stores";
import { I18nProvider } from "@/i18n/I18nProvider";
import { detectDeviceLocale, detectDeviceTimeZone } from "@/i18n/deviceLocale";
import { FormatProvider } from "@/format/FormatProvider";

// Suppress specific warnings in dev
LogBox.ignoreLogs([
  "Non-serializable values were found in the navigation state",
]);

export default function App() {
  const setUser = useAuthStore((state) => state.setUser);
  const setLoading = useAuthStore((state) => state.setLoading);
  const isAuthLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const units = usePreferencesStore((state) => state.distanceUnit);
  const setDistanceUnit = usePreferencesStore((state) => state.setDistanceUnit);
  const deviceLocale = useMemo(detectDeviceLocale, []);
  const deviceTimeZone = useMemo(detectDeviceTimeZone, []);
  const locale = user?.language ?? deviceLocale;
  const formatLocale = user?.preferences?.format_locale ?? deviceLocale;
  const timeZone = user?.preferences?.timezone ?? deviceTimeZone;

  // The account is the cross-device source of truth. Hydrate the synchronous
  // MMKV-backed store whenever auth resolves (or the profile changes), while
  // keeping the store subscribed above so a Settings toggle updates every
  // formatter-backed surface immediately.
  useEffect(() => {
    const profileUnits = user?.preferences?.units;
    if (profileUnits) setDistanceUnit(profileUnits);
  }, [user?.preferences?.units, setDistanceUnit]);

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
            locale={formatLocale}
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
