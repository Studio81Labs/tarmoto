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
 * Surface-aware: shared between the brand-migrated past-ride summary
 * (`RideDetailScreen`, `light`) and the still-legacy ride history / HUD
 * (`RideScreen`, default). Pass `light` only on the cream/white brand
 * surfaces; the default keeps the legacy dark palette so unmigrated
 * callers stay legible.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight } from "@/theme";
import { brandColorsLight, brandFonts } from "@/theme/brand";

export interface RideMetricProps {
  label: string;
  value: string;
  /** Override the value text colour (e.g. quality colouring). */
  valueColor?: string;
  /** "md" for the history list / HUD, "lg" for the past-ride summary. */
  size?: "md" | "lg";
  /** Render on a light brand surface (cream/white). Default: legacy dark. */
  light?: boolean;
}

export default function RideMetric({
  label,
  value,
  valueColor,
  size = "md",
  light = false,
}: RideMetricProps) {
  const styles = light ? brandStyles : legacyStyles;
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

// Legacy dark-surface styling — unchanged so the still-legacy RideScreen
// renders exactly as before.
const legacyStyles = StyleSheet.create({
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

// Brand light-surface styling. Mono value reads as a "stamp" number; the
// `dim` label clears AA on the white card.
const brandStyles = StyleSheet.create({
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
