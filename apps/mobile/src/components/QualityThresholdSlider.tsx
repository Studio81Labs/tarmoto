/**
 * Minimum road-quality threshold selector.
 *
 * Five tappable pills (1..5) mapped to the `qualityLabel` scale. Using a
 * pill selector rather than a continuous slider avoids the native
 * `@react-native-community/slider` dependency and matches the coarse
 * quality buckets riders actually reason about.
 */

import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  AccessibilityRole,
} from "react-native";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityColor,
  qualityLabel,
  spacing,
  MIN_QUALITY_BOUNDS,
} from "@/theme";

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
  const activeColor = qualityColor(active);

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          <Text style={[styles.value, { color: activeColor }]}>
            {activeLabel}
          </Text>
        </View>
      ) : null}

      <View
        style={styles.pillRow}
        accessibilityRole={"adjustable" as AccessibilityRole}
        accessibilityValue={{ min: 1, max: 5, now: active }}
      >
        {STEPS.map((step) => {
          const selected = step === active;
          const stepColor = qualityColor(step);
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
              accessibilityLabel={`${qualityLabel(step)} or better`}
              accessibilityState={{ selected }}
            >
              <Text
                style={[styles.pillText, selected && styles.pillTextSelected]}
              >
                {step}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {helpText ? <Text style={styles.help}>{helpText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  value: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  pillRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  pill: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  pillTextSelected: {
    color: colors.textInverse,
  },
  help: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
});
