import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityLabel,
  spacing,
} from "@/theme";
import QualityThresholdSlider from "@/components/QualityThresholdSlider";
import { usePreferencesStore } from "@/stores";

export default function SettingsScreen() {
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const setMinQuality = usePreferencesStore((s) => s.setMinQuality);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Route quality</Text>
        <Text style={styles.sectionBody}>
          Routes and road segments below your minimum are grayed out so you can
          focus on the roads you actually want to ride.
        </Text>

        <QualityThresholdSlider
          value={minQuality}
          onChange={setMinQuality}
          label="Minimum quality"
          helpText={`Currently showing ${qualityLabel(minQuality)} and above.`}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  sectionBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
});
