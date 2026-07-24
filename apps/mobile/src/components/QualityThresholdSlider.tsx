/**
 * Minimum road-quality threshold selector.
 *
 * Five tappable pills (1..5) mapped to the `qualityLabel` scale. Using a
 * pill selector rather than a continuous slider avoids the native
 * `@react-native-community/slider` dependency and matches the coarse
 * quality buckets riders actually reason about.
 *
 * Renders on the cream/white brand surface (both callers — Settings and
 * TripCreate — are migrated). The active value reads as ink text plus a
 * quality-ramp swatch; the ramp lives on the swatch + selected pill rather
 * than as text, so it stays AA-legible on white.
 */

import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  AccessibilityRole,
} from "react-native";
import { qualityLabel, MIN_QUALITY_BOUNDS } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
} from "@/theme/brand";
import { getFormatters } from "@/format";
import { t as translate } from "@/i18n";

interface Props {
  value: number;
  onChange: (value: number) => void;
  /** Optional label rendered above the pills. */
  label?: string;
  /** Extra helper text rendered below the pills. */
  helpText?: string;
}

const STEPS = [
  MIN_QUALITY_BOUNDS.min,
  MIN_QUALITY_BOUNDS.min + 1,
  MIN_QUALITY_BOUNDS.min + 2,
  MIN_QUALITY_BOUNDS.min + 3,
  MIN_QUALITY_BOUNDS.max,
] as const;

export default function QualityThresholdSlider({
  value,
  onChange,
  label,
  helpText,
}: Props) {
  const active = Math.max(
    MIN_QUALITY_BOUNDS.min,
    Math.min(MIN_QUALITY_BOUNDS.max, Math.round(value)),
  );
  const activeLabel = qualityLabel(active);
  const rampColor = qualityBrandColor;

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          {/* Value text stays ink for legibility on the light card; the
              quality colour reads from the swatch + the selected pill. */}
          <View style={styles.valueRow}>
            <View
              style={[styles.swatch, { backgroundColor: rampColor(active) }]}
            />
            <Text style={styles.value}>{activeLabel}</Text>
          </View>
        </View>
      ) : null}

      <View
        style={styles.pillRow}
        accessibilityRole={"adjustable" as AccessibilityRole}
        accessibilityValue={{ min: 1, max: 5, now: active }}
      >
        {STEPS.map((step) => {
          const selected = step === active;
          const stepColor = rampColor(step);
          return (
            <TouchableOpacity
              key={step}
              style={[
                styles.pill,
                selected && {
                  backgroundColor: stepColor,
                  borderColor: stepColor,
                },
              ]}
              onPress={() => onChange(step)}
              accessibilityRole="button"
              accessibilityLabel={translate("{value0} or better", {
                value0: qualityLabel(step),
              })}
              accessibilityState={{ selected }}
            >
              <Text
                style={[styles.pillText, selected && styles.pillTextSelected]}
              >
                {getFormatters().number(step, {
                  useGrouping: false,
                  maximumFractionDigits: 0,
                })}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {helpText ? <Text style={styles.help}>{helpText}</Text> : null}
    </View>
  );
}

// Brand light-surface styling (cream/white card).
const styles = StyleSheet.create({
  container: { gap: brandSpacing.s2 },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  value: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  pillRow: { flexDirection: "row", gap: brandSpacing.s2 },
  pill: {
    flex: 1,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: brandColorsLight.line,
    backgroundColor: brandColorsLight.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  pillText: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "800",
  },
  pillTextSelected: { color: "#0E0E10" },
  help: {
    // `dim` clears AA on the white card; `mute` would be ~2.7:1.
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
});
