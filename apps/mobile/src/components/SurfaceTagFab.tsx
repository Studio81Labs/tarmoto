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
 *   - accent disc (with an ink glyph) instead of the red hazard disc —
 *     a different action class
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
import { Icon } from "@/components/Icon";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { SURFACE_LABELS, type SurfaceLabel } from "@tarmoto/shared";
import {
  ACCENT,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";

type IconName = ComponentProps<typeof Icon>["name"];

// The tag picker is a modal dialog over the dark ride HUD → a cream brand
// dialog. The FAB disc is the accent (distinct from the red hazard FAB),
// with an ink glyph: ink (`invBg`) on the accent disc clears ~7.4:1, whereas
// a cream glyph would only reach ~2.5:1 — below the 3:1 non-text floor.
const t = brandColorsLight;

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
        <Icon name="road-variant" size={26} color={t.invBg} />
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
                    <Icon name={display.icon} size={26} color={t.fg} />
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
    backgroundColor: ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
  },
  menuCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: t.raised,
    borderRadius: brandRadii.lg,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  menuTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  menuSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  menuGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
  },
  menuTile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 80,
    paddingVertical: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s2,
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s1,
  },
  menuTileLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
  },
});
