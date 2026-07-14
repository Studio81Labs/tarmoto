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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "@/components/Icon";
import { tripGpxFileName, tripToGpx } from "@tarmoto/shared";
import { qualityLabel } from "@/theme";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  statusFg,
  UNSCORED_COLOR,
} from "@/theme/brand";
import { api } from "@/services/api";
import { useTripStore } from "@/stores";
import type { MountainPass, Trip, TripDay, TripMember } from "@/types";
import type {
  RootTabParamList,
  TripsStackParamList,
} from "@/navigation/RootNavigator";
import {
  averageQuality,
  flattenTripRoute,
  formatDurationMin,
  formatKm,
  formatStatus,
  routeGeometrySignature,
  summarizeWaypoints,
  isLastDay,
  sumDistance,
  tripToGpxInput,
} from "./TripScreens.helpers";

type DetailRoute = RouteProp<TripsStackParamList, "TripDetail">;
type DetailNav = NativeStackNavigationProp<TripsStackParamList, "TripDetail">;

const t = brandColorsLight;

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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (error || !trip) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={statusFg.danger} />
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
          tintColor={t.fg}
        />
      }
    >
      <HeaderCard trip={trip} totalKm={totalKm} avgQ={avgQ} />

      {closedPasses.length > 0 ? (
        <ClosedPassesWarning passes={closedPasses} />
      ) : null}

      <ExportGpxAction trip={trip} />

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
            isFinalDay={isLastDay(trip.days, day.day_number)}
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
  const statusColor = statusBadgeColor(trip.status);
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={2}>
          {trip.title}
        </Text>
        <View style={[styles.statusPill, { borderColor: statusColor }]}>
          <Text style={[styles.statusLabel, { color: statusColor }]}>
            {formatStatus(trip.status)}
          </Text>
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
          swatchColor={avgQ > 0 ? qualityBrandColor(avgQ) : undefined}
        />
      </View>
    </View>
  );
}

function DayCard({
  day,
  isFinalDay,
  onPress,
}: {
  day: TripDay;
  isFinalDay: boolean;
  onPress: () => void;
}) {
  const qColor =
    day.avg_quality > 0 ? qualityBrandColor(day.avg_quality) : UNSCORED_COLOR;
  const overnightStop = summarizeWaypoints(day.waypoints, isFinalDay)
    .overnightStops[0];
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
        <Icon name="chevron-right" size={22} color={t.faint} />
      </View>
      <View style={styles.qualityRow}>
        <View style={[styles.qualitySwatch, { backgroundColor: qColor }]} />
        <Text style={styles.qualityText}>
          {day.avg_quality > 0 ? qualityLabel(day.avg_quality) : "No data yet"}
        </Text>
        <Text style={styles.waypointCount}>
          {day.waypoints.length} waypoint
          {day.waypoints.length === 1 ? "" : "s"}
        </Text>
      </View>
      {overnightStop ? (
        <View style={styles.overnightRow}>
          <Icon name="bed-outline" size={15} color={t.dim} />
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
  // Synchronous re-entrancy guard — same rationale as `BulkExportCard`
  // and `TripCreateScreen`: `setBusy` only flips on the next render, so
  // two same-frame taps would both pass `if (busy)` and trigger
  // duplicate file writes / share sheets.
  const busyRef = useRef(false);

  const hasGeometry = useMemo(
    () =>
      trip.days.some(
        (day) =>
          Array.isArray(day.route_geometry) && day.route_geometry.length > 1,
      ),
    [trip.days],
  );

  const handleExport = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
    }
  }, [trip]);

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
        <ActivityIndicator color={t.fg} />
      ) : (
        <>
          <Icon name="download-outline" size={20} color={t.fg} />
          <Text style={styles.exportLabel}>Export GPX</Text>
        </>
      )}
    </TouchableOpacity>
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
  // US-27: tapping a rider opens their profile in the Profile tab. Cross-
  // tab navigation is required because TripDetail lives in TripsStack —
  // jumping into ProfileTab keeps the Profile back-stack clean and
  // avoids polluting TripsStack with rider profiles.
  const rootNav = useNavigation<NativeStackNavigationProp<RootTabParamList>>();
  return (
    <TouchableOpacity
      style={styles.memberRow}
      onPress={() =>
        rootNav.navigate("ProfileTab", {
          screen: "ViewProfile",
          params: { userId: member.user_id },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`Open ${member.display_name}'s profile`}
    >
      <View style={styles.memberAvatar}>
        <Icon name="account" size={18} color={t.dim} />
      </View>
      <Text style={styles.memberName} numberOfLines={1}>
        {member.display_name}
      </Text>
      <View style={[styles.roleBadge, { borderColor: badgeColor }]}>
        <Text style={[styles.roleLabel, { color: badgeColor }]}>
          {member.role}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function rolePriority(role: TripMember["role"]): number {
  switch (role) {
    case "owner":
      return 0;
    case "editor":
      return 1;
    case "viewer":
      return 2;
  }
}

// Role badge border + text. All clear AA / 3:1 on the white card:
// `ACCENT_DARK` is the burnt-orange owner mark (the raw accent fails AA as
// text), ink marks the editor, and `dim` is the neutral viewer fallback.
function roleBadgeColor(role: TripMember["role"]): string {
  switch (role) {
    case "owner":
      return ACCENT_DARK;
    case "editor":
      return t.fg;
    case "viewer":
      return t.dim;
  }
}

// Status pill border + text, mirroring TripsScreen. All clear AA on the
// white card: `ACCENT_DARK` is the active mark, `statusFg.*` cover
// completed/planned, and `dim` is the neutral draft fallback.
function statusBadgeColor(status: Trip["status"]): string {
  switch (status) {
    case "active":
      return ACCENT_DARK;
    case "completed":
      return statusFg.success;
    case "planned":
      return statusFg.warning;
    default:
      return t.dim;
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
        <Icon name="alert-octagon" size={22} color={statusFg.danger} />
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
  swatchColor,
}: {
  label: string;
  value: string;
  sub?: string;
  // Ramp colour for quality metrics. Rendered as a swatch dot beside the
  // ink value — the Q1–Q5 ramp fails AA as text on the cream card, so the
  // colour lives on the swatch (rule #4 quality vocabulary) and the label
  // stays ink.
  swatchColor?: string | undefined;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricValueRow}>
        {swatchColor ? (
          <View
            style={[styles.qualitySwatch, { backgroundColor: swatchColor }]}
          />
        ) : null}
        <Text style={styles.metricValue}>{value}</Text>
      </View>
      {sub ? <Text style={styles.metricSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s8,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  errorTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  errorBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
  },
  primaryBtn: {
    marginTop: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
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
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  warningCard: {
    backgroundColor: t.raised2,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: statusFg.danger,
    padding: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  warningHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  warningTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  warningBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
  warningPassRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: brandSpacing.s1,
  },
  warningPassName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
    paddingRight: brandSpacing.s2,
  },
  warningPassMeta: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: brandSpacing.s2,
  },
  title: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  statusPill: {
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 4,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
  },
  statusLabel: {
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  region: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: brandSpacing.s3,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  metricValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    marginTop: 4,
  },
  metricValue: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  metricSub: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    marginTop: 2,
  },
  qualitySwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  sectionHeader: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
  },
  sectionHeaderMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  dayHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  dayNumberBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  dayNumber: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  dayHeaderText: {
    flex: 1,
    gap: 2,
  },
  dayTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "600",
  },
  dayMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  qualityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  qualityText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
  },
  waypointCount: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    marginLeft: "auto",
  },
  overnightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  overnightLabel: {
    flex: 1,
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  emptyDaysTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  emptyDaysBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    lineHeight: 20,
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
    backgroundColor: t.raised,
  },
  exportLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s1,
  },
  memberAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  memberName: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  roleBadge: {
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 2,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
  },
  roleLabel: {
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
});
