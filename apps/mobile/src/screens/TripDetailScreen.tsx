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
import { useEntitlements, useFeature } from "@/hooks/useEntitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { useTripStore } from "@/stores";
import type { MountainPass, Trip, TripDay, TripMember } from "@/types";
import type {
  RootTabParamList,
  TripsStackParamList,
} from "@/navigation/RootNavigator";
import {
  averageQuality,
  buildClosedPassWarning,
  flattenTripRoute,
  formatDailyDistanceRange,
  formatDurationMin,
  formatElevationM,
  formatKm,
  formatStatus,
  formatMemberRole,
  routeGeometrySignature,
  summarizeWaypoints,
  isLastDay,
  sumDistance,
  tripToGpxInput,
} from "./TripScreens.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { useFormat } from "@/format/FormatProvider";

type DetailRoute = RouteProp<TripsStackParamList, "TripDetail">;
type DetailNav = NativeStackNavigationProp<TripsStackParamList, "TripDetail">;

const t = brandColorsLight;

export default function TripDetailScreen() {
  const translate = useTranslation();
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
  const [closedPassCount, setClosedPassCount] = useState(0);
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
        if (!opts.signal?.cancelled) setError(translate("Missing trip id"));
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
    [tripId, setActiveTrip, translate],
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
          setError(
            getUserFacingErrorMessage(e, translate("Failed to load trip")),
          );
        }
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [fetchTrip, translate]);

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
      setClosedPassCount(0);
      return;
    }
    if (passRoute.length < 2) {
      setClosedPasses([]);
      setClosedPassCount(0);
      return;
    }
    let cancelled = false;
    void api
      .checkRouteForPasses(passRoute)
      .then((res) => {
        if (cancelled) return;
        const warning = buildClosedPassWarning(res);
        setClosedPasses(warning.passes);
        setClosedPassCount(warning.count);
      })
      .catch(() => {
        if (!cancelled) {
          setClosedPasses([]);
          setClosedPassCount(0);
        }
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
      setError(getUserFacingErrorMessage(e, translate("Failed to load trip")));
    } finally {
      setLoading(false);
    }
  }, [fetchTrip, translate]);

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
        <Text style={styles.errorTitle}>
          {translate("Unable to load trip")}
        </Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => void retry()}
        >
          <Text style={styles.primaryBtnLabel}>{translate("Try again")}</Text>
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

      {closedPassCount > 0 ? (
        <ClosedPassesWarning passes={closedPasses} count={closedPassCount} />
      ) : null}

      <ExportGpxAction trip={trip} />

      <MembersCard members={trip.members} />

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader}>{translate("Days")}</Text>
        <Text style={styles.sectionHeaderMeta}>
          {translate("{count, plural, one {# day} other {# days}}", {
            count: trip.days.length,
          })}
        </Text>
      </View>

      {trip.days.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyDaysTitle}>
            {translate("No days generated yet")}
          </Text>
          <Text style={styles.emptyDaysBody}>
            {translate(
              "The route generator hasn't produced any days for this trip. Pull to refresh, or go back and try different parameters.",
            )}
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
  const format = useFormat();
  const translate = useTranslation();
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
        <Metric label={translate("Total")} value={formatKm(totalKm)} />
        <Metric
          label={translate("Days")}
          value={format.integer(trip.num_days)}
          sub={formatDailyDistanceRange(trip.daily_km_min, trip.daily_km_max)}
        />
        <Metric
          label={translate("Quality")}
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
  const format = useFormat();
  const translate = useTranslation();
  const qColor =
    day.avg_quality > 0 ? qualityBrandColor(day.avg_quality) : UNSCORED_COLOR;
  const overnightStop = summarizeWaypoints(day.waypoints, isFinalDay)
    .overnightStops[0];
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        day.title
          ? translate("Day {day}, {title}", {
              day: day.day_number,
              title: day.title,
            })
          : translate("Day {day}", { day: day.day_number })
      }
    >
      <View style={styles.dayHeaderRow}>
        <View style={styles.dayNumberBubble}>
          <Text style={styles.dayNumber}>
            {format.number(day.day_number, {
              useGrouping: false,
              maximumFractionDigits: 0,
            })}
          </Text>
        </View>
        <View style={styles.dayHeaderText}>
          <Text style={styles.dayTitle}>
            {day.title ?? translate("Day {value0}", { value0: day.day_number })}
          </Text>
          <Text style={styles.dayMeta}>
            {formatKm(day.distance_km)} ·{" "}
            {formatDurationMin(day.estimated_time_min)} ·{" "}
            {formatElevationM(day.elevation_gain, "+")}
          </Text>
        </View>
        <Icon name="chevron-right" size={22} color={t.faint} />
      </View>
      <View style={styles.qualityRow}>
        <View style={[styles.qualitySwatch, { backgroundColor: qColor }]} />
        <Text style={styles.qualityText}>
          {day.avg_quality > 0
            ? qualityLabel(day.avg_quality)
            : translate("No data yet")}
        </Text>
        <Text style={styles.waypointCount}>
          {translate("{count, plural, one {# waypoint} other {# waypoints}}", {
            count: day.waypoints.length,
          })}
        </Text>
      </View>
      {overnightStop ? (
        <View style={styles.overnightRow}>
          <Icon name="bed-outline" size={15} color={t.dim} />
          <Text style={styles.overnightLabel} numberOfLines={1}>
            {translate("Overnight: {name}", {
              name: overnightStop.name ?? translate("Suggested stay"),
            })}
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
export function ExportGpxAction({ trip }: { trip: Trip }) {
  const translate = useTranslation();
  const [busy, setBusy] = useState(false);
  // Synchronous re-entrancy guard — same rationale as `BulkExportCard`
  // and `TripCreateScreen`: `setBusy` only flips on the next render, so
  // two same-frame taps would both pass `if (busy)` and trigger
  // duplicate file writes / share sheets.
  const busyRef = useRef(false);
  // `gpx_export` gate. This GPX is rendered ENTIRELY client-side from the
  // Trip object already on screen (there is no `/trips/:id/gpx` server
  // endpoint to enforce the entitlement), so we MUST fail closed: never
  // produce the file without a resolved, entitled snapshot. The button is
  // disabled while unresolved (below), so `handleExport` only runs for a
  // resolved rider — entitled → export, non-entitled → upgrade prompt.
  const { enabled: gpxEnabled, isResolved: gpxResolved } =
    useFeature("gpx_export");
  const { tier } = useEntitlements();
  const [upgradeVisible, setUpgradeVisible] = useState(false);

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
    // Proactive gate: a resolved, non-entitled rider gets the upgrade
    // prompt instead of a client-generated file. Never export without a
    // CONFIRMED entitlement — there is no server guard to catch a slip.
    if (gpxResolved && !gpxEnabled) {
      setUpgradeVisible(true);
      return;
    }
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
        title: translate("Export trip as GPX"),
        // Don't surface a cancel as an error — riders dismissing the
        // sheet is a routine outcome, not a failure mode worth toasting.
        failOnCancel: false,
      });
    } catch (err) {
      Alert.alert(
        translate("Couldn't export"),
        getUserFacingErrorMessage(err, translate("Unable to export GPX.")),
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
  }, [trip, gpxEnabled, gpxResolved, translate]);

  if (!hasGeometry) return null;

  return (
    <>
      <TouchableOpacity
        style={styles.exportBtn}
        onPress={() => void handleExport()}
        disabled={busy || !gpxResolved}
        accessibilityRole="button"
        accessibilityLabel={translate("Export trip as GPX")}
        accessibilityState={{ busy, disabled: busy || !gpxResolved }}
      >
        {busy ? (
          <ActivityIndicator color={t.fg} />
        ) : (
          <>
            <Icon name="download-outline" size={20} color={t.fg} />
            <Text style={styles.exportLabel}>{translate("Export GPX")}</Text>
          </>
        )}
      </TouchableOpacity>
      <UpgradePrompt
        visible={upgradeVisible}
        capability={{ feature: "gpx_export" }}
        currentTier={tier ?? "free"}
        message={translate("GPX export is a Pro feature.")}
        onClose={() => setUpgradeVisible(false)}
      />
    </>
  );
}

function MembersCard({ members }: { members: TripMember[] }) {
  const translate = useTranslation();
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
        <Text style={styles.sectionHeader}>{translate("Members")}</Text>
        <Text style={styles.sectionHeaderMeta}>
          {translate("{count, plural, one {# rider} other {# riders}}", {
            count: members.length,
          })}
        </Text>
      </View>
      {sorted.map((m) => (
        <MemberRow key={m.user_id} member={m} />
      ))}
    </View>
  );
}

export function MemberRow({ member }: { member: TripMember }) {
  const translate = useTranslation();
  const badgeColor = roleBadgeColor(member.role);
  // US-27: tapping a rider opens their profile in the Profile tab. Cross-
  // tab navigation is required because TripDetail lives in TripsStack —
  // jumping into ProfileTab keeps the Profile back-stack clean and
  // avoids polluting TripsStack with rider profiles.
  const rootNav = useNavigation<NativeStackNavigationProp<RootTabParamList>>();
  // Operator `community_access` kill switch: don't let the tap through while
  // killed. The cross-tab jump into ProfileTab lands BEFORE ViewProfileScreen's
  // navigate-back fires, which would strand the rider on their own Profile tab
  // instead of this trip. Make the row non-interactive so the tab context is
  // preserved.
  const communityEnabled = useFeatureKillSwitchActive("community_access");
  return (
    <TouchableOpacity
      style={styles.memberRow}
      disabled={!communityEnabled}
      onPress={
        communityEnabled
          ? () =>
              rootNav.navigate("ProfileTab", {
                screen: "ViewProfile",
                params: { userId: member.user_id },
              })
          : undefined
      }
      accessibilityRole={communityEnabled ? "button" : "text"}
      accessibilityLabel={
        communityEnabled
          ? translate("Open {value0}'s profile", {
              value0: member.display_name,
            })
          : member.display_name
      }
    >
      <View style={styles.memberAvatar}>
        <Icon name="account" size={18} color={t.dim} />
      </View>
      <Text style={styles.memberName} numberOfLines={1}>
        {member.display_name}
      </Text>
      <View style={[styles.roleBadge, { borderColor: badgeColor }]}>
        <Text style={[styles.roleLabel, { color: badgeColor }]}>
          {formatMemberRole(member.role)}
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

function ClosedPassesWarning({
  passes,
  count,
}: {
  passes: MountainPass[];
  count: number;
}) {
  const format = useFormat();
  const translate = useTranslation();
  // Sort by elevation descending so the most consequential closure
  // (typically also the one most likely to be still snowed-in) leads.
  const sorted = [...passes].sort((a, b) => b.elevation_m - a.elevation_m);
  const headline = translate(
    "{count, plural, one {# closed pass} other {# closed passes}} on this route",
    { count },
  );
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
        {translate(
          "These passes are likely closed when you ride. Plan a detour or check local conditions before departing.",
        )}
      </Text>
      {sorted.map((p) => (
        <View key={p.id} style={styles.warningPassRow}>
          <Text style={styles.warningPassName} numberOfLines={1}>
            {p.name}
          </Text>
          <Text style={styles.warningPassMeta}>
            {translate("{elevation} · {country}", {
              elevation: format.elevation(p.elevation_m),
              country: p.country_code,
            })}
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
