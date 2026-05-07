/**
 * SurfaceTagFab — research issue #7.
 *
 * Lets a rider label the surface they're currently on without leaving
 * the live HUD. One tap on the FAB opens a 6-tile quick-pick; selecting
 * a tile records a `RideTagEvent` via the sensor service which is then
 * shipped alongside the raw readings on ride stop.
 *
 * Tagging is the only research-grade input that can't be derived from
 * the raw sensor stream — without it the on-device classifier has no
 * ground truth to train against. The FAB is intentionally distinct
 * from the hazard FAB:
 *
 *   - blue (info colour) instead of red — different action class
 *   - "road-variant" icon instead of "alert-octagon"
 *   - second tile-tap is a confirmation, not a navigation, so the
 *     rider stays on the HUD throughout
 *
 * The "tag captured" feedback is a single short toast via the shared
 * Alert API to keep the gesture under one tap-cycle: tap FAB → tap
 * surface → toast → back to riding. No nested screens, no forms.
 */

import React, { type ComponentProps, useCallback, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { SURFACE_LABELS, type SurfaceLabel } from "@tarmoto/shared";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  shadows,
  spacing,
} from "@/theme";

type IconName = ComponentProps<typeof Icon>["name"];

const HAPTIC_OPTIONS = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
} as const;

const SURFACE_LABEL_DISPLAY: Record<
  SurfaceLabel,
  { title: string; icon: IconName }
> = {
  smooth_asphalt: { title: "Smooth asphalt", icon: "road" },
  rough_asphalt: { title: "Rough asphalt", icon: "road-variant" },
  cobblestone: { title: "Cobblestone", icon: "view-grid" },
  gravel: { title: "Gravel", icon: "dots-grid" },
  dirt: { title: "Dirt", icon: "terrain" },
  pothole: { title: "Pothole", icon: "alert-circle-outline" },
};

interface SurfaceTagFabProps {
  /**
   * Called when the rider picks a label. Wired to
   * `sensorService.tagSurface` by the parent — kept as a callback so
   * tests can drive the component without a sensor singleton.
   */
  onTag: (label: SurfaceLabel) => void;
  style?: ComponentProps<typeof View>["style"];
}

export default function SurfaceTagFab({ onTag, style }: SurfaceTagFabProps) {
  const [menuVisible, setMenuVisible] = useState(false);

  const open = useCallback(() => setMenuVisible(true), []);
  const close = useCallback(() => setMenuVisible(false), []);

  const handleSelect = useCallback(
    (label: SurfaceLabel) => {
      // Single haptic on the *capture* path so a misclick on the
      // backdrop dismiss doesn't buzz — gives the rider an unmistakable
      // "yes, that recorded" cue without a TTS or visual toast.
      ReactNativeHapticFeedback.trigger("notificationSuccess", HAPTIC_OPTIONS);
      onTag(label);
      setMenuVisible(false);
    },
    [onTag],
  );

  return (
    <>
      <TouchableOpacity
        style={[styles.fab, style]}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel="Tag road surface"
        accessibilityHint="Open the surface tagging menu to label the road you are on right now."
      >
        <Icon name="road-variant" size={26} color={colors.textInverse} />
      </TouchableOpacity>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close surface tag picker"
        >
          <Pressable style={styles.menuCard} onPress={() => undefined}>
            <Text style={styles.menuTitle}>Tag surface</Text>
            <Text style={styles.menuSubtitle}>
              Tap the surface you&apos;re on now — applies until you tag again.
            </Text>
            <View style={styles.menuGrid}>
              {SURFACE_LABELS.map((label) => {
                const display = SURFACE_LABEL_DISPLAY[label];
                return (
                  <TouchableOpacity
                    key={label}
                    style={styles.menuTile}
                    onPress={() => handleSelect(label)}
                    accessibilityRole="button"
                    accessibilityLabel={`Tag as ${display.title}`}
                  >
                    <Icon
                      name={display.icon}
                      size={26}
                      color={colors.primary}
                    />
                    <Text style={styles.menuTileLabel}>{display.title}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.info,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.button,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  menuCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadows.card,
  },
  menuTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  menuSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  menuGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  menuTile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 80,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  menuTileLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textAlign: "center",
  },
});
