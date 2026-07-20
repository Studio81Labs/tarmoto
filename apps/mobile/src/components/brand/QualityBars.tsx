import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  brandColorsDark,
  brandColorsLight,
  QUALITY_COLORS,
  qualityIndex,
} from "@/theme/brand";
import { translate } from "@/i18n";

interface QualityBarsProps {
  /**
   * Quality score 1–5, rounded to the nearest bucket for the ramp. `null` /
   * `undefined` (or a non-finite value) renders the unscored placeholder —
   * all bars empty — because the road-quality contract models unmeasured
   * roads as `number | null` and an unmeasured road is NOT a 1/5 road.
   */
  q: number | null | undefined;
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
 * matching the prototype. An unscored road (`q == null`) renders all bars
 * empty. The container is a single accessible node so the score (or its
 * absence) reaches TalkBack/VoiceOver instead of five anonymous views.
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
  // Unscored (null / non-finite) fills nothing — an unmeasured road must not
  // read as the worst bucket.
  const scored = q != null && Number.isFinite(q);
  const bucket = qualityIndex(q);
  const fill = QUALITY_COLORS[bucket];
  const filled = scored ? bucket + 1 : 0;
  const emptyColor =
    empty ?? (onDark ? brandColorsDark.qEmpty : brandColorsLight.qEmpty);
  const defaultLabel = scored
    ? translate("Quality {score} of 5", { score: filled })
    : translate("Quality unscored");
  return (
    <View
      style={[styles.row, { gap }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? defaultLabel}
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
