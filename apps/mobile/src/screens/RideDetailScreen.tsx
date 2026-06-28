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
  leanHistogramRows,
  leanSampleTotal,
  rideBounds,
  rideRouteFeatureCollection,
  rideRouteLineColorExpression,
  segmentQualityHistogram,
  type LeanHistogramRow,
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

const t = brandColorsLight;

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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (phase === "error" || !ride) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={statusFg.danger} />
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

  const leanHistogram = useMemo(
    () => leanHistogramRows(ride.lean_distribution),
    [ride.lean_distribution],
  );
  const leanTotal = useMemo(
    () => leanSampleTotal(ride.lean_distribution),
    [ride.lean_distribution],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <RouteMap featureCollection={featureCollection} bounds={bounds} />
      <SummaryCard ride={ride} />
      <StatsGrid ride={ride} />
      <LeanBreakdownCard
        rows={leanHistogram}
        total={leanTotal}
        maxLeanAngle={ride.max_lean_angle}
      />
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
        <Icon name="map-marker-off-outline" size={32} color={t.dim} />
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
  // Quality value stays ink: the ramp is a fill colour and fails AA as text
  // on the white card. The quality colour vocabulary is carried visually by
  // the segment histogram bars below. A small swatch keeps the at-a-glance
  // colour cue without colouring the (AA-critical) label text.
  return (
    <View style={styles.card}>
      <Text style={styles.cardDate}>{formatRideDate(ride.started_at)}</Text>
      <View style={styles.summaryRow}>
        <RideMetric
          label="Distance"
          value={formatDistanceKm(ride.distance_km)}
          size="lg"
          light
        />
        <RideMetric
          label="Duration"
          value={formatDurationMinutes(ride.duration_min)}
          size="lg"
          light
        />
        <View style={styles.qualityMetric}>
          <RideMetric
            label="Quality"
            value={qHas ? qualityLabel(qScore) : "—"}
            size="lg"
            light
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

function LeanBreakdownCard({
  rows,
  total,
  maxLeanAngle,
}: {
  rows: LeanHistogramRow[];
  total: number;
  maxLeanAngle: number | null;
}) {
  // No samples yet — collapse the card down to a single hint line.
  // Riders pre-US-19 (or with a quiet sensor / never-calibrated phone)
  // shouldn't see a histogram of all zeros, which would imply the
  // rider rode dead-flat the whole ride.
  if (total === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Lean breakdown</Text>
        <Text style={styles.emptyHint}>
          We didn't capture lean data on this ride. Calibrate during your next
          ride to see the breakdown.
        </Text>
      </View>
    );
  }
  const maxRatio = Math.max(0.01, ...rows.map((r) => r.ratio));
  const maxLeanLabel = formatLeanAngle(maxLeanAngle ?? 0);
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Lean breakdown</Text>
        <Text style={styles.sectionMeta}>Max {maxLeanLabel}</Text>
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
  const widthPct = `${Math.max(row.ratio * (100 / maxRatio), row.count > 0 ? 6 : 0)}%`;
  const percentLabel = `${Math.round(row.ratio * 100)}%`;
  return (
    <View
      style={styles.histRow}
      accessibilityLabel={`${row.bucket.label}: ${percentLabel}`}
    >
      <Text style={styles.histLabel}>{row.bucket.label}</Text>
      <View style={styles.histBarTrack}>
        <View
          style={[
            styles.histBarFill,
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
  // The Q1–Q5 ramp is the brand's essential quality encoding (rule #4), so
  // it stays as the bar fill even on the light card (WCAG 1.4.11 "essential"
  // graphic). The row label + count carry the same info as AA-safe ink text,
  // so quality is never conveyed by colour alone.
  const color = qualityBrandColor(bucket);
  const label = qualityLabel(bucket);
  return (
    <View style={styles.histRow} accessibilityLabel={`${label}: ${count}`}>
      <Text style={styles.histLabel}>{label}</Text>
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
        <Icon name="share-variant" size={18} color={t.invFg} />
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
        <Icon name="download-outline" size={18} color={t.invFg} />
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
      <Icon name={icon} size={18} color={t.fg} />
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={styles.statTileValue}>{value}</Text>
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
    // Hairline edge so a pale quality-ramp fill (Q3–Q5) is still perceivable
    // as a bar against the cream track — the fill colour alone can be near
    // the track's luminance.
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
