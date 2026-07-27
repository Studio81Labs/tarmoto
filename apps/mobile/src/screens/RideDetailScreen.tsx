/**
 * RideDetailScreen — US-19 past-ride detail view.
 *
 * Renders the recorded route on a MapLibre base map with quality-coloured
 * polyline segments, then a stats grid (distance, time, speed,
 * elevation, lean angle, fuel, curves), a per-segment quality
 * histogram, and Share / Export-GPX actions. The polyline geometry,
 * segments, and aggregate stats all come from `GET /rides/:id`. The
 * GPX export uses the existing `GET /rides/:id/gpx` endpoint and is
 * forwarded to the system share sheet via `react-native-share`.
 *
 * Reachable from both the Home tab (recent rides on Home →
 * RideDetail) and the Ride tab (history list → RideDetail), so the
 * screen is parameterised by `rideId` only and does its own fetch.
 */
import React, {
  type ComponentProps,
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
import { Icon } from "@/components/Icon";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
} from "@maplibre/maplibre-react-native";
import { qualityLabel } from "@/theme";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import type { RideDetail, RideSegment } from "@/types";
import type {
  HomeStackParamList,
  RideStackParamList,
} from "@/navigation/RootNavigator";
import RideMetric from "@/components/RideMetric";
import { APP_MAP_STYLE_URL } from "./MapScreen.helpers";
import {
  buildRideShareMessage,
  formatCurveCount,
  formatDistanceKm,
  formatDurationMinutes,
  formatElevation,
  formatFuelLiters,
  formatLeanAngle,
  formatRideDate,
  formatSpeedKmh,
  leanHistogramRows,
  leanSampleTotal,
  rideBounds,
  rideRouteFeatureCollection,
  rideRouteLineColorExpression,
  segmentQualityHistogram,
  type LeanHistogramRow,
} from "./RideScreens.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useEntitlements, useFeature } from "@/hooks/useEntitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { upgradeTierForFeature } from "@tarmoto/shared";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";

type IconName = ComponentProps<typeof Icon>["name"];

// Both Home and Ride stacks declare a `RideDetail` route with the same
// shape, so the screen accepts either. A discriminated route param
// type would be over-engineering — just take what you need.
type DetailRoute = RouteProp<
  HomeStackParamList & RideStackParamList,
  "RideDetail"
>;
type DetailNav = NativeStackNavigationProp<
  HomeStackParamList & RideStackParamList,
  "RideDetail"
>;

type Phase = "loading" | "ready" | "error";

const t = brandColorsLight;

export default function RideDetailScreen() {
  const translate = useTranslation();
  const { params } = useRoute<DetailRoute>();
  const navigation = useNavigation<DetailNav>();
  const rideId = params?.rideId;

  const [ride, setRide] = useState<RideDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True from the moment advanced_ride_stats unlocks (the current payload was
  // fetched while disabled, so its lean/elevation fields are stripped to null)
  // until the unlock refetch SUCCEEDS with fresh data. While set, the paid
  // tiles stay locked rather than rendering the stale nulls as dashes — a
  // failed refetch must not strand the newly-entitled rider on a dead
  // "No lean data" view. Cleared only on a successful silent refetch.
  const [statsStale, setStatsStale] = useState(false);

  // Single ref-based cancellation token shared by the mount fetch and
  // every Retry. Each new fetch flips the previous token's `cancelled`
  // flag so an in-flight request can't call `setRide` / `setPhase`
  // after the screen unmounts (or after the rider has triggered a
  // newer retry). The mount effect's cleanup also flips it, covering
  // the unmount path.
  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const fetchRide = useCallback(
    async (options?: { silent?: boolean }) => {
      // A silent refetch (the background entitlement-triggered one) must never
      // tear the screen down to the loading/error state — it refreshes data
      // under an already-rendered ride, so on failure we keep what's on screen.
      const silent = options?.silent ?? false;
      if (!rideId) {
        if (!silent) {
          setPhase("error");
          setErrorMessage(translate("Missing ride id"));
        }
        return;
      }
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
      const signal = { cancelled: false };
      fetchSignalRef.current = signal;
      try {
        const next = await api.getRide(rideId);
        if (signal.cancelled) return;
        setRide(next);
        setPhase("ready");
        setErrorMessage(null);
        // A successful SILENT refetch is the unlock-triggered one — its payload
        // carries the now-entitled fields, so the tiles can safely unlock.
        if (silent) setStatsStale(false);
      } catch (err) {
        if (signal.cancelled) return;
        // Keep the already-shown ride on a silent-refetch failure — but the
        // stats stay `statsStale` (still locked), never dashes over stale nulls.
        if (silent) return;
        setPhase("error");
        setErrorMessage(
          getUserFacingErrorMessage(err, translate("Couldn't load ride")),
        );
      }
    },
    [rideId, translate],
  );

  useEffect(() => {
    setPhase("loading");
    void fetchRide();
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [fetchRide]);

  const retry = useCallback(() => {
    setPhase("loading");
    void fetchRide();
  }, [fetchRide]);

  // advanced_ride_stats refetch: the backend strips lean/elevation to null for
  // a non-entitled viewer. If the rider opened this screen while disabled and a
  // later foreground refresh grants the feature, the already-fetched ride still
  // carries the stripped nulls — refetch on the genuine disabled→enabled
  // transition so the newly-unlocked tiles show real data, not dashes. `null`
  // = not yet resolved, so the initial unknown→enabled resolution (which never
  // stripped anything) doesn't trigger a spurious refetch.
  const { enabled: advancedStatsEnabled, isResolved: advancedStatsResolved } =
    useFeature("advanced_ride_stats");
  const prevAdvancedStatsRef = useRef<boolean | null>(null);
  const [statsRefetchPending, setStatsRefetchPending] = useState(false);
  // Detect the disabled→enabled transition ALWAYS (even while the initial load
  // is still in flight), so `prev` records the disabled state. If the initial
  // response comes back stripped, we still know a refetch is owed. We only mark
  // it pending here — the fetch itself is deferred to the effect below so it
  // never shares the cancellation token with, and aborts, an in-flight initial
  // load.
  useEffect(() => {
    if (!advancedStatsResolved) return;
    const prev = prevAdvancedStatsRef.current;
    prevAdvancedStatsRef.current = advancedStatsEnabled;
    if (prev === false && advancedStatsEnabled) {
      // Data owed a refresh AND is known stale until that refresh lands — keep
      // the tiles locked (not dashes) across the whole refetch, fail included.
      setStatsRefetchPending(true);
      setStatsStale(true);
    }
  }, [advancedStatsResolved, advancedStatsEnabled]);
  // Drain the pending refetch once the initial load has settled. Silent: a
  // failed background refetch keeps the current ride visible rather than
  // blanking it to an error screen.
  useEffect(() => {
    if (phase === "ready" && statsRefetchPending) {
      setStatsRefetchPending(false);
      void fetchRide({ silent: true });
    }
  }, [phase, statsRefetchPending, fetchRide]);
  // Re-arm the (silent) refetch. Used by the stale-stats tiles: when the
  // unlock refetch failed, an entitled rider taps a tile to retry rather than
  // being shown an upgrade prompt for a feature they already have.
  const retryStats = useCallback(() => setStatsRefetchPending(true), []);

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (phase === "error" || !ride) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={statusFg.danger} />
        <Text style={styles.errorTitle}>{translate("Couldn't load ride")}</Text>
        {errorMessage ? (
          <Text style={styles.errorBody}>{errorMessage}</Text>
        ) : null}
        <View style={styles.errorActions}>
          <TouchableOpacity style={styles.primaryBtn} onPress={retry}>
            <Text style={styles.primaryBtnLabel}>{translate("Try again")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.secondaryBtnLabel}>{translate("Back")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <RideDetailBody
      ride={ride}
      statsStale={statsStale}
      onStatsRetry={retryStats}
    />
  );
}

function RideDetailBody({
  ride,
  statsStale,
  onStatsRetry,
}: {
  ride: RideDetail;
  /** The payload was fetched pre-unlock and hasn't been refreshed yet — keep
   *  the paid tiles locked rather than rendering its stripped nulls as dashes. */
  statsStale: boolean;
  /** Re-run the unlock refetch (the stale tiles are a retry affordance, not an
   *  upsell — the rider is already entitled). */
  onStatsRetry: () => void;
}) {
  const featureCollection = useMemo(
    () => rideRouteFeatureCollection(ride.route_geometry, ride.segments),
    [ride.route_geometry, ride.segments],
  );
  const bounds = useMemo(
    () => rideBounds(ride.route_geometry),
    [ride.route_geometry],
  );

  const histogram = useMemo(
    () => segmentQualityHistogram(ride.segments),
    [ride.segments],
  );

  const leanHistogram = useMemo(
    () => leanHistogramRows(ride.lean_distribution),
    [ride.lean_distribution],
  );
  const leanTotal = useMemo(
    () => leanSampleTotal(ride.lean_distribution),
    [ride.lean_distribution],
  );

  // #M5: advanced_ride_stats is display-gating, not an action block — the
  // backend already nulls elevation/lean fields for a non-entitled rider
  // (SP1), so we never fetch anything extra here. `statsLocked` covers both
  // the resolved-and-disabled case AND the not-yet-resolved case (fail
  // closed): until the snapshot loads we must not flash the real values,
  // even though they'd be null anyway for a Free rider. One shared prompt
  // backs every locked tile below instead of one modal per tile.
  const { enabled: statsEnabled, isResolved: statsResolved } = useFeature(
    "advanced_ride_stats",
  );
  const { tier } = useEntitlements();
  const translate = useTranslation();
  // `statsStale` keeps the tiles locked after an unlock until the refetch lands
  // fresh data — otherwise the stripped nulls from the pre-unlock payload would
  // render as dashes under now-unlocked tiles.
  const statsLocked = !(statsResolved && statsEnabled) || statsStale;
  // No higher tier grants advanced_ride_stats (already top tier, or an operator
  // force-off on a Pro/Premium rider) → the teaser/modal must not tell the
  // rider to upgrade, since that can't restore access.
  const statsHasUpgrade =
    upgradeTierForFeature("advanced_ride_stats", tier ?? "free") !== null;
  const [statsUpgradeVisible, setStatsUpgradeVisible] = useState(false);
  // Only offer the upsell once the snapshot has actually RESOLVED. During
  // bootstrap (a cached profile with no `features` slice) the tiles lock
  // defensively so the real values never flash — but the tier is unknown, so
  // an entitled rider tapping a teaser then would get a FALSE "upgrade" / "not
  // available" prompt derived from the stale cached tier. Keep the values
  // hidden, but make the teaser action inert until the entitlement lands.
  const openStatsUpgrade = useCallback(() => {
    if (statsResolved) setStatsUpgradeVisible(true);
  }, [statsResolved]);
  // A locked tile means one of two things, and taps must do the right one:
  //   - genuinely not entitled → open the upgrade prompt.
  //   - entitled but the unlock refetch failed (`statsStale`) → RETRY the
  //     refetch, never an upsell (the rider already has the feature).
  const onLockedPress = statsStale ? onStatsRetry : openStatsUpgrade;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <RouteMap featureCollection={featureCollection} bounds={bounds} />
      <SummaryCard ride={ride} />
      <StatsGrid
        ride={ride}
        locked={statsLocked}
        lockedStale={statsStale}
        lockedHasUpgrade={statsHasUpgrade}
        onLockedPress={onLockedPress}
      />
      <LeanBreakdownCard
        rows={leanHistogram}
        total={leanTotal}
        maxLeanAngle={ride.max_lean_angle}
        locked={statsLocked}
        lockedStale={statsStale}
        lockedHasUpgrade={statsHasUpgrade}
        onLockedPress={onLockedPress}
      />
      <SegmentBreakdownCard segments={ride.segments} histogram={histogram} />
      <ShareActions ride={ride} />
      <UpgradePrompt
        visible={statsUpgradeVisible}
        capability={{ feature: "advanced_ride_stats" }}
        currentTier={tier ?? "free"}
        message={translate("Advanced stats are a Pro feature.")}
        neutralMessage={translate(
          "Advanced stats aren't available on your current plan.",
        )}
        onClose={() => setStatsUpgradeVisible(false)}
      />
    </ScrollView>
  );
}

function RouteMap({
  featureCollection,
  bounds,
}: {
  featureCollection: GeoJSON.FeatureCollection;
  bounds: {
    sw: { lat: number; lng: number };
    ne: { lat: number; lng: number };
  } | null;
}) {
  const translate = useTranslation();
  if (!bounds) {
    return (
      <View style={styles.mapPlaceholder}>
        <Icon name="map-marker-off-outline" size={32} color={t.dim} />
        <Text style={styles.mapPlaceholderText}>
          {translate("No route recorded")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.mapWrap}>
      <Map
        style={styles.map}
        mapStyle={APP_MAP_STYLE_URL}
        attribution={false}
        logo={false}
      >
        <Camera
          // LngLatBounds is [west, south, east, north].
          bounds={[bounds.sw.lng, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat]}
          padding={{ top: 32, right: 32, bottom: 32, left: 32 }}
        />
        <GeoJSONSource id="ride-route" data={featureCollection}>
          <Layer
            type="line"
            id="ride-route-line"
            source="ride-route"
            paint={{
              "line-width": 5,
              // Step expression mirrors the shared `qualityColor` buckets
              // — see `rideRouteLineColorExpression` for the full mapping.
              "line-color": rideRouteLineColorExpression(),
            }}
            layout={{
              "line-cap": "round",
              "line-join": "round",
            }}
          />
        </GeoJSONSource>
      </Map>
    </View>
  );
}

function SummaryCard({ ride }: { ride: RideDetail }) {
  const translate = useTranslation();
  const qScore = ride.avg_road_quality ?? 0;
  const qHas = qScore > 0;
  // Quality value stays ink: the ramp is a fill colour and fails AA as text
  // on the white card. The quality colour vocabulary is carried visually by
  // the segment histogram bars below. A small swatch keeps the at-a-glance
  // colour cue without colouring the (AA-critical) label text.
  return (
    <View style={styles.card}>
      <Text style={styles.cardDate}>{formatRideDate(ride.started_at)}</Text>
      <View style={styles.summaryRow}>
        <RideMetric
          label={translate("Distance")}
          value={formatDistanceKm(ride.distance_km)}
          size="lg"
        />
        <RideMetric
          label={translate("Duration")}
          value={formatDurationMinutes(ride.duration_min)}
          size="lg"
        />
        <View style={styles.qualityMetric}>
          <RideMetric
            label={translate("Quality")}
            value={qHas ? qualityLabel(qScore) : "—"}
            size="lg"
          />
          {qHas ? (
            <View
              style={[
                styles.qualitySwatch,
                { backgroundColor: qualityBrandColor(qScore) },
              ]}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function StatsGrid({
  ride,
  locked,
  lockedStale,
  lockedHasUpgrade,
  onLockedPress,
}: {
  ride: RideDetail;
  /** #M5: advanced_ride_stats gate — locks Ascent/Descent/Max lean only. */
  locked: boolean;
  /** Locked because the unlock refetch hasn't delivered fresh data (entitled) —
   *  the tile is a retry affordance, not an upsell. */
  lockedStale: boolean;
  /** Whether an upgrade can restore access — false = neutral (no-upgrade) copy. */
  lockedHasUpgrade: boolean;
  onLockedPress: () => void;
}) {
  const translate = useTranslation();
  return (
    <View style={styles.statsCard}>
      <Text style={styles.sectionTitle}>{translate("Stats")}</Text>
      <View style={styles.statsGrid}>
        <StatTile
          icon="speedometer"
          label={translate("Avg speed")}
          value={formatSpeedKmh(ride.avg_speed)}
        />
        <StatTile
          icon="speedometer-medium"
          label={translate("Top speed")}
          value={formatSpeedKmh(ride.max_speed)}
        />
        {locked ? (
          <LockedStatTile
            label={translate("Ascent")}
            stale={lockedStale}
            hasUpgrade={lockedHasUpgrade}
            onPress={onLockedPress}
          />
        ) : (
          <StatTile
            icon="arrow-up-bold"
            label={translate("Ascent")}
            value={formatElevation(ride.elevation_gain, "+")}
          />
        )}
        {locked ? (
          <LockedStatTile
            label={translate("Descent")}
            stale={lockedStale}
            hasUpgrade={lockedHasUpgrade}
            onPress={onLockedPress}
          />
        ) : (
          <StatTile
            icon="arrow-down-bold"
            label={translate("Descent")}
            value={formatElevation(ride.elevation_loss, "-")}
          />
        )}
        <StatTile
          icon="reload"
          label={translate("Curves")}
          value={formatCurveCount(ride.curve_count)}
        />
        {locked ? (
          <LockedStatTile
            label={translate("Max lean")}
            stale={lockedStale}
            hasUpgrade={lockedHasUpgrade}
            onPress={onLockedPress}
          />
        ) : (
          <StatTile
            icon="motorbike"
            label={translate("Max lean")}
            value={formatLeanAngle(ride.max_lean_angle)}
          />
        )}
        <StatTile
          icon="gas-station"
          label={translate("Fuel")}
          value={formatFuelLiters(ride.fuel_estimate_l)}
        />
      </View>
    </View>
  );
}

function LeanBreakdownCard({
  rows,
  total,
  maxLeanAngle,
  locked,
  lockedStale,
  lockedHasUpgrade,
  onLockedPress,
}: {
  rows: LeanHistogramRow[];
  total: number;
  maxLeanAngle: number | null;
  /** #M5: advanced_ride_stats gate. Checked before the empty-state below —
   *  a locked, non-entitled rider always sees the teaser, regardless of
   *  what `total` (computed from the already-nulled `lean_distribution`)
   *  would otherwise imply. */
  locked: boolean;
  /** Locked because the entitled rider's unlock refetch hasn't landed yet —
   *  a retry affordance, not an upsell. */
  lockedStale: boolean;
  /** False when no upgrade can restore access → neutral (no-upgrade) copy. */
  lockedHasUpgrade: boolean;
  onLockedPress: () => void;
}) {
  const translate = useTranslation();
  if (locked) {
    const cardLabel = translate("Lean breakdown");
    const accessibilityLabel = lockedStale
      ? translate("{value0} — couldn't refresh. Tap to retry.", {
          value0: cardLabel,
        })
      : lockedHasUpgrade
        ? translate("{value0} — Pro stat. Tap to upgrade.", {
            value0: cardLabel,
          })
        : translate("{value0} — Pro stat.", { value0: cardLabel });
    const hint = lockedStale
      ? translate("Couldn't refresh advanced stats. Tap to retry.")
      : lockedHasUpgrade
        ? translate("Advanced stats are a Pro feature.")
        : translate("Advanced stats aren't available on your current plan.");
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={onLockedPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>{cardLabel}</Text>
          <Icon
            name={lockedStale ? "reload" : "lock-outline"}
            size={18}
            color={t.dim}
          />
        </View>
        <Text style={styles.emptyHint}>{hint}</Text>
      </TouchableOpacity>
    );
  }
  // No samples yet — collapse the card down to a single hint line.
  // Riders pre-US-19 (or with a quiet sensor / never-calibrated phone)
  // shouldn't see a histogram of all zeros, which would imply the
  // rider rode dead-flat the whole ride.
  if (total === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{translate("Lean breakdown")}</Text>
        <Text style={styles.emptyHint}>
          {translate(
            "We didn't capture lean data on this ride. Calibrate during your next ride to see the breakdown.",
          )}
        </Text>
      </View>
    );
  }
  const maxRatio = Math.max(0.01, ...rows.map((r) => r.ratio));
  const maxLeanLabel = formatLeanAngle(maxLeanAngle ?? 0);
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{translate("Lean breakdown")}</Text>
        <Text style={styles.sectionMeta}>
          {translate("Max {angle}", { angle: maxLeanLabel })}
        </Text>
      </View>
      {rows.map((row) => (
        <LeanHistogramRowView
          key={row.bucket.id}
          row={row}
          maxRatio={maxRatio}
        />
      ))}
    </View>
  );
}

function LeanHistogramRowView({
  row,
  maxRatio,
}: {
  row: LeanHistogramRow;
  maxRatio: number;
}) {
  const format = useFormat();
  const translate = useTranslation();
  const widthPct = `${Math.max(row.ratio * (100 / maxRatio), row.count > 0 ? 6 : 0)}%`;
  const percentLabel = format.percent(row.ratio);
  return (
    <View
      style={styles.histRow}
      accessibilityLabel={translate("{value0}: {value1}", {
        value0: row.bucket.label,
        value1: percentLabel,
      })}
    >
      <Text style={styles.histLabel}>{row.bucket.label}</Text>
      <View style={styles.histBarTrack}>
        <View
          style={[
            styles.histBarFill,
            row.count > 0 ? styles.histBarFillEdge : null,
            {
              width: widthPct as `${number}%`,
              // ACCENT_DARK clears 3:1 on the cream `sunken` track (the raw
              // accent does not — same rationale as the offline progress bar).
              backgroundColor: ACCENT_DARK,
            },
          ]}
        />
      </View>
      <Text style={styles.histCount}>{percentLabel}</Text>
    </View>
  );
}

function SegmentBreakdownCard({
  segments,
  histogram,
}: {
  segments: RideSegment[];
  histogram: Array<{ bucket: 1 | 2 | 3 | 4 | 5; count: number }>;
}) {
  const translate = useTranslation();
  if (segments.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{translate("Segments")}</Text>
        <Text style={styles.emptyHint}>
          {translate("No road segments were snapped on this ride yet.")}
        </Text>
      </View>
    );
  }
  const max = Math.max(1, ...histogram.map((h) => h.count));
  // Sum the histogram bars rather than `segments.length` so the meta
  // line agrees with the visualisation. `segmentQualityHistogram`
  // drops `quality_reading <= 0` and non-finite rows (the polyline
  // and SummaryCard treat them as "no data"); using the raw count
  // here would claim more segments than the bars sum to and
  // contradict the same card's bars.
  const counted = histogram.reduce((acc, h) => acc + h.count, 0);
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{translate("Segment quality")}</Text>
        <Text style={styles.sectionMeta}>
          {translate("{count, plural, one {# segment} other {# segments}}", {
            count: counted,
          })}
        </Text>
      </View>
      {histogram.map((row) => (
        <HistogramRow
          key={row.bucket}
          bucket={row.bucket}
          count={row.count}
          max={max}
        />
      ))}
    </View>
  );
}

function HistogramRow({
  bucket,
  count,
  max,
}: {
  bucket: 1 | 2 | 3 | 4 | 5;
  count: number;
  max: number;
}) {
  const format = useFormat();
  const translate = useTranslation();
  const ratio = max > 0 ? count / max : 0;
  // The Q1–Q5 ramp is the brand's essential quality encoding (rule #4), so
  // it stays as the bar fill even on the light card (WCAG 1.4.11 "essential"
  // graphic). The row label + count carry the same info as AA-safe ink text,
  // so quality is never conveyed by colour alone.
  const color = qualityBrandColor(bucket);
  const label = qualityLabel(bucket);
  return (
    <View
      style={styles.histRow}
      accessibilityLabel={translate("{value0}: {value1}", {
        value0: label,
        value1: count,
      })}
    >
      <Text style={styles.histLabel}>{label}</Text>
      <View style={styles.histBarTrack}>
        <View
          style={[
            styles.histBarFill,
            count > 0 ? styles.histBarFillEdge : null,
            {
              width: `${Math.max(ratio * 100, count > 0 ? 6 : 0)}%`,
              backgroundColor: color,
            },
          ]}
        />
      </View>
      <Text style={styles.histCount}>{format.integer(count)}</Text>
    </View>
  );
}

function ShareActions({ ride }: { ride: RideDetail }) {
  const translate = useTranslation();
  const [busy, setBusy] = useState<"share" | "gpx" | null>(null);
  const { enabled: gpxEnabled, isResolved: gpxResolved } =
    useFeature("gpx_export");
  const { tier } = useEntitlements();
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const handleShare = useCallback(async () => {
    if (busy !== null) return;
    setBusy("share");
    try {
      await Share.share({
        message: buildRideShareMessage(ride),
        title: translate("Tarmoto ride"),
      });
    } catch (err) {
      Alert.alert(
        translate("Couldn't share"),
        getUserFacingErrorMessage(
          err,
          translate("Unable to open share sheet."),
        ),
      );
    } finally {
      setBusy(null);
    }
  }, [busy, ride, translate]);

  const handleExportGpx = useCallback(async () => {
    if (busy !== null) return;
    // Proactive gate: once the entitlement snapshot is resolved (rider is
    // logged in), a non-entitled rider gets the upgrade prompt instead of
    // a doomed request. While unresolved the control is disabled below, so
    // this branch only fires for a resolved, non-entitled rider.
    if (gpxResolved && !gpxEnabled) {
      setUpgradeVisible(true);
      return;
    }
    setBusy("gpx");
    // Write the GPX bytes to a temp file and hand that to the system
    // share sheet as an attachment. Sharing the XML through the
    // built-in `Share.share({ message })` path looks the same to the
    // rider but is delivered as plain text — Garmin / Komoot / any
    // GPX importer reject it because they expect a file payload.
    const filename = `tarmoto-ride-${ride.id}.gpx`;
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${filename}`.replace(
      /\/{2,}/g,
      "/",
    );
    try {
      const xml = await api.exportRideGpx(ride.id);
      await RNFS.writeFile(tempPath, xml, "utf8");
      await RNShare.open({
        url: Platform.OS === "android" ? `file://${tempPath}` : tempPath,
        type: "application/gpx+xml",
        filename,
        title: translate("Export ride as GPX"),
        // failOnCancel=false so the rider dismissing the sheet doesn't
        // bubble up as an error toast.
        failOnCancel: false,
      });
    } catch (err) {
      // Safety net for a stale client-side entitlement snapshot: the
      // endpoint is server-enforced, so a non-entitled rider can still
      // reach here (e.g. a downgrade mid-session) and gets a 403 with no
      // `code` (feature-guard body, not the `FEATURE_LIMIT_EXCEEDED`
      // limit shape) — show the same upgrade prompt instead of a generic
      // error toast.
      if (err instanceof ApiError && err.status === 403) {
        setUpgradeVisible(true);
      } else {
        Alert.alert(
          translate("Couldn't export"),
          getUserFacingErrorMessage(err, translate("Unable to export GPX.")),
        );
      }
    } finally {
      // Don't delete the file here. `RNShare.open` resolves the moment
      // the sheet is dismissed, but several share targets read the
      // payload lazily (Mail / iMessage stage it on a background queue,
      // Files prompts the rider for a destination, third-party importers
      // open a preview before committing). Eagerly unlinking would
      // silently corrupt those flows. Per-app temp files in
      // `TemporaryDirectoryPath` are reaped by the OS anyway, so a
      // stale `.gpx` left behind is harmless.
      setBusy(null);
    }
  }, [busy, ride, gpxEnabled, gpxResolved, translate]);

  return (
    <View style={styles.actionsRow}>
      <TouchableOpacity
        style={styles.actionBtn}
        onPress={() => void handleShare()}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel={translate("Share ride")}
      >
        <Icon name="share-variant" size={18} color={t.invFg} />
        <Text style={styles.actionLabel}>
          {busy === "share" ? translate("Sharing…") : translate("Share")}
        </Text>
      </TouchableOpacity>
      {/* GPX export is owner-only: the backend's export query requires
          `ride.user_id === userId`, so a non-owner viewing a shared ride
          would only ever get "Ride not found". Offering a free viewer the
          upgrade prompt here would be misleading (upgrading still can't
          export someone else's ride), so hide the action entirely. */}
      {ride.viewer_is_owner ? (
        <>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => void handleExportGpx()}
            disabled={busy !== null || !gpxResolved}
            accessibilityRole="button"
            accessibilityLabel={translate("Export ride as GPX")}
          >
            <Icon name="download-outline" size={18} color={t.invFg} />
            <Text style={styles.actionLabel}>
              {busy === "gpx"
                ? translate("Exporting…")
                : translate("Export GPX")}
            </Text>
          </TouchableOpacity>
          <UpgradePrompt
            visible={upgradeVisible}
            capability={{ feature: "gpx_export" }}
            currentTier={tier ?? "free"}
            message={translate("GPX export is a Pro feature.")}
            onClose={() => setUpgradeVisible(false)}
          />
        </>
      ) : null}
    </View>
  );
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.statTile}>
      <Icon name={icon} size={18} color={t.fg} />
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={styles.statTileValue}>{value}</Text>
    </View>
  );
}

// #M5: locked teaser variant of `StatTile`. Two locked reasons, distinct
// affordances:
//   - not entitled (or snapshot unresolved — fail closed): a "Pro" teaser whose
//     tap opens the shared `UpgradePrompt`.
//   - `stale` (entitled, but the unlock refetch hasn't delivered fresh data —
//     e.g. it failed): a "Retry" affordance whose tap re-runs the refetch. An
//     entitled rider must never be told to upgrade for a feature they have.
function LockedStatTile({
  label,
  stale,
  hasUpgrade,
  onPress,
}: {
  label: string;
  /** Locked because the entitled rider's unlock refetch hasn't landed yet. */
  stale: boolean;
  /** False when no upgrade can restore access → drop the "Tap to upgrade" cue. */
  hasUpgrade: boolean;
  onPress: () => void;
}) {
  const translate = useTranslation();
  const accessibilityLabel = stale
    ? translate("{value0} — couldn't refresh. Tap to retry.", { value0: label })
    : hasUpgrade
      ? translate("{value0} — Pro stat. Tap to upgrade.", { value0: label })
      : translate("{value0} — Pro stat.", { value0: label });
  return (
    <TouchableOpacity
      style={styles.statTile}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Icon name={stale ? "reload" : "lock-outline"} size={18} color={t.dim} />
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={styles.statTileValue}>
        {stale ? translate("Retry") : translate("Pro")}
      </Text>
    </TouchableOpacity>
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
    paddingBottom: brandSpacing.s12,
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
  },
  errorBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    marginTop: brandSpacing.s3,
  },
  primaryBtn: {
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
  secondaryBtn: {
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  secondaryBtnLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  mapWrap: {
    height: 240,
    borderRadius: brandRadii.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
  },
  map: {
    flex: 1,
  },
  mapPlaceholder: {
    height: 160,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
  },
  mapPlaceholderText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  statsCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  cardDate: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  summaryRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  qualityMetric: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: brandSpacing.s2,
  },
  qualitySwatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
    marginTop: 22,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
  },
  statTile: {
    width: "31%",
    flexGrow: 1,
    minWidth: 96,
    padding: brandSpacing.s3,
    backgroundColor: t.raised2,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    gap: 4,
  },
  statTileLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statTileValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  emptyHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  histRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  histLabel: {
    width: 80,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  histBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: t.sunken,
    overflow: "hidden",
  },
  histBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  // Hairline edge so a pale quality-ramp fill (Q3–Q5) is still perceivable
  // as a bar against the cream track — the fill colour alone can be near the
  // track's luminance. Applied only to non-empty bars so a 0%-width fill
  // doesn't draw a stray border sliver next to a "0" count.
  histBarFillEdge: {
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  histCount: {
    width: 32,
    textAlign: "right",
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 13,
    fontWeight: "700",
  },
  actionsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 48,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  actionLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
