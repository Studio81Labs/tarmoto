/**
 * RideActiveScreen — placeholder body, US-4 quick-report FAB.
 *
 * The full ride-time HUD is still a separate issue. The FAB is wired in
 * here so the report-hazard entry point is available the moment a rider
 * starts a free / commute / trip ride: tap for the full form, long-press
 * for the quick-pick menu. When the real HUD lands, the FAB stays put
 * (positioned absolutely, bottom-right) and the placeholder body is
 * replaced with the ride telemetry layout.
 */

import React, { useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import HazardReportFab from "@/components/HazardReportFab";
import { colors, fontSize, fontWeight, spacing } from "@/theme";
import type { HazardType } from "@/types";
import type { RideStackParamList } from "@/navigation/RootNavigator";

type RideActiveNav = NativeStackNavigationProp<
  RideStackParamList,
  "RideActive"
>;

export default function RideActiveScreen() {
  const navigation = useNavigation<RideActiveNav>();
  const handleOpenReport = useCallback(
    (preselectedType?: HazardType) => {
      navigation.navigate(
        "HazardReport",
        preselectedType ? { preselectedType } : undefined,
      );
    },
    [navigation],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RideActive</Text>
      <Text style={styles.subtitle}>TODO: Implement RideActiveScreen</Text>

      <HazardReportFab
        onOpenReport={handleOpenReport}
        style={styles.hazardFab}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
  },
  hazardFab: {
    position: "absolute",
    right: spacing.lg,
    bottom: spacing.xxxl,
  },
});
