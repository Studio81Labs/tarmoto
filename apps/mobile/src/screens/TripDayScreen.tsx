/**
 * TripDayScreen — US-7 single-day breakdown.
 *
 * Renders distance / time / elevation / quality for a single day plus a
 * waypoint timeline with fuel and overnight stops called out — those are
 * the two waypoint classes riders reason about while deciding whether to
 * follow the generator's proposal as-is.
 */

import React, { ComponentProps, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useRoute } from "@react-navigation/native";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityColor,
  qualityLabel,
  spacing,
} from "@/theme";
import { api } from "@/services/api";
import { useTripStore } from "@/stores";
import type { Trip, TripDay, Waypoint } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  WAYPOINT_ICONS,
  formatDurationMin,
  formatKm,
  formatWaypointType,
  summarizeWaypoints,
} from "./TripScreens.helpers";

type DayRoute = RouteProp<TripsStackParamList, "TripDay">;
type IconName = ComponentProps<typeof Icon>["name"];

export default function TripDayScreen() {
  const { params } = useRoute<DayRoute>();
  const { tripId, dayNumber } = params;

  const cachedTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);

  // Warm-cache: if the user came from TripDetail we already have the
  // trip and don't need to block on a fetch. If they deep-linked (e.g.
  // from a push), we fall back to fetching.
  const [trip, setTrip] = useState<Trip | null>(
    cachedTrip?.id === tripId ? cachedTrip : null,
  );
  const [loading, setLoading] = useState(trip === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trip) return;
    let ignore = false;
    (async () => {
      try {
        const next = await api.getTrip(tripId);
        if (ignore) return;
        setTrip(next);
        setActiveTrip(next);
      } catch (e) {
        if (ignore) return;
        setError(e instanceof Error ? e.message : "Failed to load day");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [tripId, trip, setActiveTrip]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !trip) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={colors.danger} />
        <Text style={styles.errorTitle}>Unable to load day</Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
      </View>
    );
  }

  const day = trip.days.find((d) => d.day_number === dayNumber);
  if (!day) {
    return (
      <View style={styles.centered}>
        <Icon
          name="calendar-remove-outline"
          size={48}
          color={colors.textTertiary}
        />
        <Text style={styles.errorTitle}>Day {dayNumber} not found</Text>
        <Text style={styles.errorBody}>
          The trip doesn't include this day. It may have been regenerated with a
          different number of days.
        </Text>
      </View>
    );
  }

  const qColor =
    day.avg_quality > 0 ? qualityColor(day.avg_quality) : colors.textTertiary;
  const summary = summarizeWaypoints(day.waypoints);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.subLabel}>Day {day.day_number}</Text>
        <Text style={styles.title}>{day.title ?? `Day ${day.day_number}`}</Text>
        <View style={styles.metricsRow}>
          <Metric label="Distance" value={formatKm(day.distance_km)} />
          <Metric
            label="Time"
            value={formatDurationMin(day.estimated_time_min)}
          />
          <Metric
            label="Elevation"
            value={`+${Math.round(day.elevation_gain)} m`}
          />
          <Metric
            label="Quality"
            value={day.avg_quality > 0 ? qualityLabel(day.avg_quality) : "—"}
            valueColor={qColor}
          />
        </View>
      </View>

      <HighlightsCard
        fuelStops={summary.fuelStops}
        overnightStops={summary.overnightStops}
      />

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Route</Text>
        {day.waypoints.length === 0 ? (
          <Text style={styles.emptyBody}>
            No waypoints for this day yet. Try regenerating the trip.
          </Text>
        ) : (
          [...day.waypoints]
            .sort((a, b) => a.sequence - b.sequence)
            .map((wp, idx, arr) => (
              <WaypointRow
                key={wp.id}
                waypoint={wp}
                isLast={idx === arr.length - 1}
              />
            ))
        )}
      </View>
    </ScrollView>
  );
}

function HighlightsCard({
  fuelStops,
  overnightStops,
}: {
  fuelStops: Waypoint[];
  overnightStops: Waypoint[];
}) {
  if (fuelStops.length === 0 && overnightStops.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Highlights</Text>
      {fuelStops.length > 0 ? (
        <HighlightRow
          icon="gas-station"
          label="Fuel"
          value={`${fuelStops.length} stop${fuelStops.length === 1 ? "" : "s"}`}
          detail={fuelStops
            .map((f) => f.name)
            .filter((n): n is string => !!n)
            .join(" · ")}
        />
      ) : null}
      {overnightStops.length > 0 ? (
        <HighlightRow
          icon="bed"
          label="Overnight"
          value={`${overnightStops.length} stop${overnightStops.length === 1 ? "" : "s"}`}
          detail={overnightStops
            .map((h) => h.name)
            .filter((n): n is string => !!n)
            .join(" · ")}
        />
      ) : null}
    </View>
  );
}

function HighlightRow({
  icon,
  label,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <View style={styles.highlightRow}>
      <View style={styles.highlightIconWrap}>
        <Icon name={icon} size={20} color={colors.primary} />
      </View>
      <View style={styles.highlightBody}>
        <Text style={styles.highlightLabel}>{label}</Text>
        <Text style={styles.highlightValue}>{value}</Text>
        {detail ? (
          <Text style={styles.highlightDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function WaypointRow({
  waypoint,
  isLast,
}: {
  waypoint: Waypoint;
  isLast: boolean;
}) {
  const isFuel = waypoint.waypoint_type === "fuel";
  const iconName = (WAYPOINT_ICONS[waypoint.waypoint_type] ??
    "map-marker") as IconName;
  const iconColor = isFuel ? colors.warning : colors.primary;

  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineGutter}>
        <View
          style={[styles.timelineBubble, isFuel && styles.timelineBubbleFuel]}
        >
          <Icon name={iconName} size={16} color={iconColor} />
        </View>
        {!isLast ? <View style={styles.timelineLine} /> : null}
      </View>
      <View style={styles.timelineBody}>
        <View style={styles.timelineHeader}>
          <Text style={styles.timelineTitle}>
            {waypoint.name ?? formatWaypointType(waypoint.waypoint_type)}
          </Text>
          {isFuel ? (
            <View style={styles.fuelBadge}>
              <Text style={styles.fuelBadgeText}>FUEL</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.timelineMeta}>
          {formatWaypointType(waypoint.waypoint_type)}
          {waypoint.duration_min
            ? ` · ${formatDurationMin(waypoint.duration_min)} stop`
            : ""}
        </Text>
        {waypoint.notes ? (
          <Text style={styles.timelineNotes}>{waypoint.notes}</Text>
        ) : null}
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
  errorTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
    textAlign: "center",
  },
  errorBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
    lineHeight: 22,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  subLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  metricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: spacing.md,
    rowGap: spacing.sm,
  },
  metric: {
    flex: 1,
    minWidth: 80,
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
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  highlightRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
  },
  highlightIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  highlightBody: {
    flex: 1,
    gap: 2,
  },
  highlightLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  highlightValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  highlightDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  timelineRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  timelineGutter: {
    width: 32,
    alignItems: "center",
  },
  timelineBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timelineBubbleFuel: {
    borderColor: colors.warning,
    backgroundColor: "rgba(234, 179, 8, 0.1)",
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: colors.border,
    marginTop: 4,
  },
  timelineBody: {
    flex: 1,
    paddingBottom: spacing.md,
    gap: 2,
  },
  timelineHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  timelineTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  timelineMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  timelineNotes: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 4,
    lineHeight: 20,
  },
  fuelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.warning,
  },
  fuelBadgeText: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
});
