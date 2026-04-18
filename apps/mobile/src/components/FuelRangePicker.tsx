/**
 * Fuel-range picker (US-10).
 *
 * Row of tappable pills snapped to 50 km steps. A scrolling strip rather
 * than a slider keeps the component free of the native slider dep and
 * makes the exact value the rider picked obvious on screen.
 */

import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  borderRadius,
  clampFuelRangeKm,
  colors,
  fontSize,
  fontWeight,
  spacing,
  FUEL_RANGE_BOUNDS,
  FUEL_RANGE_STEP_KM,
} from "@/theme";

interface Props {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  helpText?: string;
}

const STEPS = buildSteps();

function buildSteps(): readonly number[] {
  const steps: number[] = [];
  for (
    let km = FUEL_RANGE_BOUNDS.min;
    km <= FUEL_RANGE_BOUNDS.max;
    km += FUEL_RANGE_STEP_KM
  ) {
    steps.push(km);
  }
  return steps;
}

export default function FuelRangePicker({
  value,
  onChange,
  label,
  helpText,
}: Props) {
  // Share the exact clamp/snap rules with the preferences store so the
  // highlighted pill always matches whatever the store decided to keep.
  const active = clampFuelRangeKm(value);

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{active} km</Text>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillRow}
        accessibilityRole="adjustable"
        accessibilityValue={{
          min: FUEL_RANGE_BOUNDS.min,
          max: FUEL_RANGE_BOUNDS.max,
          now: active,
        }}
      >
        {STEPS.map((step) => {
          const selected = step === active;
          return (
            <TouchableOpacity
              key={step}
              style={[styles.pill, selected ? styles.pillSelected : null]}
              onPress={() => onChange(step)}
              accessibilityRole="button"
              accessibilityLabel={`${step} kilometres`}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.pillText,
                  selected ? styles.pillTextSelected : null,
                ]}
              >
                {step}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

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
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  pillRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    minWidth: 64,
    alignItems: "center",
  },
  pillSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  pillTextSelected: {
    color: colors.textInverse,
  },
  help: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
});
