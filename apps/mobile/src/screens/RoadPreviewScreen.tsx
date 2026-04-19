import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useRoute } from "@react-navigation/native";
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  hazardIcons,
  meetsQualityThreshold,
  qualityColorWithThreshold,
  qualityLabel,
  spacing,
} from "@/theme";
import { api } from "@/services/api";
import { usePreferencesStore } from "@/stores";
import type { Hazard, RoadReview, RoadSegmentDetail } from "@/types";
import {
  computeCurveCount,
  curvinessLabel,
  formatHazardType,
  formatLengthKm,
  formatRelativeTime,
  formatSurface,
  normalizeBreakdown,
} from "./RoadPreviewScreen.helpers";

type RoadPreviewRoute = RouteProp<
  { RoadPreview: { segmentId: string } },
  "RoadPreview"
>;
type IconName = ComponentProps<typeof Icon>["name"];

const QUALITY_BUCKETS: Array<{
  key: keyof RoadSegmentDetail["quality_breakdown"];
  label: string;
  color: string;
}> = [
  { key: "excellent", label: "Excellent", color: colors.quality.excellent },
  { key: "good", label: "Good", color: colors.quality.good },
  { key: "fair", label: "Fair", color: colors.quality.fair },
  { key: "poor", label: "Poor", color: colors.quality.poor },
  { key: "very_poor", label: "Very Poor", color: colors.quality.veryPoor },
];

export default function RoadPreviewScreen() {
  const { params } = useRoute<RoadPreviewRoute>();
  const segmentId = params?.segmentId;
  const minQuality = usePreferencesStore((s) => s.minQuality);

  const [segment, setSegment] = useState<RoadSegmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!segmentId) {
      setError("Missing segment id");
      setLoading(false);
      return;
    }
    // Guard against a late response from an older segmentId overwriting
    // the current screen state if the route changes mid-flight.
    let ignore = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await api.getRoadSegment(segmentId);
        if (!ignore) setSegment(data);
      } catch (e) {
        if (!ignore) {
          setError(
            e instanceof Error ? e.message : "Failed to load road segment",
          );
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [segmentId, retryKey]);

  const refresh = useCallback(async () => {
    if (!segmentId) return;
    setRefreshing(true);
    try {
      const data = await api.getRoadSegment(segmentId);
      setSegment(data);
    } catch {
      // Swallow — `segment` still holds the last good data, so keep
      // showing it rather than blowing the whole screen away into the
      // error state. The user can pull to refresh again.
    } finally {
      setRefreshing(false);
    }
  }, [segmentId]);

  const retry = useCallback(() => setRetryKey((k) => k + 1), []);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !segment) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={colors.danger} />
        <Text style={styles.errorTitle}>Unable to load road preview</Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
        <TouchableOpacity style={styles.retryButton} onPress={retry}>
          <Text style={styles.retryLabel}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
    >
      <HeaderCard segment={segment} minQuality={minQuality} />
      <QualityCard segment={segment} minQuality={minQuality} />
      <CurvinessCard segment={segment} />
      <ElevationCard segment={segment} />
      <HazardsCard hazards={segment.active_hazards} />
      <ReviewsCard
        reviews={segment.recent_reviews}
        avgRating={segment.avg_review_rating}
      />
    </ScrollView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function HeaderCard({
  segment,
  minQuality,
}: {
  segment: RoadSegmentDetail;
  minQuality: number;
}) {
  const title = segment.road_name || segment.road_number || "Unnamed road";
  const subtitle = [
    segment.road_number && segment.road_name ? segment.road_number : null,
    formatLengthKm(segment.length_m),
  ]
    .filter(Boolean)
    .join(" · ");
  const belowThreshold = !meetsQualityThreshold(
    segment.quality_score,
    minQuality,
  );
  return (
    <View
      style={[
        styles.card,
        styles.headerCard,
        belowThreshold && styles.headerCardDimmed,
      ]}
    >
      {belowThreshold ? (
        <View style={styles.thresholdBadge}>
          <Icon name="eye-off-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.thresholdBadgeLabel}>
            Below your minimum ({qualityLabel(minQuality)})
          </Text>
        </View>
      ) : null}
      <Text style={styles.headerTitle} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      <View style={styles.metaRow}>
        <MetaPill
          icon="account-multiple"
          label={`${segment.reading_count} passes`}
        />
        <MetaPill
          icon="calendar-clock"
          label={formatRelativeTime(segment.last_updated)}
        />
        <MetaPill
          icon="shield-check"
          label={`${Math.round(segment.confidence * 100)}% confidence`}
        />
      </View>
    </View>
  );
}

function QualityCard({
  segment,
  minQuality,
}: {
  segment: RoadSegmentDetail;
  minQuality: number;
}) {
  const color = qualityColorWithThreshold(segment.quality_score, minQuality);
  const belowThreshold = !meetsQualityThreshold(
    segment.quality_score,
    minQuality,
  );
  return (
    <View style={styles.card}>
      <SectionTitle icon="road-variant" title="Surface quality" />
      <View style={styles.qualityHeader}>
        <View>
          <Text style={[styles.qualityScore, { color }]}>
            {segment.quality_score.toFixed(1)}
          </Text>
          <Text style={styles.qualitySubtitle}>
            {qualityLabel(segment.quality_score)} ·{" "}
            {formatSurface(segment.surface_type)}
          </Text>
        </View>
        <View style={styles.qualityScoreMax}>
          <Text style={styles.qualityScoreMaxText}>/ 5.0</Text>
        </View>
      </View>
      {belowThreshold ? (
        <Text style={styles.thresholdHint}>
          Your filter is set to {qualityLabel(minQuality)} and above — this road
          falls below it.
        </Text>
      ) : null}
      <QualityBreakdownBar breakdown={segment.quality_breakdown} />
    </View>
  );
}

function QualityBreakdownBar({
  breakdown,
}: {
  breakdown: RoadSegmentDetail["quality_breakdown"];
}) {
  const segments = normalizeBreakdown(
    QUALITY_BUCKETS.map((b) => b.key),
    breakdown,
  );

  if (segments.length === 0) {
    return <Text style={styles.emptyInline}>No breakdown data yet.</Text>;
  }

  const bucketByKey = new Map(QUALITY_BUCKETS.map((b) => [b.key, b]));

  return (
    <View>
      <View style={styles.breakdownBar}>
        {segments.map((s) => {
          const bucket = bucketByKey.get(s.key);
          if (!bucket) return null;
          return (
            <View
              key={s.key}
              style={{ flex: s.pct, backgroundColor: bucket.color }}
            />
          );
        })}
      </View>
      <View style={styles.breakdownLegend}>
        {segments.map((s) => {
          const bucket = bucketByKey.get(s.key);
          if (!bucket) return null;
          return (
            <View key={s.key} style={styles.legendItem}>
              <View
                style={[styles.legendDot, { backgroundColor: bucket.color }]}
              />
              <Text style={styles.legendLabel}>
                {bucket.label} {Math.round(s.pct * 100)}%
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function CurvinessCard({ segment }: { segment: RoadSegmentDetail }) {
  const { curviness_score } = segment;
  const filled = Math.round(Math.max(0, Math.min(5, curviness_score)));
  // US-9 AC: "Curviness score + curve count". Backend doesn't expose a
  // count on road segments, so derive it geometrically — stable, cheap,
  // and good enough to give riders a rough sense of "how many bends".
  const curveCount = useMemo(
    () => computeCurveCount(segment.geometry),
    [segment.geometry],
  );
  return (
    <View style={styles.card}>
      <SectionTitle
        icon="sine-wave"
        title="Curviness"
        rightLabel={
          curveCount > 0
            ? `${curveCount} ${curveCount === 1 ? "turn" : "turns"}`
            : undefined
        }
      />
      <View style={styles.curvinessRow}>
        <Text style={styles.curvinessScore}>{curviness_score.toFixed(1)}</Text>
        <View style={styles.curvinessPips}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Icon
              key={i}
              name={i < filled ? "sine-wave" : "minus"}
              size={20}
              color={i < filled ? colors.primary : colors.textTertiary}
            />
          ))}
        </View>
      </View>
      <Text style={styles.curvinessHint}>
        {curvinessLabel(curviness_score)}
      </Text>
    </View>
  );
}

function ElevationCard({ segment }: { segment: RoadSegmentDetail }) {
  const { elevation_min, elevation_max } = segment;
  const range = Math.max(0, elevation_max - elevation_min);
  return (
    <View style={styles.card}>
      <SectionTitle icon="terrain" title="Elevation" />
      <View style={styles.elevationRow}>
        <ElevationStat label="Min" value={`${Math.round(elevation_min)} m`} />
        <ElevationStat label="Max" value={`${Math.round(elevation_max)} m`} />
        <ElevationStat label="Range" value={`${Math.round(range)} m`} />
      </View>
    </View>
  );
}

function HazardsCard({ hazards }: { hazards: Hazard[] }) {
  return (
    <View style={styles.card}>
      <SectionTitle
        icon="alert"
        title="Active hazards"
        rightLabel={hazards.length ? `${hazards.length}` : undefined}
      />
      {hazards.length === 0 ? (
        <Text style={styles.empty}>No active hazards reported.</Text>
      ) : (
        hazards.map((h) => <HazardRow key={h.id} hazard={h} />)
      )}
    </View>
  );
}

function HazardRow({ hazard }: { hazard: Hazard }) {
  const icon = (hazardIcons[hazard.hazard_type] || "alert-circle") as IconName;
  return (
    <View style={styles.hazardRow}>
      <View
        style={[
          styles.hazardIconWrap,
          { backgroundColor: severityBg(hazard.severity) },
        ]}
      >
        <Icon name={icon} size={18} color={severityFg(hazard.severity)} />
      </View>
      <View style={styles.hazardBody}>
        <Text style={styles.hazardTitle}>
          {formatHazardType(hazard.hazard_type)}
        </Text>
        {hazard.note ? (
          <Text style={styles.hazardNote} numberOfLines={2}>
            {hazard.note}
          </Text>
        ) : null}
        <Text style={styles.hazardMeta}>
          {hazard.confirmations} confirmations ·{" "}
          {formatRelativeTime(hazard.created_at)}
        </Text>
      </View>
    </View>
  );
}

function ReviewsCard({
  reviews,
  avgRating,
}: {
  reviews: RoadReview[];
  avgRating: number;
}) {
  return (
    <View style={styles.card}>
      <SectionTitle
        icon="star-outline"
        title="Recent reviews"
        rightLabel={reviews.length ? `${avgRating.toFixed(1)} ★` : undefined}
      />
      {reviews.length === 0 ? (
        <Text style={styles.empty}>
          No reviews yet — be the first to review this road.
        </Text>
      ) : (
        reviews.map((r) => <ReviewRow key={r.id} review={r} />)
      )}
    </View>
  );
}

function ReviewRow({ review }: { review: RoadReview }) {
  return (
    <View style={styles.reviewRow}>
      <View style={styles.reviewHeader}>
        <Text style={styles.reviewAuthor}>{review.user_display_name}</Text>
        <Text style={styles.reviewRating}>
          {"★".repeat(Math.max(0, Math.min(5, Math.round(review.rating))))}
        </Text>
      </View>
      {review.comment ? (
        <Text style={styles.reviewComment}>{review.comment}</Text>
      ) : null}
      <View style={styles.reviewFooter}>
        {review.bike_model ? (
          <View style={styles.reviewMetaRow}>
            <Icon name="motorbike" size={12} color={colors.textTertiary} />
            <Text style={styles.reviewMeta}>{review.bike_model}</Text>
          </View>
        ) : null}
        <Text style={styles.reviewMeta}>
          {formatRelativeTime(review.created_at)}
        </Text>
      </View>
    </View>
  );
}

// ── Primitives ─────────────────────────────────────────────────────────────

function SectionTitle({
  icon,
  title,
  rightLabel,
}: {
  icon: IconName;
  title: string;
  rightLabel?: string;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Icon name={icon} size={16} color={colors.textSecondary} />
      <Text style={styles.sectionTitle}>{title}</Text>
      {rightLabel ? (
        <Text style={styles.sectionRight}>{rightLabel}</Text>
      ) : null}
    </View>
  );
}

function MetaPill({ icon, label }: { icon: IconName; label: string }) {
  return (
    <View style={styles.metaPill}>
      <Icon name={icon} size={12} color={colors.textSecondary} />
      <Text style={styles.metaPillLabel}>{label}</Text>
    </View>
  );
}

function ElevationStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.elevationStat}>
      <Text style={styles.elevationValue}>{value}</Text>
      <Text style={styles.elevationLabel}>{label}</Text>
    </View>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function severityBg(severity: Hazard["severity"]): string {
  if (severity === "high") return colors.qualityAlpha.veryPoor;
  if (severity === "medium") return colors.qualityAlpha.poor;
  return colors.qualityAlpha.fair;
}

function severityFg(severity: Hazard["severity"]): string {
  if (severity === "high") return colors.quality.veryPoor;
  if (severity === "medium") return colors.quality.poor;
  return colors.quality.fair;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  errorTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
  },
  errorBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  retryButton: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
  },
  retryLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },

  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  headerCard: {
    gap: spacing.sm,
  },
  headerCardDimmed: {
    opacity: 0.7,
    borderColor: colors.borderLight,
  },
  thresholdBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgElevated,
  },
  thresholdBadgeLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  thresholdHint: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontStyle: "italic",
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  headerSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.bgElevated,
    borderRadius: borderRadius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  metaPillLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },

  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    flex: 1,
  },
  sectionRight: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },

  qualityHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  qualityScore: {
    fontSize: fontSize.hero,
    fontWeight: fontWeight.black,
  },
  qualitySubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  qualityScoreMax: {
    paddingBottom: spacing.sm,
  },
  qualityScoreMaxText: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },

  breakdownBar: {
    flexDirection: "row",
    height: 10,
    borderRadius: borderRadius.sm,
    overflow: "hidden",
    backgroundColor: colors.bgElevated,
  },
  breakdownLegend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },

  curvinessRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  curvinessScore: {
    color: colors.textPrimary,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.black,
  },
  curvinessPips: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  curvinessHint: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },

  elevationRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  elevationStat: {
    alignItems: "center",
    flex: 1,
  },
  elevationValue: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  elevationLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },

  hazardRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  hazardIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  hazardBody: {
    flex: 1,
    gap: 2,
  },
  hazardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  hazardNote: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  hazardMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },

  reviewRow: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  reviewHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  reviewAuthor: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  reviewRating: {
    color: colors.warning,
    fontSize: fontSize.sm,
    letterSpacing: 1,
  },
  reviewComment: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  reviewFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  reviewMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  reviewMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },

  empty: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontStyle: "italic",
  },
  emptyInline: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontStyle: "italic",
  },
});
