import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { brandColorsLight, QUALITY_COLORS, qualityIndex } from "@/theme/brand";

interface QualityBarsProps {
  /** Quality score 1–5. Rounded to the nearest bucket for the ramp. */
  q: number;
  /** Width of a single bar in px (height is `size * 1.85`). */
  size?: number;
  /** Gap between bars in px. */
  gap?: number;
  /** Colour for the unfilled bars. Defaults to the brand empty tone. */
  empty?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The five-bar road-quality meter — brand rule #4 ("quality is visual
 * vocabulary"). Ported from `QBars` in `mobile/tokens.jsx`.
 *
 * Filled bars (1..q) take the Q-ramp colour; the rest take `empty`. The
 * fill colour is the score's bucket colour (so a q=4 meter is all-Q4),
 * matching the prototype.
 */
export default function QualityBars({
  q,
  size = 7,
  gap = 2,
  empty,
  style,
}: QualityBarsProps) {
  const fill = QUALITY_COLORS[qualityIndex(q)];
  const emptyColor = empty ?? brandColorsLight.qEmpty;
  return (
    <View style={[styles.row, { gap }, style]}>
      {[1, 2, 3, 4, 5].map((n) => (
        <View
          key={n}
          style={{
            width: size,
            height: size * 1.85,
            borderRadius: 2,
            backgroundColor: n <= q ? fill : emptyColor,
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
