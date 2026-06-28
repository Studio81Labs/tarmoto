import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { brandColorsDark, brandColorsLight } from "@/theme/brand";

interface ToggleProps {
  /** On/off state. */
  on: boolean;
  onToggle?: (next: boolean) => void;
  /** Render on a dark/immersive surface. */
  onDark?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * Brand on/off switch — accent track when on, ink/cream track when off, with
 * a white knob. Ported from `Toggle` in `screens-e.jsx`. Replaces the native
 * `Switch` on brand surfaces so the control matches the design (the platform
 * Switch can't take the accent track cleanly).
 */
export default function Toggle({
  on,
  onToggle,
  onDark = false,
  disabled = false,
  accessibilityLabel,
}: ToggleProps) {
  const t = onDark ? brandColorsDark : brandColorsLight;
  const offTrack = onDark ? "rgba(243,238,230,0.18)" : "rgba(14,14,16,0.16)";
  return (
    <Pressable
      onPress={() => onToggle?.(!on)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.track,
        {
          backgroundColor: on ? t.accent : offTrack,
          justifyContent: on ? "flex-end" : "flex-start",
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View style={styles.knob} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 46,
    height: 28,
    borderRadius: 999,
    padding: 3,
    flexDirection: "row",
  },
  knob: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: "#fff",
    // The one allowed shadow exception — a small lift on the moving knob.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 2,
  },
});
