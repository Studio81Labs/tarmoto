import React, { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
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

export default function TripCreateScreen() {
  const defaultMinQuality = usePreferencesStore((s) => s.minQuality);
  // `override` is null when the trip follows the rider's current default.
  // Using an explicit flag (rather than comparing values against
  // `defaultMinQuality`) avoids a stale-snapshot bug: if we derived the
  // override from `tripMinQuality !== defaultMinQuality`, changing the
  // default in Settings while this screen sits mounted inside the tab
  // navigator would spuriously report an override the user never set.
  const [override, setOverride] = useState<number | null>(null);
  const tripMinQuality = override ?? defaultMinQuality;
  const overridesDefault = override !== null;

  const handleChange = (value: number) => {
    setOverride(value === defaultMinQuality ? null : value);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New trip</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Road quality for this trip</Text>
        <Text style={styles.sectionBody}>
          The planner will prefer roads at or above this quality. Segments below
          it show dimmed so you still see them as fallbacks.
        </Text>

        <QualityThresholdSlider
          value={tripMinQuality}
          onChange={handleChange}
          label="Minimum quality"
          helpText={
            overridesDefault
              ? `Overrides your default of ${qualityLabel(defaultMinQuality)}.`
              : `Using your default (${qualityLabel(defaultMinQuality)}).`
          }
        />

        {overridesDefault ? (
          <TouchableOpacity
            onPress={() => setOverride(null)}
            style={styles.resetRow}
          >
            <Text style={styles.resetLabel}>Reset to default</Text>
          </TouchableOpacity>
        ) : null}
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
  resetRow: {
    alignSelf: "flex-start",
  },
  resetLabel: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
});
