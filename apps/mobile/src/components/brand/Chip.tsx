import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { brandColorsLight, brandFonts } from "@/theme/brand";

interface ChipProps {
  children: React.ReactNode;
  /** Selected state. */
  active?: boolean;
  onPress?: () => void;
  /** When active, use the accent fill instead of the ink fill. */
  accent?: boolean;
  /** Render on a dark surface (e.g. floating over the map). */
  onDark?: boolean;
  /** Optional leading element (e.g. a small icon). */
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Toggle / filter pill. Ported from `Chip` in `mobile/tokens.jsx`.
 *
 * Three visual states resolve from `active` × `accent` × `onDark`:
 * idle (outlined), active-ink (filled ink/cream), active-accent (orange).
 */
export default function Chip({
  children,
  active = false,
  onPress,
  accent = false,
  onDark = false,
  icon,
  style,
}: ChipProps) {
  const t = brandColorsLight;
  const borderColor = active ? "transparent" : onDark ? t.invLine : t.line;
  const backgroundColor = active
    ? accent
      ? t.accent
      : onDark
        ? "#F3EEE6"
        : t.fg
    : onDark
      ? "rgba(255,255,255,0.06)"
      : "transparent";
  const color = active
    ? accent
      ? "#0E0E10"
      : onDark
        ? "#0E0E10"
        : t.bg
    : onDark
      ? "#F3EEE6"
      : t.fg;

  // Push the resolved label colour into the leading icon — react-native-svg
  // doesn't cascade text colour. An explicit `color` on the icon wins.
  const renderedIcon = React.isValidElement<{ color?: string }>(icon)
    ? React.cloneElement(icon, { color: icon.props.color ?? color })
    : icon;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      // The pill stays visually compact, but the design is glove-first:
      // "minimum 44px hit targets" (mobile UI kit). The chip renders ~32px
      // tall, so expand the touch region by 7px top/bottom (≈46px) without
      // changing layout. See docs/design/mobile-spec/source/ui_kits/mobile/mobile.html.
      hitSlop={CHIP_HIT_SLOP}
      style={[styles.chip, { backgroundColor, borderColor }, style]}
    >
      {renderedIcon ? <View style={styles.icon}>{renderedIcon}</View> : null}
      <Text style={[styles.label, { color }]}>{children}</Text>
    </Pressable>
  );
}

/** Expands the compact pill's touch region to the 44px glove-first target. */
const CHIP_HIT_SLOP = { top: 7, bottom: 7, left: 6, right: 6 } as const;

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 12.5,
    letterSpacing: 0.1,
  },
});
