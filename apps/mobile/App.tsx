/**
 * Tarmoto — Know the road before you ride it.
 * React Native App Entry Point
 */

import React, { useEffect } from "react";
import { StatusBar, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RootNavigator from "@/navigation/RootNavigator";
import { startCommuteHazardMonitor } from "@/services/commuteHazardNotifier";
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
