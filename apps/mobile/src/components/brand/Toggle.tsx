import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  brandColorsDark,
  brandColorsLight,
  TOGGLE_OFF_TRACK,
} from "@/theme/brand";

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
  const offTrack = onDark ? TOGGLE_OFF_TRACK.dark : TOGGLE_OFF_TRACK.light;
  return (
    <Pressable
      onPress={() => onToggle?.(!on)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
      // Track is 28px tall; expand the touch box to the design's glove-first
      // 44px minimum without growing the visual control (matches Chip).
      hitSlop={TOGGLE_HIT_SLOP}
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

/** Grows the 28px-tall track's touch box to the 44px glove-first target. */
const TOGGLE_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 } as const;

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
