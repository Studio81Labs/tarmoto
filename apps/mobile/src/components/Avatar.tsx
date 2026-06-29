import React from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { initialsFromName } from "@tarmoto/shared";
import { brandColorsLight, brandFontWeight } from "@/theme/brand";

// Re-exported for the Avatar test file and any caller that prefers the
// component-local import. The implementation lives in `@tarmoto/shared`
// so it stays in lockstep with the companion's avatar fallback.
export { initialsFromName };

interface AvatarProps {
  uri?: string | null;
  name: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
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

// Brand light-surface styling (cream/white card). Ink initials on a cream
// tint read clearly without leaning on the accent (kept <5% of pixels).
const styles = StyleSheet.create({
  image: {
    backgroundColor: brandColorsLight.raised2,
  },
  fallback: {
    backgroundColor: brandColorsLight.raised2,
    borderWidth: 1,
    borderColor: brandColorsLight.lineStrong,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  initials: {
    color: brandColorsLight.fg,
    fontWeight: brandFontWeight.bold,
  },
});
