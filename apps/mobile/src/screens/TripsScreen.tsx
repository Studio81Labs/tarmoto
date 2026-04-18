/**
 * TripsScreen — entry point for the Trips tab.
 *
 * Lists the rider's saved trips (via `api.listTrips`) with a primary CTA to
 * plan a new one. This is the landing surface for the US-7 auto-generated
 * multi-day route flow — the "Plan a trip" button kicks off the full
 * create → generate → detail flow.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import { useTripStore } from "@/stores";
import type { TripSummary } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import { formatStatus } from "./TripScreens.helpers";

type TripsNav = NativeStackNavigationProp<TripsStackParamList, "TripsList">;

type Phase = "loading" | "ready" | "error";

export default function TripsScreen() {
  const navigation = useNavigation<TripsNav>();
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);

  const [phase, setPhase] = useState<Phase>(
    trips.length > 0 ? "ready" : "loading",
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Read the latest cached count inside the callback rather than closing
  // over `trips.length`. Otherwise `load`'s identity flips as soon as the
  // first fetch lands, which would re-run `useFocusEffect` on the same
  // focus session and fire a spurious second request.
  const hasCachedTripsRef = useRef(trips.length > 0);
  useEffect(() => {
    hasCachedTripsRef.current = trips.length > 0;
  }, [trips.length]);

  const load = useCallback(
    async (isInitial: boolean) => {
      const hadCache = hasCachedTripsRef.current;
      if (isInitial && !hadCache) {
        setPhase("loading");
        setErrorMessage(null);
      } else {
        setIsRefreshing(true);
      }
      try {
        const next = await api.listTrips();
        setTrips(next);
        setPhase("ready");
      } catch (err) {
        // Refresh failures: keep showing cached trips. Initial failures
        // with no cache: surface a full error state so the user knows
        // something's off.
        if (isInitial && !hadCache) {
          setPhase("error");
          setErrorMessage(
            err instanceof Error ? err.message : "Unable to load trips",
          );
        }
      } finally {
        setIsRefreshing(false);
      }
    },
    [setTrips],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Refresh when the tab regains focus so a newly-created trip from the
  // Create screen appears at the top without a manual pull. `load` is
  // stable (doesn't close over render-local state) so this won't re-fire
  // spuriously while the screen stays focused.
  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  const openCreate = useCallback(
    () => navigation.navigate("TripCreate"),
    [navigation],
  );

  const openDetail = useCallback(
    (tripId: string) => navigation.navigate("TripDetail", { tripId }),
    [navigation],
  );

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
        <Text style={styles.emptyTitle}>Can't load trips</Text>
        <Text style={styles.emptyBody}>
          {errorMessage ?? "Check your connection and try again."}
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => void load(true)}
        >
          <Text style={styles.primaryBtnLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void load(false)}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={<EmptyState onCreate={openCreate} />}
        renderItem={({ item }) => (
          <TripCard trip={item} onPress={() => openDetail(item.id)} />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
      {trips.length > 0 ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={openCreate}
          accessibilityRole="button"
          accessibilityLabel="Plan a new trip"
        >
          <Icon name="plus" size={24} color={colors.textInverse} />
          <Text style={styles.fabLabel}>Plan a trip</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <View style={styles.emptyWrap}>
      <Icon name="calendar-blank-outline" size={48} color={colors.primary} />
      <Text style={styles.emptyTitle}>No trips yet</Text>
      <Text style={styles.emptyBody}>
        Tarmoto finds the best roads for a multi-day ride. Pick a few parameters
        and we'll auto-generate the route.
      </Text>
      <TouchableOpacity style={styles.primaryBtn} onPress={onCreate}>
        <Icon name="plus" size={18} color={colors.textInverse} />
        <Text style={styles.primaryBtnLabel}>Plan a trip</Text>
      </TouchableOpacity>
    </View>
  );
}

function TripCard({
  trip,
  onPress,
}: {
  trip: TripSummary;
  onPress: () => void;
}) {
  const statusColor = statusBadgeColor(trip.status);
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${trip.title}, ${trip.num_days} days, ${trip.status}`}
    >
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {trip.title}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {[
            trip.region,
            `${trip.num_days} day${trip.num_days === 1 ? "" : "s"}`,
            trip.member_count > 1 ? `${trip.member_count} riders` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <View style={[styles.statusPill, { borderColor: statusColor }]}>
        <Text style={[styles.statusLabel, { color: statusColor }]}>
          {formatStatus(trip.status)}
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

function statusBadgeColor(status: TripSummary["status"]): string {
  switch (status) {
    case "active":
      return colors.primary;
    case "completed":
      return colors.success;
    case "planned":
      return colors.info;
    default:
      return colors.textTertiary;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  listContent: {
    padding: spacing.xl,
    paddingBottom: spacing.section * 2,
    flexGrow: 1,
  },
  separator: {
    height: spacing.md,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyWrap: {
    flex: 1,
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
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  cardMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
  },
  statusLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  fab: {
    position: "absolute",
    bottom: spacing.xl,
    right: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  fabLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
