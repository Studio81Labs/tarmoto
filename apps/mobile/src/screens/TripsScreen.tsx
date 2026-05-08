/**
 * TripsScreen — entry point for the Trips tab.
 *
 * Lists the rider's saved trips (via `api.listTrips`) with a primary CTA to
 * plan a new one. This is the landing surface for the US-7 auto-generated
 * multi-day route flow — the "Plan a trip" button kicks off the full
 * create → generate → detail flow.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { TripFolder, TripSummary } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import { formatStatus } from "./TripScreens.helpers";
import { groupTripsByFolder, type TripsListRow } from "./TripsScreen.helpers";

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
  // US-37 — folders are read-only on mobile for v1. We tolerate a
  // failed folders fetch (e.g. older backend without the endpoint) by
  // keeping the list flat instead of blocking trip rendering on it.
  const [folders, setFolders] = useState<TripFolder[]>([]);

  // `load`'s two callers want different UX: the initial mount with no
  // cache shows the full-screen spinner, while a re-focus after we
  // already have trips should just flip the RefreshControl. Read cache
  // presence from a ref so the callback identity stays stable — if it
  // closed over `trips.length` directly, `load` would be recreated each
  // time the list landed, causing `useFocusEffect` to re-fire on the
  // same focus session.
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
        // Issue both fetches in parallel — the folders endpoint is the
        // smaller request; the trips fetch dominates wall-clock time so
        // serialising would just inflate latency on every reload. A
        // folders failure must NOT 4xx the trip list — fall back to the
        // flat list (existing behaviour) and surface the trips anyway.
        const [nextTrips, nextFolders] = await Promise.all([
          api.listTrips(),
          api.listTripFolders().catch(() => [] as TripFolder[]),
        ]);
        setTrips(nextTrips);
        setFolders(nextFolders);
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

  // One effect handles both the initial load and every re-focus: on the
  // first run we pass isInitial=true (so the empty state renders the
  // full-screen spinner, not a cached-data refresh indicator) and on
  // subsequent focuses we pass false. A separate `useEffect` + focus
  // effect would double-fire on mount.
  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const isInitial = !hasLoadedOnceRef.current;
      hasLoadedOnceRef.current = true;
      void load(isInitial);
    }, [load]),
  );

  const openCreate = useCallback(
    () => navigation.navigate("TripCreate"),
    [navigation],
  );

  const openJoin = useCallback(
    () => navigation.navigate("TripJoin"),
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

  const rows = useMemo(
    () => groupTripsByFolder(trips, folders),
    [trips, folders],
  );

  return (
    <View style={styles.container}>
      <FlatList<TripsListRow>
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void load(false)}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <EmptyState onCreate={openCreate} onJoin={openJoin} />
        }
        ListHeaderComponent={
          trips.length > 0 ? <ListHeader onJoin={openJoin} /> : null
        }
        renderItem={({ item }) =>
          item.kind === "folder-header" ? (
            <FolderHeader label={item.label} count={item.count} />
          ) : (
            <TripCard
              trip={item.trip}
              onPress={() => openDetail(item.trip.id)}
            />
          )
        }
        ItemSeparatorComponent={({ leadingItem, trailingItem }) => {
          // Skip the separator immediately above a folder header so
          // the header sits flush with the next group instead of
          // floating in space, and tighten the gap between header and
          // its first trip.
          const lead = leadingItem as TripsListRow | undefined;
          const trail = trailingItem as TripsListRow | undefined;
          if (
            lead?.kind === "folder-header" ||
            trail?.kind === "folder-header"
          ) {
            return <View style={styles.headerSeparator} />;
          }
          return <View style={styles.separator} />;
        }}
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

function FolderHeader({ label, count }: { label: string; count: number }) {
  return (
    <View
      style={styles.folderHeader}
      accessibilityRole="header"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "trip" : "trips"}`}
    >
      <Icon name="folder-outline" size={14} color={colors.textTertiary} />
      <Text style={styles.folderHeaderLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.folderHeaderCount}>{count}</Text>
    </View>
  );
}

function ListHeader({ onJoin }: { onJoin: () => void }) {
  return (
    <TouchableOpacity
      style={styles.joinRow}
      onPress={onJoin}
      accessibilityRole="button"
      accessibilityLabel="Join a trip with an invite code"
    >
      <View style={styles.joinIconWrap}>
        <Icon name="account-multiple-plus" size={20} color={colors.primary} />
      </View>
      <View style={styles.joinBody}>
        <Text style={styles.joinTitle}>Join a trip</Text>
        <Text style={styles.joinSubtitle}>
          Got an invite code? Ride along with the rest of the group.
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

function EmptyState({
  onCreate,
  onJoin,
}: {
  onCreate: () => void;
  onJoin: () => void;
}) {
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
      <TouchableOpacity style={styles.secondaryBtn} onPress={onJoin}>
        <Icon name="account-multiple-plus" size={18} color={colors.primary} />
        <Text style={styles.secondaryBtnLabel}>Join with invite code</Text>
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
  headerSeparator: {
    height: spacing.sm,
  },
  folderHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  folderHeaderLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  folderHeaderCount: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontVariant: ["tabular-nums"],
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
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  secondaryBtnLabel: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  joinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  joinIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  joinBody: {
    flex: 1,
    gap: 2,
  },
  joinTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  joinSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
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
