import React from "react";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import { brandColorsLight, brandFonts } from "@/theme/brand";

interface StampProps {
  children: React.ReactNode;
  /** Override colour. Defaults to the muted brand foreground. */
  color?: string;
  /** Font size in px. Stamps are deliberately tiny (9–11). */
  size?: number;
  style?: StyleProp<TextStyle>;
}

/**
 * Mono, uppercase, letter-spaced micro-label — the brand "stamp".
 *
 * Ported from `Stamp` in `mobile/tokens.jsx` (design handoff). Used for
 * section headers, eyebrow labels, and metadata throughout the brand UI.
 */
export default function Stamp({
  children,
  color,
  size = 10,
  style,
}: StampProps) {
  return (
    <Text
      style={[
        styles.stamp,
        { fontSize: size, color: color ?? brandColorsLight.mute },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  stamp: {
    fontFamily: brandFonts.mono,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
});
