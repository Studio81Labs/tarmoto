import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  brandColorsDark,
  brandColorsLight,
  QUALITY_COLORS,
  qualityIndex,
} from "@/theme/brand";

interface QualityBarsProps {
  /** Quality score 1–5. Rounded to the nearest bucket for the ramp. */
  q: number;
  /** Width of a single bar in px (height is `size * 1.85`). */
  size?: number;
  /** Gap between bars in px. */
  gap?: number;
  /**
   * Colour for the unfilled bars. Defaults to the brand empty tone for the
   * active surface (see `onDark`).
   */
  empty?: string;
  /**
   * Render on a dark/immersive surface (ride mode, welcome hero). Switches
   * the default empty-bar tone to the night palette so the unfilled bars
   * stay visible. Ignored when `empty` is passed explicitly.
   */
  onDark?: boolean;
  /**
   * Accessible name for the meter. Defaults to `Quality N of 5` (N = the
   * rounded bucket) so the score isn't lost for screen-reader users.
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The five-bar road-quality meter — brand rule #4 ("quality is visual
 * vocabulary"). Ported from `QBars` in `mobile/tokens.jsx`.
 *
 * Filled bars (1..q) take the Q-ramp colour; the rest take `empty`. The
 * fill colour is the score's bucket colour (so a q=4 meter is all-Q4),
 * matching the prototype. The container is a single accessible node so the
 * numeric score reaches TalkBack/VoiceOver instead of five anonymous views.
 */
export default function QualityBars({
  q,
  size = 7,
  gap = 2,
  empty,
  onDark = false,
  accessibilityLabel,
  style,
}: QualityBarsProps) {
  // Derive the colour AND the filled-bar count from the same rounded
  // bucket so a fractional score (e.g. 3.6) can't show the Q4 colour while
  // filling only three bars. `qualityIndex` is 0-based; +1 is the count.
  const bucket = qualityIndex(q);
  const fill = QUALITY_COLORS[bucket];
  const filled = bucket + 1;
  const emptyColor =
    empty ?? (onDark ? brandColorsDark.qEmpty : brandColorsLight.qEmpty);
  return (
    <View
      style={[styles.row, { gap }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? `Quality ${filled} of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <View
          key={n}
          style={{
            width: size,
            height: size * 1.85,
            borderRadius: 2,
            backgroundColor: n <= filled ? fill : emptyColor,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});
