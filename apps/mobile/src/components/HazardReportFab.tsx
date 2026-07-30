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
import { Icon } from "@/components/Icon";
import { HAZARD_TYPE_LABELS, HAZARD_TYPE_ORDER } from "@/constants/hazards";
import { hazardIcons } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  QUALITY_COLORS,
  statusFg,
} from "@/theme/brand";
import type { HazardType } from "@/types";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

type IconName = ComponentProps<typeof Icon>["name"];

// The quick-pick is a modal dialog (dimmed backdrop) that pops over either
// the cream MapScreen or the dark ride HUD, so it renders as a cream brand
// dialog. The FAB disc itself is a brand deep-red, legible on both.
const t = brandColorsLight;

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
  const translate = useTranslation();
  // Operator kill switch (`hazard_reporting`, fail-SAFE off /config/flags):
  // an operator disables one-tap reporting during an abuse wave / moderation
  // backlog. Hiding the FAB removes the only tap/long-press entry on both the
  // Map tab and the ride HUD. The deep-link / CarPlay-voice entry that bypasses
  // the FAB is covered by the guard + navigate-back in HazardReportScreen.
  const reportingEnabled = useFeatureKillSwitchActive("hazard_reporting");
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
      // Clearing the ref on every menu-close path matters because
      // Pressability mostly DOESN'T fire the trailing `onPress` after
      // a long-press — so without these resets the flag would stick
      // at `true` and silently swallow the next legitimate tap on
      // the FAB.
      longPressFiredRef.current = false;
      setMenuVisible(false);
      onOpenReport(type);
    },
    [onOpenReport],
  );

  const closeMenu = useCallback(() => {
    // Same reset reason as `handleSelect` — backdrop dismiss / system
    // back button / Modal onRequestClose all funnel through here.
    longPressFiredRef.current = false;
    setMenuVisible(false);
  }, []);

  // Killed: render no affordance at all (all hooks above run first so the
  // hook order stays stable across a force_off flip).
  if (!reportingEnabled) return null;

  return (
    <>
      <TouchableOpacity
        style={[styles.fab, style]}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityLabel={translate("Report hazard")}
        accessibilityHint={translate(
          "Tap to report. Long-press for quick hazard types.",
        )}
      >
        <Icon name="alert-octagon" size={26} color={t.invFg} />
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
          accessibilityLabel={translate("Close hazard quick-pick")}
        >
          {/* Stop the press from closing when interacting with the
              menu itself. The inner Pressable's `onPress` is a no-op
              because tile presses are handled per-tile. */}
          <Pressable style={styles.menuCard} onPress={() => undefined}>
            <Text style={styles.menuTitle}>{translate("Quick report")}</Text>
            <Text style={styles.menuSubtitle}>
              {translate(
                "Tap a hazard type — you can adjust severity on the next screen.",
              )}
            </Text>
            <View style={styles.menuGrid}>
              {HAZARD_TYPE_ORDER.map((type) => (
                <TouchableOpacity
                  key={type}
                  style={styles.menuTile}
                  onPress={() => handleSelect(type)}
                  accessibilityRole="button"
                  accessibilityLabel={translate("Report {value0}", {
                    value0: translate(HAZARD_TYPE_LABELS[type]),
                  })}
                >
                  <Icon
                    name={(hazardIcons[type] ?? "alert-circle") as IconName}
                    size={26}
                    color={t.fg}
                  />
                  <Text style={styles.menuTileLabel}>
                    {translate(HAZARD_TYPE_LABELS[type])}
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
    backgroundColor: statusFg.danger,
    // The deep danger fill carries the disc on the cream MapScreen (~5.5:1)
    // but only ~2.86:1 against the dark ride HUD background, so the shape
    // would recede there. A brighter Q1-red ring clears 3:1 on the night
    // surface (~5.9:1) and is a harmless subtle ring on cream — keeps the
    // FAB legible on both without a surface-aware fork.
    borderWidth: 2,
    borderColor: QUALITY_COLORS[0],
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
