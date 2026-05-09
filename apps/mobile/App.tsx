/**
 * Tarmoto — Know the road before you ride it.
 * React Native App Entry Point
 */

import React, { useEffect } from "react";
import { StatusBar, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RootNavigator from "@/navigation/RootNavigator";
import { api } from "@/services/api";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
import { startPrivacyRefreshMonitor } from "@/services/privacyRefreshMonitor";
import { colors } from "@/theme";

// Suppress specific warnings in dev
LogBox.ignoreLogs([
  "Non-serializable values were found in the navigation state",
]);

export default function App() {
  // US-15 AC #2: run a commute hazard check on every cold start and
  // foreground transition. Mounted once at the app root so the monitor
  // keeps running across navigation — CommuteScreen's diff UI remains
  // the view-of-record; this hook just surfaces NEW hazards as a
  // pre-ride alert without forcing the rider to visit that tab first.
  useEffect(() => startCommuteHazardMonitor(), []);

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar
          barStyle="light-content"
          backgroundColor={colors.bg}
          translucent
        />
        <RootNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
