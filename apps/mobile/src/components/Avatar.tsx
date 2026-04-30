import React from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { borderRadius, colors, fontWeight } from "@/theme";

interface AvatarProps {
  uri?: string | null;
  name: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Returns up to 2 uppercase initials from `name`, falling back to "?" when
 * the input is empty/whitespace-only or otherwise yields no alphanumeric
 * characters. Without the filter step, `"  Alice".split(/\s+/)` would emit
 * an empty leading word whose first char is `undefined` — joining that
 * back yields the literal string `"undefined"` and the fallback would
 * render the wrong initials.
 */
export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "?";
  const letters = name
    .split(/\s+/)
    .map((word) => word[0])
    .filter((ch): ch is string => typeof ch === "string" && ch.length > 0)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
}

export default function Avatar({ uri, name, size = 64, style }: AvatarProps) {
  const dim = { width: size, height: size, borderRadius: size / 2 };
  if (uri) {
    // `Image` only accepts `ImageStyle`. The optional `style` prop is
    // typed as `ViewStyle` for the View fallback below; flatten and
    // cast so callers can pass a single style API for both branches
    // without leaking RN's split style types into the public API.
    return (
      <Image
        source={{ uri }}
        style={[styles.image, dim, style as StyleProp<ViewStyle>] as never}
        accessibilityLabel={`${name} avatar`}
      />
    );
  }
  return (
    <View
      style={[styles.fallback, dim, style]}
      accessibilityLabel={`${name} avatar`}
    >
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>
        {initialsFromName(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: colors.bgCard,
  },
  fallback: {
    backgroundColor: colors.primaryAlpha15,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: borderRadius.pill,
  },
  initials: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
});
