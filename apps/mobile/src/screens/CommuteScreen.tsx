/**
 * CommuteScreen — US-15 proactive commute hazard warnings.
 *
 * Three visual states:
 *   - `loading` while the first fetch is in flight
 *   - `learning` when no primary commute has been detected yet (the
 *     backend needs at least 3 rides per the user story)
 *   - `ready` with the commute summary, weather line, and a hazard list
 *     where hazards new since the rider's last visit are flagged NEW.
 *
 * Push notifications for new hazards are a separate workstream (see
 * Issue #17 acceptance criteria). This screen delivers the in-app half
 * of that feature — the diff itself — which the future notification
 * layer can reuse via the same `useCommute()` hook.
 */

import React, { ComponentProps } from "react";
import {
  ActivityIndicator,
  RefreshControl,
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
  hazardIcons,
  qualityColor,
  qualityLabel,
  spacing,
} from "@/theme";
import { useCommute, type CommuteHazardView } from "@/hooks/useCommute";
import type { CommuteStatus, Weather } from "@/types";
import {
  formatHazardType,
  formatRelativeTime,
} from "./RoadPreviewScreen.helpers";
import { capitalize } from "./TripScreens.helpers";

type IconName = ComponentProps<typeof Icon>["name"];

export default function CommuteScreen() {
  const {
    phase,
    route,
    status,
    hazards,
    newHazardCount,
    errorMessage,
    refresh,
    retry,
    acknowledge,
    isRefreshing,
  } = useCommute();

  // NEW hazard markers stay sticky until the rider explicitly taps
  // "Mark all seen" below. Avoid auto-acknowledging on unmount: the
  // `acknowledge` callback's identity changes on every refresh, which
  // would cause the cleanup to silently clear the pre-refresh diff.

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyTitle}>Can't load commute</Text>
        <Text style={styles.emptyBody}>
          {errorMessage ?? "Check your connection and try again."}
        </Text>
        <TouchableOpacity style={styles.retryBtn} onPress={retry}>
          <Text style={styles.retryLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === "learning" || !route || !status) {
    return <LearningState onRefresh={refresh} refreshing={isRefreshing} />;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={refresh}
          tintColor={colors.primary}
        />
      }
    >
      <CommuteHeader status={status} newHazardCount={newHazardCount} />

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{route.name}</Text>
        <View style={styles.metricsRow}>
          <Metric
            label="Distance"
            value={`${route.distance_km.toFixed(1)} km`}
          />
          <Metric label="Avg time" value={`${route.avg_duration_min} min`} />
          <Metric
            label="Quality"
            value={qualityLabel(status.route_quality)}
            valueColor={qualityColor(status.route_quality)}
          />
        </View>
      </View>

      <WeatherCard weather={status.weather} />

      <HazardsCard
        hazards={hazards}
        newHazardCount={newHazardCount}
        onDismissNewBadges={acknowledge}
      />
    </ScrollView>
  );
}

// ── Sub-components ──

function LearningState({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.centeredContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      <Icon name="map-marker-path" size={48} color={colors.primary} />
      <Text style={styles.emptyTitle}>Learning your commute</Text>
      <Text style={styles.emptyBody}>
        Take a few rides to the same destination and we'll start tracking road
        conditions and hazards for that route.
      </Text>
    </ScrollView>
  );
}

function CommuteHeader({
  status,
  newHazardCount,
}: {
  status: CommuteStatus;
  newHazardCount: number;
}) {
  const { icon, color, message } = describeStatus(status, newHazardCount);
  return (
    <View style={[styles.statusBanner, { borderColor: color }]}>
      <View style={[styles.statusIconWrap, { backgroundColor: color + "22" }]}>
        <Icon name={icon} size={22} color={color} />
      </View>
      <View style={styles.statusTextWrap}>
        <Text style={[styles.statusTitle, { color }]}>{message.title}</Text>
        <Text style={styles.statusBody}>{message.body}</Text>
      </View>
    </View>
  );
}

function Metric({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[styles.metricValue, valueColor ? { color: valueColor } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

function WeatherCard({ weather }: { weather: Weather }) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Weather</Text>
      <View style={styles.weatherRow}>
        <Icon
          name={weatherIcon(weather.condition)}
          size={32}
          color={colors.primary}
        />
        <View style={styles.weatherText}>
          <Text style={styles.weatherTemp}>
            {Math.round(weather.temperature_c)}°C ·{" "}
            {capitalize(weather.condition)}
          </Text>
          <Text style={styles.weatherDetail}>{weather.description}</Text>
          <Text style={styles.weatherDetail}>
            Road: {capitalize(weather.road_condition)} · Wind{" "}
            {Math.round(weather.wind_kmh)} km/h
          </Text>
        </View>
      </View>
    </View>
  );
}

function HazardsCard({
  hazards,
  newHazardCount,
  onDismissNewBadges,
}: {
  hazards: CommuteHazardView[];
  newHazardCount: number;
  onDismissNewBadges: () => void;
}) {
  if (hazards.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Hazards</Text>
        <View style={styles.clearRow}>
          <Icon name="check-circle" size={20} color={colors.success} />
          <Text style={styles.clearText}>
            No active hazards on your commute.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.hazardsHeader}>
        <Text style={styles.sectionTitle}>Hazards ({hazards.length})</Text>
        {newHazardCount > 0 ? (
          <TouchableOpacity
            onPress={onDismissNewBadges}
            accessibilityLabel="Dismiss new hazard badges"
          >
            <Text style={styles.dismissLabel}>Mark all seen</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {hazards.map((h) => (
        <HazardRow key={h.id} hazard={h} />
      ))}
    </View>
  );
}

function HazardRow({ hazard }: { hazard: CommuteHazardView }) {
  return (
    <View style={styles.hazardRow}>
      <View
        style={[
          styles.hazardIconWrap,
          { backgroundColor: severityAlpha(hazard.severity) },
        ]}
      >
        <Icon
          name={(hazardIcons[hazard.hazard_type] as IconName) ?? "alert-circle"}
          size={22}
          color={severityColor(hazard.severity)}
        />
      </View>
      <View style={styles.hazardBody}>
        <View style={styles.hazardTitleRow}>
          <Text style={styles.hazardTitle}>
            {formatHazardType(hazard.hazard_type)}
          </Text>
          {hazard.isNew ? (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>NEW</Text>
            </View>
          ) : null}
        </View>
        {hazard.road_name ? (
          <Text style={styles.hazardMeta}>{hazard.road_name}</Text>
        ) : null}
        <Text style={styles.hazardMeta}>
          {capitalize(hazard.severity)} ·{" "}
          {formatRelativeTime(hazard.created_at)}
          {hazard.confirmations > 0
            ? ` · ${hazard.confirmations} confirmed`
            : ""}
        </Text>
        {hazard.note ? (
          <Text style={styles.hazardNote}>{hazard.note}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Pure helpers (kept inline; small + screen-specific) ──

function describeStatus(
  status: CommuteStatus,
  newHazardCount: number,
): { icon: IconName; color: string; message: { title: string; body: string } } {
  if (newHazardCount > 0) {
    const plural = newHazardCount === 1 ? "hazard" : "hazards";
    return {
      icon: "alert",
      color: colors.danger,
      message: {
        title: `${newHazardCount} new ${plural}`,
        body: "Check the list before you head out.",
      },
    };
  }
  switch (status.status) {
    case "clear":
      return {
        icon: "check-circle",
        color: colors.success,
        message: {
          title: "Route is clear",
          body: "No new hazards since you last checked.",
        },
      };
    case "hazards":
      return {
        icon: "alert-circle",
        color: colors.warning,
        message: {
          title: "Active hazards",
          body: "Known hazards on your route — none new.",
        },
      };
    case "weather_warning":
      return {
        icon: "weather-cloudy-alert",
        color: colors.warning,
        message: {
          title: "Weather warning",
          body: "Ride conditions may be tough.",
        },
      };
    case "delays":
      return {
        icon: "clock-alert",
        color: colors.warning,
        message: {
          title: "Delays expected",
          body: "Give yourself extra time.",
        },
      };
  }
}

function weatherIcon(condition: Weather["condition"]): IconName {
  switch (condition) {
    case "clear":
      return "weather-sunny";
    case "cloudy":
      return "weather-cloudy";
    case "rain":
      return "weather-rainy";
    case "storm":
      return "weather-lightning-rainy";
    case "snow":
      return "weather-snowy";
    case "fog":
      return "weather-fog";
    case "ice":
      return "snowflake-alert";
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
      return colors.danger;
    case "medium":
      return colors.warning;
    default:
      return colors.info;
  }
}

function severityAlpha(severity: string): string {
  switch (severity) {
    case "high":
      return "rgba(239, 68, 68, 0.15)";
    case "medium":
      return "rgba(234, 179, 8, 0.15)";
    default:
      return "rgba(59, 130, 246, 0.15)";
  }
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  centeredContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
    lineHeight: 22,
  },
  retryBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  retryLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    backgroundColor: colors.bgCard,
  },
  statusIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  statusTextWrap: {
    flex: 1,
  },
  statusTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  statusBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  metricValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: 4,
  },
  weatherRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  weatherText: {
    flex: 1,
    gap: 2,
  },
  weatherTemp: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  weatherDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  hazardsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dismissLabel: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  clearRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  clearText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  hazardRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  hazardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  hazardBody: {
    flex: 1,
    gap: 2,
  },
  hazardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  hazardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  hazardMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  hazardNote: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 20,
  },
  newBadge: {
    backgroundColor: colors.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  newBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
});
