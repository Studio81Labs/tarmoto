import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";

interface StatTileProps {
  label: string;
  value: string;
  /** Optional press handler — when present the tile becomes a button. */
  onPress?: () => void;
  /** Override for the default `accessibilityLabel` (= `label`). */
  accessibilityLabel?: string;
  /** Style override for the outer container, used when callers compose it
   *  inside a custom row layout (e.g. spacing between sibling tiles). */
  containerStyle?: ViewStyle;
  /**
   * Render on a light brand surface (cream/white card). Default: legacy dark.
   * Shared with the still-legacy ViewProfileScreen, so the default must stay
   * the dark-theme look.
   */
  light?: boolean;
}

/**
 * Profile stats tile (US-27). Used on both ProfileScreen (own profile) and
 * ViewProfileScreen (other rider) to render counts like "12 Followers" /
 * "7 Following" / "3 Badges". When `onPress` is provided the tile renders
 * as a TouchableOpacity, otherwise as a static View — keeps the static
 * variant out of the press tree so VoiceOver doesn't announce it as
 * tappable.
 */
export default function StatTile({
  label,
  value,
  onPress,
  accessibilityLabel,
  containerStyle,
  light = false,
}: StatTileProps) {
  const styles = light ? brandStyles : legacyStyles;
  if (onPress) {
    return (
      <TouchableOpacity
        style={[styles.tile, containerStyle]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
      >
        <Text style={styles.value}>{value}</Text>
        <Text style={styles.label}>{label}</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View
      style={[styles.tile, containerStyle]}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

// Legacy dark-surface styling — unchanged so the still-legacy
// ViewProfileScreen renders exactly as before.
const legacyStyles = StyleSheet.create({
  tile: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.xs,
  },
  value: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
});

// Brand light-surface styling (white card on cream). Mono value reads as a
// "stamp" number; `dim` label clears AA on white.
const brandStyles = StyleSheet.create({
  tile: {
    flex: 1,
    backgroundColor: brandColorsLight.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: brandColorsLight.line,
    padding: brandSpacing.s4,
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  value: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.mono,
    fontSize: 20,
    fontWeight: "700",
  },
  label: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
});
