/**
 * Shared label/value pair used across the Ride screens (US-19).
 *
 * Originally each screen had a private `Metric` helper that rendered the
 * same uppercase label / bold value pair with the same `valueColor`
 * override. The two implementations were essentially identical and used
 * to drift on small style tweaks; consolidating them here keeps the
 * history list, summary card, and HUD in lockstep.
 *
 * The `size` prop covers the only legitimate difference between the
 * two prior versions: the past-ride detail card uses a slightly larger
 * value font than the history-list card. Default is "md" — the more
 * common case.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight } from "@/theme";

export interface RideMetricProps {
  label: string;
  value: string;
  /** Override the value text colour (e.g. quality colouring). */
  valueColor?: string;
  /** "md" for the history list / HUD, "lg" for the past-ride summary. */
  size?: "md" | "lg";
}

export default function RideMetric({
  label,
  value,
  valueColor,
  size = "md",
}: RideMetricProps) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[
          styles.metricValue,
          size === "lg" ? styles.metricValueLg : styles.metricValueMd,
          valueColor ? { color: valueColor } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  metricValue: {
    color: colors.textPrimary,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  metricValueMd: {
    fontSize: fontSize.md,
  },
  metricValueLg: {
    fontSize: fontSize.lg,
  },
});
