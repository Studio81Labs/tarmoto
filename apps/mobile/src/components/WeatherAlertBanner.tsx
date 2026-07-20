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
import { Icon } from "@/components/Icon";
import {
  brandColorsDark,
  brandFonts,
  brandRadii,
  brandSpacing,
  QUALITY_COLORS,
} from "@/theme/brand";
import type { WeatherAlert, WeatherAlertSeverity } from "@/types";
import { t as translate } from "@/i18n";

type IconName = ComponentProps<typeof Icon>["name"];

// Rendered over the night-palette NavigationScreen → dark surface tokens.
const t = brandColorsDark;

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

// Severity accent for the leading icon + left border on the dark banner /
// sheet rows. Each clears 3:1 on the dark surface: the Q1 ramp red and Q2
// amber escalate critical/warning, and `info` reads as a neutral cream.
function severityColor(severity: WeatherAlertSeverity): string {
  if (severity === "critical") return QUALITY_COLORS[0];
  if (severity === "warning") return QUALITY_COLORS[1];
  return t.fg;
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

  const top = sortedAlerts[0];
  if (!top) return null;
  const additionalCount = sortedAlerts.length - 1;
  const accent = severityColor(top.severity);

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={translate(
          "Weather alert: {value0}. Tap for details.",
          { value0: top.title },
        )}
        accessibilityLiveRegion="polite"
        onPress={onOpenDetail}
        style={[styles.banner, { borderLeftColor: accent }]}
      >
        <Icon
          name={KIND_ICON[top.kind] ?? "weather-cloudy-alert"}
          size={20}
          color={accent}
        />
        <View style={styles.bannerBody}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {top.title}
          </Text>
          <Text style={styles.bannerMessage} numberOfLines={1}>
            {additionalCount > 0
              ? translate("{value0} · +{value1} more", {
                  value0: top.message,
                  value1: additionalCount,
                })
              : top.message}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={t.dim} />
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
              <Text style={styles.sheetTitle}>
                {translate("Weather alerts ahead")}
              </Text>
              <TouchableOpacity
                onPress={onCloseDetail}
                accessibilityRole="button"
                accessibilityLabel={translate("Close weather alerts")}
                style={styles.sheetClose}
              >
                <Icon name="close" size={20} color={t.fg} />
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
                      {translate("{distance} from start", {
                        distance: formatKm(alert.distance_km_from_start),
                      })}
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
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    borderLeftWidth: 4,
  },
  bannerBody: {
    flex: 1,
  },
  bannerTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  bannerMessage: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    backgroundColor: t.raised,
    borderTopLeftRadius: brandRadii.lg,
    borderTopRightRadius: brandRadii.lg,
    borderWidth: 1,
    borderColor: t.line,
    paddingHorizontal: brandSpacing.s4,
    paddingTop: brandSpacing.s3,
    paddingBottom: brandSpacing.s8,
    maxHeight: "75%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: brandSpacing.s3,
  },
  sheetTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
  },
  sheetClose: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetList: {
    gap: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: brandSpacing.s3,
    padding: brandSpacing.s3,
    borderLeftWidth: 4,
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
  },
  sheetRowBody: {
    flex: 1,
    gap: 2,
  },
  sheetRowTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  sheetRowMessage: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  sheetRowDistance: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    marginTop: 4,
  },
});
