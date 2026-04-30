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

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import { tripGpxFileName, tripToGpx } from "@tarmoto/shared";
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
import type { MountainPass, Trip, TripDay, TripMember } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  averageQuality,
  flattenTripRoute,
  formatDurationMin,
  formatKm,
  formatStatus,
  routeGeometrySignature,
  summarizeWaypoints,
  sumDistance,
  tripToGpxInput,
} from "./TripScreens.helpers";

type DetailRoute = RouteProp<TripsStackParamList, "TripDetail">;
type DetailNav = NativeStackNavigationProp<TripsStackParamList, "TripDetail">;

export default function TripDetailScreen() {
  const { params } = useRoute<DetailRoute>();
  const navigation = useNavigation<DetailNav>();
  const tripId = params?.tripId;

  const activeTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedPasses, setClosedPasses] = useState<MountainPass[]>([]);
  const [passCheckVersion, setPassCheckVersion] = useState(0);

  useEffect(() => {
    if (activeTrip?.id !== tripId) return;
    setTrip(activeTrip);
  }, [activeTrip, tripId]);

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
        setPassCheckVersion((value) => value + 1);
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

  const passRoute = useMemo(
    () => (trip ? flattenTripRoute(trip.days) : []),
    [trip?.days],
  );
  const passRouteSignature = useMemo(
    () => (trip ? routeGeometrySignature(trip.days) : ""),
    [trip?.days],
  );

  // US-11: surface closed mountain passes that the planned route
  // crosses so the rider doesn't drive into a snowbank. We re-run the
  // check whenever the route geometry changes or a fresh backend fetch
  // lands. That avoids re-querying `/passes/check-route` for waypoint-
  // only client-side updates (like suggested overnight stays) while
  // still refreshing pass status after a manual reload.
  useEffect(() => {
    if (!trip || passRouteSignature.length === 0) {
      setClosedPasses([]);
      return;
    }
    if (passRoute.length < 2) {
      setClosedPasses([]);
      return;
    }
    let cancelled = false;
    void api
      .checkRouteForPasses(passRoute)
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
  }, [passCheckVersion, passRouteSignature, trip?.id]);

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

      <ExportGpxAction trip={trip} />

      <InviteCard tripId={trip.id} inviteCode={trip.invite_code} />
      <MembersCard members={trip.members} />

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
  const overnightStop = summarizeWaypoints(day.waypoints).overnightStops[0];
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
      {overnightStop ? (
        <View style={styles.overnightRow}>
          <Icon name="bed-outline" size={15} color={colors.primary} />
          <Text style={styles.overnightLabel} numberOfLines={1}>
            Overnight: {overnightStop.name ?? "Suggested stay"}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

/**
 * US-20: lets the rider hand the trip off to Garmin / RideWithGPS /
 * Komoot etc. as a GPX file. The backend has no `/trips/:id/gpx`
 * endpoint yet (only the data-export bundle bakes per-day GPX), so we
 * render the file client-side from the same Trip object the screen is
 * already showing — no extra round trip and no risk of the share sheet
 * stalling on a slow network.
 */
function ExportGpxAction({ trip }: { trip: Trip }) {
  const [busy, setBusy] = useState(false);

  const hasGeometry = useMemo(
    () =>
      trip.days.some(
        (day) =>
          Array.isArray(day.route_geometry) && day.route_geometry.length > 1,
      ),
    [trip.days],
  );

  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const filename = tripGpxFileName(trip.title);
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${filename}`.replace(
      /\/{2,}/g,
      "/",
    );
    try {
      const xml = tripToGpx(tripToGpxInput(trip));
      await RNFS.writeFile(tempPath, xml, "utf8");
      await RNShare.open({
        url: Platform.OS === "android" ? `file://${tempPath}` : tempPath,
        type: "application/gpx+xml",
        filename,
        title: "Export trip as GPX",
        // Don't surface a cancel as an error — riders dismissing the
        // sheet is a routine outcome, not a failure mode worth toasting.
        failOnCancel: false,
      });
    } catch (err) {
      Alert.alert(
        "Couldn't export",
        err instanceof Error ? err.message : "Unable to export GPX.",
      );
    } finally {
      // Same rationale as RideDetailScreen: leave the temp file in
      // place so the share target can read it lazily (Mail / Files /
      // third-party importers all stage payloads asynchronously).
      // `TemporaryDirectoryPath` is reaped by the OS so a stray .gpx
      // is harmless.
      setBusy(false);
    }
  }, [busy, trip]);

  if (!hasGeometry) return null;

  return (
    <TouchableOpacity
      style={styles.exportBtn}
      onPress={() => void handleExport()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Export trip as GPX"
      accessibilityState={{ busy }}
    >
      {busy ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <Icon name="download-outline" size={20} color={colors.primary} />
          <Text style={styles.exportLabel}>Export GPX</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function InviteCard({
  tripId,
  inviteCode,
}: {
  tripId: string;
  inviteCode: string;
}) {
  // US-8: the invite code is the only token a rider needs to join, so we
  // make it the visual centrepiece. Share.share lets riders forward the
  // details through whatever channel they use — SMS, WhatsApp, etc. — so
  // we don't need a custom share-sheet component.
  const [shareError, setShareError] = useState<string | null>(null);

  const handleShare = useCallback(async () => {
    setShareError(null);
    try {
      const message =
        `Join my Tarmoto trip\n\n` +
        `Trip ID: ${tripId}\n` +
        `Invite code: ${inviteCode}\n\n` +
        `Open Tarmoto → Trips → Join a trip and paste both to ride along.`;
      await Share.share({ message, title: "Tarmoto trip invite" });
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Unable to share");
    }
  }, [tripId, inviteCode]);

  if (!inviteCode) return null;

  return (
    <View style={styles.card}>
      <View style={styles.inviteHeader}>
        <Icon name="account-multiple-plus" size={20} color={colors.primary} />
        <Text style={styles.inviteHeaderLabel}>Invite riders</Text>
      </View>
      <Text style={styles.inviteBody}>
        Share this code so your group can join and plan together.
      </Text>
      <View style={styles.inviteCodeRow}>
        <Text
          style={styles.inviteCode}
          selectable
          accessibilityLabel={`Invite code ${inviteCode}`}
        >
          {inviteCode}
        </Text>
        <TouchableOpacity
          style={styles.inviteShareBtn}
          onPress={() => void handleShare()}
          accessibilityRole="button"
          accessibilityLabel="Share invite"
        >
          <Icon name="share-variant" size={16} color={colors.textInverse} />
          <Text style={styles.inviteShareLabel}>Share</Text>
        </TouchableOpacity>
      </View>
      {shareError ? <Text style={styles.inviteError}>{shareError}</Text> : null}
    </View>
  );
}

function MembersCard({ members }: { members: TripMember[] }) {
  if (members.length === 0) return null;
  // Owner leads, then admins, then members — inside each bucket keep the
  // server's ordering (typically join order). Sorting by role keeps the
  // owner anchored to the top regardless of who joined first.
  const sorted = [...members].sort(
    (a, b) => rolePriority(a.role) - rolePriority(b.role),
  );
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>Members</Text>
        <Text style={styles.sectionHeaderMeta}>
          {members.length} rider{members.length === 1 ? "" : "s"}
        </Text>
      </View>
      {sorted.map((m) => (
        <MemberRow key={m.user_id} member={m} />
      ))}
    </View>
  );
}

function MemberRow({ member }: { member: TripMember }) {
  const badgeColor = roleBadgeColor(member.role);
  return (
    <View style={styles.memberRow}>
      <View style={styles.memberAvatar}>
        <Icon name="account" size={18} color={colors.primary} />
      </View>
      <Text style={styles.memberName} numberOfLines={1}>
        {member.display_name}
      </Text>
      <View style={[styles.roleBadge, { borderColor: badgeColor }]}>
        <Text style={[styles.roleLabel, { color: badgeColor }]}>
          {member.role}
        </Text>
      </View>
    </View>
  );
}

function rolePriority(role: TripMember["role"]): number {
  switch (role) {
    case "owner":
      return 0;
    case "admin":
      return 1;
    case "member":
      return 2;
  }
}

function roleBadgeColor(role: TripMember["role"]): string {
  switch (role) {
    case "owner":
      return colors.primary;
    case "admin":
      return colors.info;
    case "member":
      return colors.textTertiary;
  }
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
  overnightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  overnightLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: fontSize.sm,
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
  inviteHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  inviteHeaderLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  inviteBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  inviteCodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  inviteCode: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
    padding: spacing.md,
    backgroundColor: colors.bgElevated,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inviteShareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  inviteShareLabel: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  inviteError: {
    color: colors.danger,
    fontSize: fontSize.xs,
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.bgCard,
  },
  exportLabel: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  memberAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  memberName: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  roleBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
  },
  roleLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
});
