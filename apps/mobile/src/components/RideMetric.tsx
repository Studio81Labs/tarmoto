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
 *
 * Both callers (`RideDetailScreen` summary + `RideScreen` history list)
 * are on the brand, so this renders the cream/white brand styling.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { brandColorsLight, brandFonts } from "@/theme/brand";

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

// Brand light-surface styling. Mono value reads as a "stamp" number; the
// `dim` label clears AA on the white card.
const styles = StyleSheet.create({
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontWeight: "600",
  },
  metricValue: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.mono,
    fontWeight: "700",
    marginTop: 2,
  },
  metricValueMd: {
    fontSize: 14,
  },
  metricValueLg: {
    fontSize: 18,
  },
});
