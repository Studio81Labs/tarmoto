/**
 * Tarmoto — Know the road before you ride it.
 * React Native App Entry Point
 */

import React, { useEffect, useState } from "react";
import { StatusBar, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RootNavigator from "@/navigation/RootNavigator";
import { api } from "@/services/api";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { startPrivacyRefreshMonitor } from "@/services/privacyRefreshMonitor";
import { startSystemSwitchRefreshMonitor } from "@/services/systemSwitchRefreshMonitor";
import { setCachedSystemSwitchStates } from "@/services/systemSwitchCache";
import { startRideStopReconcileMonitor } from "@/services/rideStopReconcileMonitor";
import { drainPendingRideStops } from "@/services/rideStopReconciler";
import { startTripDraftCleanupMonitor } from "@/services/tripDraftCleanupMonitor";
import { drainTripDraftCleanups } from "@/services/tripDraftCleanup";
import { startEntitlementsRefreshMonitor } from "@/services/entitlementsRefreshMonitor";
import { startOfflineDownloadRevocationMonitor } from "@/services/offlineDownloadRevocationMonitor";
import { startTimezoneSyncMonitor } from "@/services/timezoneSyncMonitor";
import { startDisplayPreferencesSyncMonitor } from "@/services/displayPreferencesSyncMonitor";
import type { DeviceDisplayPreferences } from "@/services/displayPreferencesSyncMonitor";
import { startLanguagePreferenceSyncMonitor } from "@/services/languagePreferenceSyncMonitor";
import { brandColorsLight } from "@/theme/brand";
import { bootstrapAuth, refreshEntitlements } from "@/services/authBootstrap";
import { useAuthStore, usePreferencesStore, useRideStore } from "@/stores";
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
    uiLocale: detectDeviceLocale(),
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
  const [deviceDisplayPreferences, setDeviceDisplayPreferences] = useState(
    readDeviceDisplayPreferences,
  );
  const deviceLocale = deviceDisplayPreferences.uiLocale;
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
    void (async () => {
      // The token pair lives in the platform keystore (#1231); load it into
      // the in-memory mirror BEFORE the bootstrap reads its session snapshot,
      // or a signed-in cold start would look signed out. Everything else that
      // could race this (privacy/commute/entitlement monitors) gates on
      // `isAuthenticated()` and simply skips its first tick until hydration.
      await api.hydrateAuthTokens();
      await bootstrapAuth({
        getSessionSnapshot: () => api.getAuthSessionSnapshot(),
        getCachedProfile: () => api.getCachedProfile(),
        getProfile: () => api.getProfile(),
        cacheProfile: (user) => api.cacheProfile(user),
        setUser,
        setLoading,
        markSettled: () => useAuthStore.getState().markBootstrapSettled(),
      });
    })();
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

  // Keep the operator system-switch cache (`/config/flags`) fresh so the
  // client-side `sys_accel_collection` kill switch honours the live operator
  // state on the next ride. `/config/flags` is public (no auth gate), so this
  // refreshes on cold start and every foreground regardless of sign-in state —
  // a logged-out phone still runs the accelerometer on the record screen.
  // Without it, an operator flipping the switch to `force_off` mid-session
  // wouldn't reach a running install until its next cold start.
  useEffect(
    () =>
      startSystemSwitchRefreshMonitor({
        fetchStates: () => api.getConfigFlags(),
        persist: setCachedSystemSwitchStates,
      }),
    [],
  );

  // Retry any ride-stop that couldn't reach the server (a `ride_tracking` kill
  // or a rider stop while offline). Without this the backend ride stays active
  // and the one-active-ride constraint locks the rider out of new rides. Drains
  // on cold start + every foreground, gated on being signed in.
  useEffect(
    () =>
      startRideStopReconcileMonitor({
        isAuthenticated: () => api.isAuthenticated(),
        // Drain only THIS rider's queued stops (scoped so a different sign-in
        // on the same install can't 404-and-discard another rider's entry).
        drain: () =>
          drainPendingRideStops(
            api.getAuthenticatedUserId() ??
              useAuthStore.getState().user?.id ??
              "",
            // Never complete the still-recording ride from the background.
            useRideStore.getState().activeRide?.id ?? null,
          ),
      }),
    [],
  );

  // Retry orphaned trip-draft deletes on cold start + foreground. A
  // `trip_planning` kill mid-create can leave a persisted `draft` (it counts
  // against `max_active_trips`) whose cleanup delete failed for the same
  // planner outage. There's no delete-trip UI, so without this drain the draft
  // would sit in the rider's sole Free slot unrecoverably.
  useEffect(
    () =>
      startTripDraftCleanupMonitor({
        isAuthenticated: () => api.isAuthenticated(),
        // Drain only THIS rider's queued draft deletes — DELETE /trips/:id 404s
        // for a non-owner, so retrying another rider's entry under this token
        // would wrongly discard it while their draft still holds a slot.
        drain: () =>
          drainTripDraftCleanups(
            api.getAuthenticatedUserId() ??
              useAuthStore.getState().user?.id ??
              "",
          ),
      }),
    [],
  );

  // Reconcile queued ride-stops as soon as the rider signs in. A stop queued
  // after a 401 cleared the session can't drain while signed out, and the
  // monitor above only retries on cold start / foreground — a fresh login
  // (LinkAccountScreen) produces neither. Key on the `user` OBJECT (not its
  // id): a 401 leaves `useAuthStore.user` in place, so re-signing into the SAME
  // account keeps `user?.id` unchanged; `setUser` still publishes a fresh
  // object on that login, so depending on `user` catches the same-user session
  // replacement. The active-ride exclusion keeps a mid-ride re-render from
  // completing the live ride.
  useEffect(() => {
    const uid = user?.id;
    if (uid) {
      void drainPendingRideStops(
        uid,
        useRideStore.getState().activeRide?.id ?? null,
      );
    }
  }, [user]);

  // Drain orphaned trip-draft deletes on sign-in too — same rationale as the
  // ride-stop drain above: a cleanup queued after a 401 can't run while signed
  // out, and a same-session re-login (LinkAccountScreen) fires neither the
  // cold-start nor a foreground AppState event the monitor waits on. Keyed on
  // the `user` OBJECT so a same-account re-auth (unchanged id, fresh object)
  // still triggers it.
  useEffect(() => {
    const uid = user?.id;
    if (uid) void drainTripDraftCleanups(uid);
  }, [user]);

  // #M4 — cancel in-flight offline-region downloads the instant `offline_maps`
  // is revoked, even while the rider is off the offline screen. The screen-
  // local gate only fires while that screen is mounted; a downgrade landing via
  // the entitlement refresh after the rider started a download and navigated
  // away would otherwise let the module-level download loop keep writing tiles.
  // Mounted once at app entry so it observes the revocation wherever the rider
  // is (see offlineDownloadRevocationMonitor).
  useEffect(() => startOfflineDownloadRevocationMonitor(), []);

  // Keep the cached entitlement snapshot (tier / features / limits) fresh so
  // the client-enforced gates (road-quality overlay zoom, GPX export) re-check
  // the server on every foreground rather than enforcing whatever was captured
  // at launch. Without this, an operator removing a launch-mode override,
  // force-disabling a feature, or downgrading a rider mid-session would leave
  // the stale snapshot in force until the next login. Refreshes ONLY the
  // entitlement slices (merged into the live profile) so a concurrent
  // profile/preference PATCH isn't clobbered; setters come from `getState()`
  // so the effect stays mount-once.
  //
  // Serialize behind the cold-start bootstrap: until the launch `bootstrapAuth`
  // (full `/users/me`) settles, an entitlement-only refresh that raced ahead
  // would merge fresh entitlements onto the STALE cached profile — leaving
  // cross-device display-name / language / preference changes stale, since
  // later refreshes only touch entitlements. Gate on the store's
  // `bootstrapSettled`, NOT `isLoading`: the optimistic `setUser(cached)` clears
  // `isLoading` early (for instant offline display) while the baseline is still
  // in flight, so `isLoading` would open the gate during the very window we must
  // hold it shut.
  useEffect(
    () =>
      startEntitlementsRefreshMonitor({
        isAuthenticated: () =>
          api.isAuthenticated() && useAuthStore.getState().bootstrapSettled,
        // The monitor only needs the refresh to run to completion (the boolean
        // publish result is for the reactive-prompt callers); await and discard.
        refresh: async () => {
          await refreshEntitlements({
            getSessionSnapshot: () => api.getAuthSessionSnapshot(),
            getProfile: () => api.getProfile(),
            getCurrentUser: () => useAuthStore.getState().user,
            setUser: useAuthStore.getState().setUser,
            cacheProfile: (profile) => api.cacheProfile(profile),
          });
        },
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
          current.timeZone === detected.timeZone &&
          current.uiLocale === detected.uiLocale
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
      currentUserId: () => useAuthStore.getState().user?.id ?? null,
      pendingSelection: () =>
        usePreferencesStore.getState().pendingUiLocaleSync,
      accountLocale: () => useAuthStore.getState().user?.language,
      sync: async (selection) => {
        const { locale: pendingLocale, ownerUserId } = selection;
        const userId = useAuthStore.getState().user?.id;
        if (!userId) return;
        await api.updateProfile({ language: pendingLocale });
        const auth = useAuthStore.getState();
        const current = auth.user;
        const preferences = usePreferencesStore.getState();
        if (
          current?.id !== userId ||
          preferences.pendingUiLocaleSync?.locale !== pendingLocale ||
          preferences.pendingUiLocaleSync.ownerUserId !== ownerUserId
        ) {
          return;
        }

        const merged = { ...current, language: pendingLocale };
        api.cacheProfile(merged);
        auth.setUser(merged);
        preferences.completeUiLocaleSync(pendingLocale, ownerUserId);
      },
      onAlreadySynced: ({ locale: pendingLocale, ownerUserId }) => {
        usePreferencesStore
          .getState()
          .completeUiLocaleSync(pendingLocale, ownerUserId);
      },
      onOwnerMismatch: ({ locale: pendingLocale, ownerUserId }) => {
        usePreferencesStore
          .getState()
          .discardUiLocaleSync(pendingLocale, ownerUserId);
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
        <I18nProvider
          locale={locale ?? null}
          numberLocale={formatLocale ?? null}
        >
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
