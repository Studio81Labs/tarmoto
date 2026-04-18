/**
 * TripDetailScreen — US-7 output view for an auto-generated multi-day route.
 *
 * Shows the trip summary (title, region, status, total km, avg quality)
 * and a day-by-day list where each card drills into TripDayScreen. This
 * is where riders land right after hitting "Generate" on TripCreate — the
 * screen's job is to answer "did I get a sensible trip?" at a glance.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
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
import type { Trip, TripDay } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  averageQuality,
  formatDurationMin,
  formatKm,
  formatStatus,
  sumDistance,
} from "./TripScreens.helpers";

type DetailRoute = RouteProp<TripsStackParamList, "TripDetail">;
type DetailNav = NativeStackNavigationProp<TripsStackParamList, "TripDetail">;

export default function TripDetailScreen() {
  const { params } = useRoute<DetailRoute>();
  const navigation = useNavigation<DetailNav>();
  const tripId = params?.tripId;

  const setActiveTrip = useTripStore((s) => s.setActiveTrip);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOnce = useCallback(async () => {
    if (!tripId) {
      setError("Missing trip id");
      setLoading(false);
      return;
    }
    try {
      const next = await api.getTrip(tripId);
      setTrip(next);
      setActiveTrip(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trip");
    } finally {
      setLoading(false);
    }
  }, [tripId, setActiveTrip]);

  useEffect(() => {
    // Guard against a stale response from an older tripId overwriting
    // the current screen's state if the route changes mid-flight.
    let ignore = false;
    setLoading(true);
    (async () => {
      if (!tripId) {
        if (!ignore) {
          setError("Missing trip id");
          setLoading(false);
        }
        return;
      }
      try {
        const next = await api.getTrip(tripId);
        if (ignore) return;
        setTrip(next);
        setActiveTrip(next);
        setError(null);
      } catch (e) {
        if (ignore) return;
        setError(e instanceof Error ? e.message : "Failed to load trip");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [tripId, setActiveTrip]);

  const refresh = useCallback(async () => {
    if (!tripId) return;
    setRefreshing(true);
    try {
      const next = await api.getTrip(tripId);
      setTrip(next);
      setActiveTrip(next);
    } catch {
      // Silent on refresh — keep showing last good data.
    } finally {
      setRefreshing(false);
    }
  }, [tripId, setActiveTrip]);

  const openDay = useCallback(
    (dayNumber: number) => {
      if (!tripId) return;
      navigation.navigate("TripDay", { tripId, dayNumber });
    },
    [navigation, tripId],
  );

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
        <Text style={styles.errorTitle}>Unable to load trip</Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => {
            setLoading(true);
            void loadOnce();
          }}
        >
          <Text style={styles.primaryBtnLabel}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const totalKm = sumDistance(trip.days);
  const avgQ = averageQuality(trip.days);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.primary}
        />
      }
    >
      <HeaderCard trip={trip} totalKm={totalKm} avgQ={avgQ} />

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Days</Text>
        <Text style={styles.sectionHeaderMeta}>
          {trip.days.length} day{trip.days.length === 1 ? "" : "s"}
        </Text>
      </View>

      {trip.days.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyDaysTitle}>No days generated yet</Text>
          <Text style={styles.emptyDaysBody}>
            The route generator hasn't produced any days for this trip. Pull to
            refresh, or go back and try different parameters.
          </Text>
        </View>
      ) : (
        trip.days.map((day) => (
          <DayCard
            key={day.id}
            day={day}
            onPress={() => openDay(day.day_number)}
          />
        ))
      )}
    </ScrollView>
  );
}

function HeaderCard({
  trip,
  totalKm,
  avgQ,
}: {
  trip: Trip;
  totalKm: number;
  avgQ: number;
}) {
  const qColor = avgQ > 0 ? qualityColor(avgQ) : colors.textTertiary;
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={2}>
          {trip.title}
        </Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusLabel}>{formatStatus(trip.status)}</Text>
        </View>
      </View>
      {trip.region ? <Text style={styles.region}>{trip.region}</Text> : null}
      <View style={styles.metricsRow}>
        <Metric label="Total" value={formatKm(totalKm)} />
        <Metric
          label="Days"
          value={`${trip.num_days}`}
          sub={`${trip.daily_km_min}–${trip.daily_km_max} km/day`}
        />
        <Metric
          label="Quality"
          value={avgQ > 0 ? qualityLabel(avgQ) : "—"}
          valueColor={qColor}
        />
      </View>
    </View>
  );
}

function DayCard({ day, onPress }: { day: TripDay; onPress: () => void }) {
  const qColor =
    day.avg_quality > 0 ? qualityColor(day.avg_quality) : colors.textTertiary;
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Day ${day.day_number}${day.title ? `, ${day.title}` : ""}`}
    >
      <View style={styles.dayHeaderRow}>
        <View style={styles.dayNumberBubble}>
          <Text style={styles.dayNumber}>{day.day_number}</Text>
        </View>
        <View style={styles.dayHeaderText}>
          <Text style={styles.dayTitle}>
            {day.title ?? `Day ${day.day_number}`}
          </Text>
          <Text style={styles.dayMeta}>
            {formatKm(day.distance_km)} ·{" "}
            {formatDurationMin(day.estimated_time_min)} · +
            {Math.round(day.elevation_gain)} m
          </Text>
        </View>
        <Icon name="chevron-right" size={22} color={colors.textTertiary} />
      </View>
      <View style={styles.qualityRow}>
        <Icon name="road-variant" size={16} color={qColor} />
        <Text style={[styles.qualityText, { color: qColor }]}>
          {day.avg_quality > 0 ? qualityLabel(day.avg_quality) : "No data yet"}
        </Text>
        <Text style={styles.waypointCount}>
          {day.waypoints.length} waypoint
          {day.waypoints.length === 1 ? "" : "s"}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function Metric({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
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
      {sub ? <Text style={styles.metricSub}>{sub}</Text> : null}
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
  },
  errorBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
  },
  primaryBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  primaryBtnLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  statusLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  region: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
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
  metricSub: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  sectionHeader: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
  },
  sectionHeaderMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
  },
  dayHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  dayNumberBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  dayNumber: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  dayHeaderText: {
    flex: 1,
    gap: 2,
  },
  dayTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  dayMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  qualityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  qualityText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  waypointCount: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginLeft: "auto",
  },
  emptyDaysTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  emptyDaysBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
});
