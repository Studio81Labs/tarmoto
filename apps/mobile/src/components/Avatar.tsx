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
import { borderRadius, colors, fontWeight } from "@/theme";

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
