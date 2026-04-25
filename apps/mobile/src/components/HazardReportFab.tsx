/**
 * HazardReportFab — US-4 AC #8.
 *
 * The single-tap quick-report affordance shown on MapScreen and during
 * an active ride. Two interactions:
 *
 *   - tap → navigate to the HazardReport modal with no preselected type
 *   - long-press → open a 9-item quick-pick menu; selecting a tile
 *     navigates to HazardReport with `preselectedType` already set so
 *     the rider can submit with one more tap (severity defaults to
 *     `medium`, location is captured automatically).
 *
 * The component is parametric over the navigation prop so the same
 * code drives both the Map tab (MapStackParamList) and the Ride tab
 * (RideStackParamList). Both stacks registered HazardReport with the
 * same params shape, so a generic constraint is enough.
 */

import React, {
  type ComponentProps,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { HAZARD_TYPE_LABELS, HAZARD_TYPE_ORDER } from "@/constants/hazards";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  hazardIcons,
  shadows,
  spacing,
} from "@/theme";
import type { HazardType } from "@/types";

type IconName = ComponentProps<typeof Icon>["name"];

interface HazardReportFabProps {
  /**
   * Open the report screen. Caller wires this to the right
   * `navigation.navigate("HazardReport", …)` for whichever stack the
   * FAB sits in.
   */
  onOpenReport: (preselectedType?: HazardType) => void;
  /** Override styling (e.g. positioning) without forking the component. */
  style?: ComponentProps<typeof View>["style"];
}

export default function HazardReportFab({
  onOpenReport,
  style,
}: HazardReportFabProps) {
  const [menuVisible, setMenuVisible] = useState(false);
  // RN's Pressability mostly suppresses `onPress` after a long-press,
  // but the suppression is platform- and gesture-dependent: a fast
  // release after the long-press threshold can still fire `onPress`,
  // which would navigate to the form with no preselected type and
  // immediately render under the just-opened quick-pick modal. The
  // ref is the simplest reliable guard — we set it the moment
  // `onLongPress` fires and consume it on the next `onPress` so the
  // tap path is a no-op once per long-press cycle.
  const longPressFiredRef = useRef(false);

  const handlePress = useCallback(() => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onOpenReport();
  }, [onOpenReport]);

  const handleLongPress = useCallback(() => {
    longPressFiredRef.current = true;
    setMenuVisible(true);
  }, []);

  const handleSelect = useCallback(
    (type: HazardType) => {
      setMenuVisible(false);
      onOpenReport(type);
    },
    [onOpenReport],
  );

  const closeMenu = useCallback(() => {
    setMenuVisible(false);
  }, []);

  return (
    <>
      <TouchableOpacity
        style={[styles.fab, style]}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityLabel="Report hazard"
        accessibilityHint="Tap to report. Long-press for quick hazard types."
      >
        <Icon name="alert-octagon" size={26} color={colors.textInverse} />
      </TouchableOpacity>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={closeMenu}
          accessibilityRole="button"
          accessibilityLabel="Close hazard quick-pick"
        >
          {/* Stop the press from closing when interacting with the
              menu itself. The inner Pressable's `onPress` is a no-op
              because tile presses are handled per-tile. */}
          <Pressable style={styles.menuCard} onPress={() => undefined}>
            <Text style={styles.menuTitle}>Quick report</Text>
            <Text style={styles.menuSubtitle}>
              Tap a hazard type — you can adjust severity on the next screen.
            </Text>
            <View style={styles.menuGrid}>
              {HAZARD_TYPE_ORDER.map((type) => (
                <TouchableOpacity
                  key={type}
                  style={styles.menuTile}
                  onPress={() => handleSelect(type)}
                  accessibilityRole="button"
                  accessibilityLabel={`Report ${HAZARD_TYPE_LABELS[type]}`}
                >
                  <Icon
                    name={(hazardIcons[type] ?? "alert-circle") as IconName}
                    size={26}
                    color={colors.primary}
                  />
                  <Text style={styles.menuTileLabel}>
                    {HAZARD_TYPE_LABELS[type]}
                  </Text>
                </TouchableOpacity>
              ))}
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
    backgroundColor: colors.danger,
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
