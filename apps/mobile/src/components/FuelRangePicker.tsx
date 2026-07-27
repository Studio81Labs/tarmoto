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
  clampFuelRangeKm,
  FUEL_RANGE_BOUNDS,
  FUEL_RANGE_STEP_KM,
} from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";
import { useFormat } from "@/format/FormatProvider";

interface Props {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  helpText?: string;
}

const t = brandColorsLight;

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
  const format = useFormat();
  // Share the exact clamp/snap rules with the preferences store so the
  // highlighted pill always matches whatever the store decided to keep.
  const active = clampFuelRangeKm(value);

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{format.distanceKm(active)}</Text>
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
          text: format.distanceKm(active),
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
              accessibilityLabel={format.distanceKm(step)}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.pillText,
                  selected ? styles.pillTextSelected : null,
                ]}
              >
                {format.distanceKm(step)}
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
    gap: brandSpacing.s2,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  label: {
    // `dim` (AA on white), not the muted eyebrow tone — this labels the value.
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  value: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  pillRow: {
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
  },
  pill: {
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised,
    minWidth: 64,
    alignItems: "center",
  },
  pillSelected: {
    backgroundColor: t.accent,
    borderColor: t.accent,
  },
  pillText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  pillTextSelected: {
    color: "#0E0E10",
  },
  help: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
});
