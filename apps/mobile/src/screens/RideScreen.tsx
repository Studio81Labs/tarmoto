/**
 * RideScreen — US-19 ride-history list and start-a-ride entry point.
 *
 * Lists the rider's past rides paginated from `GET /rides`, with a
 * primary CTA to start a new free ride. Tapping a row drills into
 * RideDetailScreen for the full map + stats. Pull-to-refresh re-fetches
 * the first page.
 *
 * The list is the rider's home for "what have I ridden lately?", so
 * the first row is a status banner: when there's no active ride we show
 * the Start CTA; when one is in progress we show a glance card that
 * jumps back into the live HUD without losing context. The history
 * itself is just rides — the active ride is a separate state surface.
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
import { qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";
import { api } from "@/services/api";
import { useRideStore } from "@/stores";
import type { RideSummary } from "@/types";
import type { RideStackParamList } from "@/navigation/RootNavigator";
import RideMetric from "@/components/RideMetric";
import {
  formatDistanceKm,
  formatDurationMinutes,
  formatRideDate,
} from "./RideScreens.helpers";

type RideNav = NativeStackNavigationProp<RideStackParamList, "RideStart">;

type Phase = "loading" | "ready" | "error";

const PAGE_SIZE = 20;

const t = brandColorsLight;

export default function RideScreen() {
  const navigation = useNavigation<RideNav>();
  const recentRides = useRideStore((s) => s.recentRides);
  const setRecentRides = useRideStore((s) => s.setRecentRides);
  const isRiding = useRideStore((s) => s.isRiding);
  const activeRideType = useRideStore((s) => s.rideType);

  const [phase, setPhase] = useState<Phase>(
    recentRides.length > 0 ? "ready" : "loading",
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Same pattern as TripsScreen: the focus-effect callback identity must
  // stay stable, so cache presence is read from a ref rather than
  // closing over `recentRides.length` directly.
  const hasCachedRef = useRef(recentRides.length > 0);
  useEffect(() => {
    hasCachedRef.current = recentRides.length > 0;
  }, [recentRides.length]);

  // Generation counter bumped on every full-list fetch (initial load,
  // pull-to-refresh) so an in-flight `loadNextPage` can detect that
  // its closure-captured page-1 has been replaced by a refresh and
  // discard the late-arriving page-2 instead of clobbering the
  // refreshed list with stale rides.
  const fetchEpochRef = useRef(0);

  const loadFirstPage = useCallback(
    async (isInitial: boolean) => {
      const hadCache = hasCachedRef.current;
      if (isInitial && !hadCache) {
        setPhase("loading");
        setErrorMessage(null);
      } else {
        setIsRefreshing(true);
      }
      const epoch = ++fetchEpochRef.current;
      try {
        const next = await api.listRides(PAGE_SIZE, 0);
        if (epoch !== fetchEpochRef.current) {
          // A newer first-page fetch superseded us before we returned.
          // Drop the result so it can't overwrite the live list.
          return;
        }
        setRecentRides(next.rides);
        setTotal(next.total);
        setPhase("ready");
      } catch (err) {
        if (epoch !== fetchEpochRef.current) return;
        if (isInitial && !hadCache) {
          setPhase("error");
          setErrorMessage(
            err instanceof Error ? err.message : "Unable to load rides",
          );
        }
      } finally {
        if (epoch === fetchEpochRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    [setRecentRides],
  );

  const hasLoadedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const isInitial = !hasLoadedOnceRef.current;
      hasLoadedOnceRef.current = true;
      void loadFirstPage(isInitial);
    }, [loadFirstPage]),
  );

  const loadNextPage = useCallback(async () => {
    if (isLoadingMore) return;
    if (recentRides.length >= total) return;
    setIsLoadingMore(true);
    // Snapshot the epoch at start so we can tell whether a refresh
    // ran while page-2 was in flight. Refresh bumps `fetchEpochRef`,
    // so a non-match below means the closure's page-1 is stale and
    // appending to it would clobber the freshly-refreshed list.
    const startEpoch = fetchEpochRef.current;
    try {
      const next = await api.listRides(PAGE_SIZE, recentRides.length);
      if (startEpoch !== fetchEpochRef.current) {
        // A refresh resolved while we were paginating — its page-1 is
        // already canonical. Drop our stale page-2; the rider can
        // scroll again to fetch fresh next-page data.
        return;
      }
      // De-dupe on id in case a fresh ride landed between pages.
      const seen = new Set(recentRides.map((r) => r.id));
      const merged = [
        ...recentRides,
        ...next.rides.filter((r) => !seen.has(r.id)),
      ];
      setRecentRides(merged);
      setTotal(next.total);
    } catch {
      // Pagination failures stay silent — the rider can pull-to-refresh
      // or scroll again. Surfacing a banner mid-list would be jarring.
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, recentRides, total, setRecentRides]);

  const startFreeRide = useCallback(() => {
    navigation.navigate("RideActive", { rideType: "free" });
  }, [navigation]);

  const resumeRide = useCallback(() => {
    navigation.navigate("RideActive", { rideType: activeRideType });
  }, [navigation, activeRideType]);

  const openDetail = useCallback(
    (rideId: string) => {
      navigation.navigate("RideDetail", { rideId });
    },
    [navigation],
  );

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.errorContainer}>
        {/*
          Keep the resume card visible even when the history fetch
          failed: the rider may already be in a live ride (offline
          first-load is the typical case) and a list-fetch error
          must not lock them out of the active HUD. The card is
          rendered above the error panel so it's the first thing
          they see.
        */}
        {isRiding ? (
          <View style={styles.errorTopCard}>
            <ListHeader
              isRiding={isRiding}
              onStart={startFreeRide}
              onResume={resumeRide}
            />
          </View>
        ) : null}
        <View style={styles.centeredFlex}>
          <Icon name="wifi-off" size={40} color={t.dim} />
          <Text style={styles.emptyTitle}>Can't load rides</Text>
          <Text style={styles.emptyBody}>
            {errorMessage ?? "Check your connection and try again."}
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => void loadFirstPage(true)}
          >
            <Text style={styles.primaryBtnLabel}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={recentRides}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void loadFirstPage(false)}
            tintColor={t.fg}
          />
        }
        ListHeaderComponent={
          // Suppress the start-card header when there's no history and
          // the rider isn't already in a ride — the EmptyState below
          // already provides a Start CTA, and stacking two near-
          // identical primary actions reads as a UI bug. The resume
          // card (rendered by `ListHeader` when isRiding) is unique
          // and stays in all cases.
          isRiding || recentRides.length > 0 ? (
            <ListHeader
              isRiding={isRiding}
              onStart={startFreeRide}
              onResume={resumeRide}
            />
          ) : null
        }
        ListEmptyComponent={
          // Hide the "No rides yet" panel mid-ride: the rider is
          // literally in their first ride right now, so a "no rides"
          // message is misleading. The resume card from the header
          // is the only thing they need to see.
          isRiding ? null : <EmptyState onStart={startFreeRide} />
        }
        renderItem={({ item }) => (
          <RideCard ride={item} onPress={() => openDetail(item.id)} />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        onEndReached={() => void loadNextPage()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator size="small" color={t.fg} />
            </View>
          ) : null
        }
      />
    </View>
  );
}

function ListHeader({
  isRiding,
  onStart,
  onResume,
}: {
  isRiding: boolean;
  onStart: () => void;
  onResume: () => void;
}) {
  if (isRiding) {
    return (
      <TouchableOpacity
        style={styles.activeCard}
        onPress={onResume}
        accessibilityRole="button"
        accessibilityLabel="Return to active ride"
      >
        <View style={styles.activeIconWrap}>
          <Icon name="play-circle" size={26} color={t.invFg} />
        </View>
        <View style={styles.activeBody}>
          <Text style={styles.activeTitle}>Ride in progress</Text>
          <Text style={styles.activeSubtitle}>
            Tap to return to the live HUD.
          </Text>
        </View>
        <Icon name="chevron-right" size={22} color={t.invFg} />
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      style={styles.startCard}
      onPress={onStart}
      accessibilityRole="button"
      accessibilityLabel="Start a free ride"
    >
      <View style={styles.startIconWrap}>
        {/* Ink glyph on the accent disc (~6.7:1); cream would be ~2.5:1. */}
        <Icon name="play" size={24} color={t.fg} />
      </View>
      <View style={styles.startBody}>
        <Text style={styles.startTitle}>Start a ride</Text>
        <Text style={styles.startSubtitle}>
          Capture stats and road quality on the move.
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <View style={styles.emptyWrap}>
      <Icon name="motorbike" size={48} color={t.accent} />
      <Text style={styles.emptyTitle}>No rides yet</Text>
      <Text style={styles.emptyBody}>
        Start your first ride and Tarmoto will record distance, road quality,
        and segment-by-segment stats.
      </Text>
      <TouchableOpacity
        style={styles.primaryBtn}
        onPress={onStart}
        accessibilityRole="button"
        accessibilityLabel="Start your first ride"
      >
        <Icon name="play" size={18} color={t.invFg} />
        <Text style={styles.primaryBtnLabel}>Start your first ride</Text>
      </TouchableOpacity>
    </View>
  );
}

function RideCard({
  ride,
  onPress,
}: {
  ride: RideSummary;
  onPress: () => void;
}) {
  const qScore = ride.avg_road_quality ?? 0;
  const qHas = qScore > 0;
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Ride ${formatRideDate(ride.started_at)}, ${formatDistanceKm(
        ride.distance_km,
      )}`}
    >
      <View style={styles.cardBody}>
        <Text style={styles.cardDate}>{formatRideDate(ride.started_at)}</Text>
        <View style={styles.cardMetricsRow}>
          <RideMetric
            label="Distance"
            value={formatDistanceKm(ride.distance_km)}
          />
          <RideMetric
            label="Duration"
            value={formatDurationMinutes(ride.duration_min)}
          />
          {/* Quality value stays ink: the ramp fails AA as text on the card. */}
          <RideMetric
            label="Quality"
            value={qHas ? qualityLabel(qScore) : "—"}
          />
        </View>
      </View>
      <Icon name="chevron-right" size={22} color={t.faint} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  listContent: {
    padding: brandSpacing.s5,
    paddingBottom: brandSpacing.s12,
    flexGrow: 1,
    gap: brandSpacing.s3,
  },
  separator: {
    height: brandSpacing.s3,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: t.bg,
  },
  errorTopCard: {
    paddingHorizontal: brandSpacing.s5,
    paddingTop: brandSpacing.s5,
  },
  centeredFlex: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  startCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    marginBottom: brandSpacing.s3,
  },
  startIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    // The "Start ride" accent moment (rule #1: accent used sparingly).
    backgroundColor: t.accent,
  },
  startBody: {
    flex: 1,
    gap: 2,
  },
  startTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  startSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  // The resume card reads as a solid ink card (the active-ride return path),
  // distinct from the white start card.
  activeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    backgroundColor: t.invBg,
    borderRadius: brandRadii.md,
    marginBottom: brandSpacing.s3,
  },
  activeIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(245,239,230,0.15)",
  },
  activeBody: {
    flex: 1,
    gap: 2,
  },
  activeTitle: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  activeSubtitle: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    opacity: 0.85,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
  },
  cardBody: {
    flex: 1,
    gap: brandSpacing.s2,
  },
  cardDate: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  cardMetricsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 48,
    justifyContent: "center",
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  primaryBtnLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  footerLoader: {
    paddingVertical: brandSpacing.s4,
    alignItems: "center",
  },
});
