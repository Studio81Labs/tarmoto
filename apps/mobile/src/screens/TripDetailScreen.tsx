/**
 * TripDetailScreen — US-7 output view for an auto-generated multi-day route.
 *
 * Shows the trip summary (title, region, status, total km, avg quality)
 * and a day-by-day list where each card drills into TripDayScreen. This
 * is where riders land right after hitting "Generate" on TripCreate — the
 * screen's job is to answer "did I get a sensible trip?" at a glance.
 *
 * Also surfaces the US-11 closed-pass warning: every time the trip days
 * change, we flatten their geometry into one polyline and ask the
 * backend which mountain passes the route crosses. Any whose status is
 * `closed` are rendered in a danger-tinted card directly under the
 * header so the rider sees the problem before scrolling.
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
import type { MountainPass, Trip, TripDay } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  averageQuality,
  flattenTripRoute,
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
  const [closedPasses, setClosedPasses] = useState<MountainPass[]>([]);

  // Single source of truth for "fetch this trip and commit it to local +
  // store state". The mount effect, retry button, and pull-to-refresh all
  // go through this — future changes to response shape or error mapping
  // only need to land in one place.
  const fetchTrip = useCallback(
    async (opts: { signal?: { cancelled: boolean } } = {}) => {
      if (!tripId) {
        if (!opts.signal?.cancelled) setError("Missing trip id");
        return;
      }
      try {
        const next = await api.getTrip(tripId);
        if (opts.signal?.cancelled) return;
        setTrip(next);
        setActiveTrip(next);
        setError(null);
      } catch (e) {
        if (opts.signal?.cancelled) return;
        throw e instanceof Error ? e : new Error("Failed to load trip");
      }
    },
    [tripId, setActiveTrip],
  );

  useEffect(() => {
    // Guard against a stale response from an older tripId overwriting
    // the current screen's state if the route changes mid-flight.
    const signal = { cancelled: false };
    setLoading(true);
    (async () => {
      try {
        await fetchTrip({ signal });
      } catch (e) {
        if (!signal.cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load trip");
        }
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [fetchTrip]);

  // US-11: surface closed mountain passes that the planned route
  // crosses so the rider doesn't drive into a snowbank. We re-run the
  // check whenever the trip days change (route regeneration, edits, or
  // refresh-driven reload) — cheap because the pass dataset is tiny
  // and the check is one PostGIS query. Soft-fails to "no warning" so
  // the screen still renders if `/passes/check-route` is unavailable.
  useEffect(() => {
    if (!trip) {
      setClosedPasses([]);
      return;
    }
    const route = flattenTripRoute(trip.days);
    if (route.length < 2) {
      setClosedPasses([]);
      return;
    }
    let cancelled = false;
    void api
      .checkRouteForPasses(route)
      .then((res) => {
        if (cancelled) return;
        setClosedPasses(res.passes.filter((p) => p.status === "closed"));
      })
      .catch(() => {
        if (!cancelled) setClosedPasses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trip]);

  const retry = useCallback(async () => {
    setLoading(true);
    try {
      await fetchTrip();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trip");
    } finally {
      setLoading(false);
    }
  }, [fetchTrip]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchTrip();
    } catch {
      // Silent on refresh — keep showing last good data.
    } finally {
      setRefreshing(false);
    }
  }, [fetchTrip]);

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
          onPress={() => void retry()}
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

      {closedPasses.length > 0 ? (
        <ClosedPassesWarning passes={closedPasses} />
      ) : null}

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

function ClosedPassesWarning({ passes }: { passes: MountainPass[] }) {
  // Sort by elevation descending so the most consequential closure
  // (typically also the one most likely to be still snowed-in) leads.
  const sorted = [...passes].sort((a, b) => b.elevation_m - a.elevation_m);
  const headline =
    sorted.length === 1
      ? "1 closed pass on this route"
      : `${sorted.length} closed passes on this route`;
  return (
    <View
      style={styles.warningCard}
      accessibilityRole="alert"
      accessibilityLabel={headline}
    >
      <View style={styles.warningHeaderRow}>
        <Icon name="alert-octagon" size={22} color={colors.danger} />
        <Text style={styles.warningTitle}>{headline}</Text>
      </View>
      <Text style={styles.warningBody}>
        These passes are likely closed when you ride. Plan a detour or check
        local conditions before departing.
      </Text>
      {sorted.map((p) => (
        <View key={p.id} style={styles.warningPassRow}>
          <Text style={styles.warningPassName} numberOfLines={1}>
            {p.name}
          </Text>
          <Text style={styles.warningPassMeta}>
            {p.elevation_m} m · {p.country_code}
          </Text>
        </View>
      ))}
    </View>
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
  warningCard: {
    backgroundColor: colors.qualityAlpha.veryPoor,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  warningHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  warningTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  warningBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  warningPassRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: spacing.xs,
  },
  warningPassName: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    flex: 1,
    paddingRight: spacing.sm,
  },
  warningPassMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
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
