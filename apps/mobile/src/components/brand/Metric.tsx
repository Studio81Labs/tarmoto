import React from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { brandColorsLight, brandFonts } from "@/theme/brand";
import Stamp from "./Stamp";

interface MetricProps {
  /** The headline number/value. */
  value: React.ReactNode;
  /** Optional unit suffix (rendered mono, smaller). */
  unit?: string;
  /** Optional stamp label below the value. */
  label?: string;
  /** Override value colour. */
  color?: string;
  /** Render on a dark surface. */
  onDark?: boolean;
  /** Value font size in px. */
  size?: number;
  align?: "left" | "center";
  style?: StyleProp<ViewStyle>;
}

/**
 * Big numeric metric block (value + unit + stamp label). Ported from
 * `Metric` in `mobile/tokens.jsx`. Used across the home stat strip,
 * ride summary, and road detail.
 */
export default function Metric({
  value,
  unit,
  label,
  color,
  onDark = false,
  size = 26,
  align = "left",
  style,
}: MetricProps) {
  const t = brandColorsLight;
  const valueColor = color ?? (onDark ? "#F3EEE6" : t.fg);
  const muteColor = onDark ? t.invDim : t.mute;
  return (
    <View
      style={[
        { alignItems: align === "center" ? "center" : "flex-start" },
        style,
      ]}
    >
      <View
        style={[
          styles.valueRow,
          { justifyContent: align === "center" ? "center" : "flex-start" },
        ]}
      >
        <Text style={[styles.value, { fontSize: size, color: valueColor }]}>
          {value}
        </Text>
        {unit ? (
          <Text
            style={[styles.unit, { fontSize: size * 0.4, color: muteColor }]}
          >
            {unit}
          </Text>
        ) : null}
      </View>
      {label ? (
        <Stamp size={9} color={muteColor} style={styles.label}>
          {label}
        </Stamp>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 3,
  },
  value: {
    fontFamily: brandFonts.sans,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  unit: {
    fontFamily: brandFonts.mono,
    fontWeight: "600",
  },
  label: {
    marginTop: 5,
  },
});
