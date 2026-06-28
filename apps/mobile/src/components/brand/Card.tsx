import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { brandColorsDark, brandColorsLight, brandRadii } from "@/theme/brand";

interface CardProps {
  children: React.ReactNode;
  /** Render on a dark/immersive surface. */
  onDark?: boolean;
  /** Use the brighter raised surface (white-ish) instead of `raised2`. */
  raised?: boolean;
  /** Tint the border with the accent (for highlighted/active cards). */
  accentBorder?: boolean;
  /** Inner padding. Pass 0 for list-style cards that own their own rows. */
  pad?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Paper-on-paper surface — brand rule #5. Ported from `Card` in
 * `chrome.jsx`. A cream/ink raised panel with a hairline border and no drop
 * shadow (shadows are reserved for devices).
 */
export default function Card({
  children,
  onDark = false,
  raised = false,
  accentBorder = false,
  pad = 16,
  style,
}: CardProps) {
  const t = onDark ? brandColorsDark : brandColorsLight;
  const backgroundColor = onDark ? t.raised : raised ? t.raised : t.raised2;
  const borderColor = accentBorder
    ? t.accent + "66"
    : onDark
      ? t.invLine
      : t.line;
  return (
    <View
      style={[
        styles.card,
        { backgroundColor, borderColor, padding: pad },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: brandRadii.md,
    borderWidth: 1,
  },
});
