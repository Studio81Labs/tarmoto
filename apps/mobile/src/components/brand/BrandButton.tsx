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

type ButtonSize = "sm" | "md" | "lg";

interface BrandButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  /** Accent (orange) fill. */
  accent?: boolean;
  /** Transparent fill with a border. */
  ghost?: boolean;
  /** Render on a dark surface. */
  onDark?: boolean;
  size?: ButtonSize;
  /** Optional leading element (e.g. a `BrandIcon`). */
  icon?: React.ReactNode;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

const PADDING: Record<ButtonSize, { v: number; h: number }> = {
  lg: { v: 17, h: 22 },
  md: { v: 14, h: 19 },
  sm: { v: 10, h: 15 },
};
const FONT_SIZE: Record<ButtonSize, number> = { lg: 16.5, md: 15, sm: 13 };

/**
 * Primary brand button. Ported from `Btn` in `mobile/tokens.jsx`.
 *
 * Three fills: solid ink (default), accent (orange), and ghost (outlined).
 * The `onDark` flag flips ink/cream so the default and ghost variants read
 * correctly over dark surfaces.
 */
export default function BrandButton({
  children,
  onPress,
  accent = false,
  ghost = false,
  onDark = false,
  size = "md",
  icon,
  disabled = false,
  accessibilityLabel,
  style,
}: BrandButtonProps) {
  const t = brandColorsLight;
  const pad = PADDING[size];

  let backgroundColor: string;
  let color: string;
  let borderColor = "transparent";
  let borderWidth = 0;
  if (accent) {
    backgroundColor = t.accent;
    color = "#0E0E10";
  } else if (ghost) {
    backgroundColor = "transparent";
    color = onDark ? "#F3EEE6" : t.fg;
    borderColor = onDark ? t.invLine : t.lineStrong;
    borderWidth = 1;
  } else {
    backgroundColor = onDark ? "#F3EEE6" : t.fg;
    color = onDark ? "#0E0E10" : t.bg;
  }

  // react-native-svg doesn't cascade text colour into a child icon, so push
  // the resolved label colour into the leading icon. An explicit `color` on
  // the icon still wins.
  const renderedIcon = React.isValidElement<{ color?: string }>(icon)
    ? React.cloneElement(icon, { color: icon.props.color ?? color })
    : icon;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={[
        styles.button,
        {
          paddingVertical: pad.v,
          paddingHorizontal: pad.h,
          backgroundColor,
          borderColor,
          borderWidth,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {renderedIcon ? <View style={styles.icon}>{renderedIcon}</View> : null}
      <Text style={[styles.label, { color, fontSize: FONT_SIZE[size] }]}>
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    borderRadius: 14,
    width: "100%",
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontFamily: brandFonts.sans,
    fontWeight: "800",
    letterSpacing: 0.1,
  },
});
