/**
 * WeatherAlertBanner — US-13 navigation overlay.
 *
 * Non-modal banner that sits above the maneuver card and surfaces the
 * most urgent active weather alert ahead of the rider. Tapping it opens
 * a full-list detail sheet so the rider can scan every alert without
 * leaving the navigation screen. Severity drives both the banner colour
 * and the icon, mirroring the conventions used by `OffRouteBanner`.
 */
import React, { type ComponentProps, useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  shadows,
  spacing,
} from "@/theme";
import type { WeatherAlert, WeatherAlertSeverity } from "@/types";

type IconName = ComponentProps<typeof Icon>["name"];

const KIND_ICON: Record<WeatherAlert["kind"], IconName> = {
  storm: "weather-lightning-rainy",
  ice: "snowflake",
  wet: "weather-rainy",
  wind: "weather-windy",
};

/**
 * Sort order for severities — `critical` always wins. Used to pick the
 * banner's primary alert and to order the detail sheet.
 */
const SEVERITY_RANK: Record<WeatherAlertSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

function severityColor(severity: WeatherAlertSeverity): string {
  if (severity === "critical") return colors.danger;
  if (severity === "warning") return colors.warning;
  return colors.info;
}

export interface WeatherAlertBannerProps {
  alerts: WeatherAlert[];
  /** Detail-sheet open state — owned by the parent so it can persist. */
  detailOpen: boolean;
  onOpenDetail: () => void;
  onCloseDetail: () => void;
}

export function WeatherAlertBanner({
  alerts,
  detailOpen,
  onOpenDetail,
  onCloseDetail,
}: WeatherAlertBannerProps): React.JSX.Element | null {
  const sortedAlerts = useMemo(
    () =>
      [...alerts].sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          a.distance_km_from_start - b.distance_km_from_start,
      ),
    [alerts],
  );

  if (sortedAlerts.length === 0) return null;
  const top = sortedAlerts[0];
  const additionalCount = sortedAlerts.length - 1;
  const bg = severityColor(top.severity);

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Weather alert: ${top.title}. Tap for details.`}
        accessibilityLiveRegion="polite"
        onPress={onOpenDetail}
        style={[styles.banner, { backgroundColor: bg }]}
      >
        <Icon
          name={KIND_ICON[top.kind] ?? "weather-cloudy-alert"}
          size={20}
          color={colors.textInverse}
        />
        <View style={styles.bannerBody}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {top.title}
          </Text>
          <Text style={styles.bannerMessage} numberOfLines={1}>
            {additionalCount > 0
              ? `${top.message} · +${additionalCount} more`
              : top.message}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={colors.textInverse} />
      </TouchableOpacity>

      <Modal
        visible={detailOpen}
        transparent
        animationType="fade"
        onRequestClose={onCloseDetail}
      >
        <Pressable style={styles.backdrop} onPress={onCloseDetail}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Weather alerts ahead</Text>
              <TouchableOpacity
                onPress={onCloseDetail}
                accessibilityRole="button"
                accessibilityLabel="Close weather alerts"
                style={styles.sheetClose}
              >
                <Icon name="close" size={20} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.sheetList}>
              {sortedAlerts.map((alert) => (
                <View
                  key={alert.id}
                  style={[
                    styles.sheetRow,
                    { borderLeftColor: severityColor(alert.severity) },
                  ]}
                >
                  <Icon
                    name={KIND_ICON[alert.kind] ?? "weather-cloudy-alert"}
                    size={22}
                    color={severityColor(alert.severity)}
                  />
                  <View style={styles.sheetRowBody}>
                    <Text style={styles.sheetRowTitle}>{alert.title}</Text>
                    <Text style={styles.sheetRowMessage}>{alert.message}</Text>
                    <Text style={styles.sheetRowDistance}>
                      {formatKm(alert.distance_km_from_start)} from start
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    ...shadows.card,
  },
  bannerBody: {
    flex: 1,
  },
  bannerTitle: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  bannerMessage: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    opacity: 0.9,
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    backgroundColor: colors.bgCard,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
    maxHeight: "75%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.md,
  },
  sheetTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  sheetClose: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetList: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.md,
    borderLeftWidth: 4,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bg,
  },
  sheetRowBody: {
    flex: 1,
    gap: 2,
  },
  sheetRowTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  sheetRowMessage: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  sheetRowDistance: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 4,
  },
});
