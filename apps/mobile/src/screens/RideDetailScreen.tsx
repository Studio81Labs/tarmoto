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
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
} from "@maplibre/maplibre-react-native";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityColor,
  qualityLabel,
  shadows,
  spacing,
} from "@/theme";
import { api } from "@/services/api";
import type { RideDetail, RideSegment } from "@/types";
import type {
  HomeStackParamList,
  RideStackParamList,
} from "@/navigation/RootNavigator";
import RideMetric from "@/components/RideMetric";
import { DEV_MAP_STYLE_URL } from "./MapScreen.helpers";
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
  rideBounds,
  rideRouteFeatureCollection,
  rideRouteLineColorExpression,
  segmentQualityHistogram,
} from "./RideScreens.helpers";

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

export default function RideDetailScreen() {
  const { params } = useRoute<DetailRoute>();
  const navigation = useNavigation<DetailNav>();
  const rideId = params?.rideId;

  const [ride, setRide] = useState<RideDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Single ref-based cancellation token shared by the mount fetch and
  // every Retry. Each new fetch flips the previous token's `cancelled`
  // flag so an in-flight request can't call `setRide` / `setPhase`
  // after the screen unmounts (or after the rider has triggered a
  // newer retry). The mount effect's cleanup also flips it, covering
  // the unmount path.
  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const fetchRide = useCallback(async () => {
    if (!rideId) {
      setPhase("error");
      setErrorMessage("Missing ride id");
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
    } catch (err) {
      if (signal.cancelled) return;
      setPhase("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Couldn't load ride",
      );
    }
  }, [rideId]);

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

  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (phase === "error" || !ride) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={colors.danger} />
        <Text style={styles.errorTitle}>Couldn't load ride</Text>
        {errorMessage ? (
          <Text style={styles.errorBody}>{errorMessage}</Text>
        ) : null}
        <View style={styles.errorActions}>
          <TouchableOpacity style={styles.primaryBtn} onPress={retry}>
            <Text style={styles.primaryBtnLabel}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.secondaryBtnLabel}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return <RideDetailBody ride={ride} />;
}

function RideDetailBody({ ride }: { ride: RideDetail }) {
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <RouteMap featureCollection={featureCollection} bounds={bounds} />
      <SummaryCard ride={ride} />
      <StatsGrid ride={ride} />
      <SegmentBreakdownCard segments={ride.segments} histogram={histogram} />
      <ShareActions ride={ride} />
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
  if (!bounds) {
    return (
      <View style={styles.mapPlaceholder}>
        <Icon
          name="map-marker-off-outline"
          size={32}
          color={colors.textTertiary}
        />
        <Text style={styles.mapPlaceholderText}>No route recorded</Text>
      </View>
    );
  }
  return (
    <View style={styles.mapWrap}>
      <Map
        style={styles.map}
        mapStyle={DEV_MAP_STYLE_URL}
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
            style={{
              lineWidth: 5,
              lineCap: "round",
              lineJoin: "round",
              // Step expression mirrors the shared `qualityColor` buckets
              // — see `rideRouteLineColorExpression` for the full mapping.
              lineColor: rideRouteLineColorExpression() as unknown as string,
            }}
          />
        </GeoJSONSource>
      </Map>
    </View>
  );
}

function SummaryCard({ ride }: { ride: RideDetail }) {
  const qScore = ride.avg_road_quality ?? 0;
  const qHas = qScore > 0;
  const qColor = qHas ? qualityColor(qScore) : colors.textTertiary;
  return (
    <View style={styles.card}>
      <Text style={styles.cardDate}>{formatRideDate(ride.started_at)}</Text>
      <View style={styles.summaryRow}>
        <RideMetric
          label="Distance"
          value={formatDistanceKm(ride.distance_km)}
          size="lg"
        />
        <RideMetric
          label="Duration"
          value={formatDurationMinutes(ride.duration_min)}
          size="lg"
        />
        <RideMetric
          label="Quality"
          value={qHas ? qualityLabel(qScore) : "—"}
          valueColor={qColor}
          size="lg"
        />
      </View>
    </View>
  );
}

function StatsGrid({ ride }: { ride: RideDetail }) {
  return (
    <View style={styles.statsCard}>
      <Text style={styles.sectionTitle}>Stats</Text>
      <View style={styles.statsGrid}>
        <StatTile
          icon="speedometer"
          label="Avg speed"
          value={formatSpeedKmh(ride.avg_speed)}
        />
        <StatTile
          icon="speedometer-medium"
          label="Top speed"
          value={formatSpeedKmh(ride.max_speed)}
        />
        <StatTile
          icon="arrow-up-bold"
          label="Ascent"
          value={formatElevation(ride.elevation_gain, "+")}
        />
        <StatTile
          icon="arrow-down-bold"
          label="Descent"
          value={formatElevation(ride.elevation_loss, "-")}
        />
        <StatTile
          icon="reload"
          label="Curves"
          value={formatCurveCount(ride.curve_count)}
        />
        <StatTile
          icon="motorbike"
          label="Max lean"
          value={formatLeanAngle(ride.max_lean_angle)}
        />
        <StatTile
          icon="gas-station"
          label="Fuel"
          value={formatFuelLiters(ride.fuel_estimate_l)}
        />
      </View>
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
  if (segments.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Segments</Text>
        <Text style={styles.emptyHint}>
          No road segments were snapped on this ride yet.
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
        <Text style={styles.sectionTitle}>Segment quality</Text>
        <Text style={styles.sectionMeta}>
          {counted} segment{counted === 1 ? "" : "s"}
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
  const ratio = max > 0 ? count / max : 0;
  const color = qualityColor(bucket);
  const label = qualityLabel(bucket);
  return (
    <View style={styles.histRow} accessibilityLabel={`${label}: ${count}`}>
      <Text style={[styles.histLabel, { color }]}>{label}</Text>
      <View style={styles.histBarTrack}>
        <View
          style={[
            styles.histBarFill,
            {
              width: `${Math.max(ratio * 100, count > 0 ? 6 : 0)}%`,
              backgroundColor: color,
            },
          ]}
        />
      </View>
      <Text style={styles.histCount}>{count}</Text>
    </View>
  );
}

function ShareActions({ ride }: { ride: RideDetail }) {
  const [busy, setBusy] = useState<"share" | "gpx" | null>(null);

  const handleShare = useCallback(async () => {
    if (busy !== null) return;
    setBusy("share");
    try {
      await Share.share({
        message: buildRideShareMessage(ride),
        title: "Tarmoto ride",
      });
    } catch (err) {
      Alert.alert(
        "Couldn't share",
        err instanceof Error ? err.message : "Unable to open share sheet.",
      );
    } finally {
      setBusy(null);
    }
  }, [busy, ride]);

  const handleExportGpx = useCallback(async () => {
    if (busy !== null) return;
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
        title: "Export ride as GPX",
        // failOnCancel=false so the rider dismissing the sheet doesn't
        // bubble up as an error toast.
        failOnCancel: false,
      });
    } catch (err) {
      Alert.alert(
        "Couldn't export",
        err instanceof Error ? err.message : "Unable to export GPX.",
      );
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
  }, [busy, ride]);

  return (
    <View style={styles.actionsRow}>
      <TouchableOpacity
        style={styles.actionBtn}
        onPress={() => void handleShare()}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel="Share ride"
      >
        <Icon name="share-variant" size={18} color={colors.primary} />
        <Text style={styles.actionLabel}>
          {busy === "share" ? "Sharing…" : "Share"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.actionBtn}
        onPress={() => void handleExportGpx()}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel="Export ride as GPX"
      >
        <Icon name="download-outline" size={18} color={colors.primary} />
        <Text style={styles.actionLabel}>
          {busy === "gpx" ? "Exporting…" : "Export GPX"}
        </Text>
      </TouchableOpacity>
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
      <Icon name={icon} size={18} color={colors.primary} />
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={styles.statTileValue}>{value}</Text>
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
    paddingBottom: spacing.section,
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
  },
  errorBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  primaryBtn: {
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
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnLabel: {
    color: colors.textPrimary,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  mapWrap: {
    height: 240,
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  map: {
    flex: 1,
  },
  mapPlaceholder: {
    height: 160,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  mapPlaceholderText: {
    color: colors.textTertiary,
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
  statsCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardDate: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  summaryRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  statTile: {
    width: "31%",
    flexGrow: 1,
    minWidth: 96,
    padding: spacing.md,
    backgroundColor: colors.bgSurface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  statTileLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statTileValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  emptyHint: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  histRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  histLabel: {
    width: 80,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  histBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.bgSurface,
    overflow: "hidden",
  },
  histBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  histCount: {
    width: 32,
    textAlign: "right",
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.bgCard,
    ...shadows.card,
  },
  actionLabel: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
