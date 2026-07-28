import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "@/components/Icon";
import Svg, { Path } from "react-native-svg";
import {
  hazardIcons,
  meetsQualityThreshold,
  qualityLabel,
  qualityProvenanceLabel,
} from "@/theme";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  QUALITY_COLORS,
  statusFg,
  UNSCORED_COLOR,
} from "@/theme/brand";
import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { useAuthStore, usePreferencesStore } from "@/stores";
import { HAZARD_TYPE_LABELS } from "@/constants/hazards";
import type { RootTabParamList } from "@/navigation/RootNavigator";
import type { Hazard, RoadReview, RoadSegmentDetail } from "@/types";
import ReviewFormModal, {
  type ReviewFormSubmitResult,
} from "@/components/ReviewFormModal";
import {
  applyVoteDelta,
  buildElevationChartPaths,
  computeCurveCount,
  computeElevationStats,
  curvinessLabel,
  formatLengthKm,
  formatRelativeTime,
  isFlatElevationProfile,
  normalizeBreakdown,
} from "./RoadPreviewScreen.helpers";
import { surfaceLabel } from "./RideScreens.helpers";
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";

const ELEVATION_CHART_HEIGHT = 80;
const REVIEW_PHOTO_SIZE = 84;

const t = brandColorsLight;
// Interactive text (links, action-chip labels) uses the deepened accent: the
// raw accent fails AA as text on the white card, ACCENT_DARK clears ~5.2:1.
const INTERACTIVE = ACCENT_DARK;

type RoadPreviewRoute = RouteProp<
  { RoadPreview: { segmentId: string } },
  "RoadPreview"
>;
type IconName = ComponentProps<typeof Icon>["name"];

const QUALITY_BUCKETS: Array<{
  key: keyof RoadSegmentDetail["quality_breakdown"];
  label: EnglishMessageKey;
  color: string;
}> = [
  // Brand Q1–Q5 ramp (visual fills on the breakdown bar + legend dots; the
  // colour is redundant with each labelled %). Excellent = Q5 … Very poor = Q1.
  { key: "excellent", label: "Excellent", color: QUALITY_COLORS[4] },
  { key: "good", label: "Good", color: QUALITY_COLORS[3] },
  { key: "fair", label: "Fair", color: QUALITY_COLORS[2] },
  { key: "poor", label: "Poor", color: QUALITY_COLORS[1] },
  { key: "very_poor", label: "Very Poor", color: QUALITY_COLORS[0] },
];

export default function RoadPreviewScreen() {
  const translate = useTranslation();
  const { params } = useRoute<RoadPreviewRoute>();
  const segmentId = params?.segmentId;
  const minQuality = usePreferencesStore((s) => s.minQuality);
  // `hazard_alerts` operator kill switch (reactive) — the road preview shows
  // community hazards for the segment, so hide them when an operator kills
  // reception during an alert-spam / false-positive storm, mirroring the map /
  // CarPlay / commute gates. Fail SAFE (shown unless force_off).
  const hazardAlertsEnabled = useFeatureKillSwitchActive("hazard_alerts");

  const [segment, setSegment] = useState<RoadSegmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!segmentId) {
      setError(translate("Missing segment id"));
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
            getUserFacingErrorMessage(
              e,
              translate("Failed to load road segment"),
            ),
          );
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [segmentId, retryKey, translate]);

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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (error || !segment) {
    return (
      <View style={styles.centered}>
        <Icon name="alert-circle-outline" size={48} color={statusFg.danger} />
        <Text style={styles.errorTitle}>
          {translate("Unable to load road preview")}
        </Text>
        {error ? <Text style={styles.errorBody}>{error}</Text> : null}
        <TouchableOpacity style={styles.retryButton} onPress={retry}>
          <Text style={styles.retryLabel}>{translate("Try again")}</Text>
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
          tintColor={t.fg}
          colors={[t.fg]}
        />
      }
    >
      <HeaderCard segment={segment} minQuality={minQuality} />
      <QualityCard segment={segment} minQuality={minQuality} />
      <CurvinessCard segment={segment} />
      <ElevationCard segment={segment} />
      {hazardAlertsEnabled ? (
        <HazardsCard
          hazards={segment.active_hazards}
          totalCount={segment.active_hazard_count}
        />
      ) : null}
      <ReviewsCard
        segmentId={segmentId!}
        reviews={segment.recent_reviews}
        avgRating={segment.avg_review_rating}
        onSegmentChanged={refresh}
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
  const format = useFormat();
  const translate = useTranslation();
  const title =
    segment.road_name || segment.road_number || translate("Unnamed road");
  const subtitle = [
    segment.road_number && segment.road_name ? segment.road_number : null,
    formatLengthKm(segment.length_m),
  ]
    .filter(Boolean)
    .join(" · ");
  // Only flag "below your minimum" when there's an actual score to
  // compare against. An unscored segment (no rides have enriched it
  // yet) is not "below the threshold" — it has no threshold-relevant
  // signal at all, so the badge would be misleading.
  const belowThreshold =
    segment.quality_score != null &&
    !meetsQualityThreshold(segment.quality_score, minQuality);
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
          <Icon name="eye-off-outline" size={12} color={t.dim} />
          <Text style={styles.thresholdBadgeLabel}>
            {translate("Below your minimum ({quality})", {
              quality: qualityLabel(minQuality),
            })}
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
          label={translate("{count, plural, one {# pass} other {# passes}}", {
            count: segment.reading_count,
          })}
        />
        <MetaPill
          icon="calendar-clock"
          label={formatRelativeTime(segment.last_updated)}
        />
        <MetaPill
          icon="shield-check"
          label={translate("{value0} confidence", {
            value0: format.percent(segment.confidence / 100),
          })}
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
  const format = useFormat();
  const translate = useTranslation();
  // Only flag "below your minimum" when there's an actual score; see
  // `RoadHeaderCard` for the rationale (unscored ≠ below threshold).
  const belowThreshold =
    segment.quality_score != null &&
    !meetsQualityThreshold(segment.quality_score, minQuality);
  return (
    <View style={styles.card}>
      <SectionTitle icon="road-variant" title={translate("Surface quality")} />
      <View style={styles.qualityHeader}>
        <View>
          {/* The headline score stays ink (the ramp fails AA as text on the
              white card); the quality vocabulary lives in the breakdown bar
              below + the label text. */}
          <Text style={styles.qualityScore}>
            {segment.quality_score != null
              ? format.decimal(segment.quality_score, 1)
              : "—"}
          </Text>
          <Text style={styles.qualitySubtitle}>
            {translate("{quality} · {surface}", {
              quality: qualityLabel(segment.quality_score),
              surface: surfaceLabel(segment.surface_type),
            })}
          </Text>
          {qualityProvenanceLabel(
            segment.quality_source,
            segment.reading_count,
          ) ? (
            <Text style={styles.qualityEstimate}>
              {qualityProvenanceLabel(
                segment.quality_source,
                segment.reading_count,
              )}
            </Text>
          ) : null}
        </View>
        <View style={styles.qualityScoreMax}>
          <Text style={styles.qualityScoreMaxText}>
            {translate("/ {max}", { max: format.decimal(5, 1) })}
          </Text>
        </View>
      </View>
      {belowThreshold ? (
        <Text style={styles.thresholdHint}>
          {translate(
            "Your filter is set to {quality} and above — this road falls below it.",
            { quality: qualityLabel(minQuality) },
          )}
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
  const format = useFormat();
  const translate = useTranslation();
  const segments = normalizeBreakdown(
    QUALITY_BUCKETS.map((b) => b.key),
    breakdown,
  );

  if (segments.length === 0) {
    return (
      <Text style={styles.emptyInline}>
        {translate("No breakdown data yet.")}
      </Text>
    );
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
                {translate("{label} {percent}", {
                  label: translate(bucket.label),
                  percent: format.percent(s.pct),
                })}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function CurvinessCard({ segment }: { segment: RoadSegmentDetail }) {
  const format = useFormat();
  const translate = useTranslation();
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
        title={translate("Curviness")}
        rightLabel={
          curveCount > 0
            ? translate("{count, plural, one {# turn} other {# turns}}", {
                count: curveCount,
              })
            : undefined
        }
      />
      <View style={styles.curvinessRow}>
        <Text style={styles.curvinessScore}>
          {format.decimal(curviness_score, 1)}
        </Text>
        <View style={styles.curvinessPips}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Icon
              key={i}
              name={i < filled ? "sine-wave" : "minus"}
              size={20}
              color={i < filled ? t.fg : t.faint}
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
  const format = useFormat();
  const translate = useTranslation();
  const { elevation_min, elevation_max, elevation_profile } = segment;
  // Show "—" instead of "0 m" when the segment has no elevation data so the
  // card doesn't claim a sea-level reading we never actually measured.
  const hasMin = elevation_min !== null && Number.isFinite(elevation_min);
  const hasMax = elevation_max !== null && Number.isFinite(elevation_max);
  const range =
    hasMin && hasMax ? Math.max(0, elevation_max! - elevation_min!) : null;

  const stats = useMemo(
    () => (elevation_profile ? computeElevationStats(elevation_profile) : null),
    [elevation_profile],
  );
  // Only label a profile "flat" when it has enough finite samples to be
  // renderable AND they're all equal. Single-sample or NaN-heavy inputs
  // would leave the chart empty anyway — we skip the block entirely rather
  // than mislabeling insufficient data as a level road.
  const isFlatProfile = useMemo(
    () =>
      elevation_profile !== null && isFlatElevationProfile(elevation_profile),
    [elevation_profile],
  );

  return (
    <View style={styles.card}>
      <SectionTitle
        icon="terrain"
        title={translate("Elevation")}
        rightLabel={
          stats && (stats.ascent > 0 || stats.descent > 0)
            ? `↑${format.elevation(stats.ascent)}  ↓${format.elevation(stats.descent)}`
            : undefined
        }
      />
      {elevation_profile && !isFlatProfile ? (
        <ElevationProfileChart profile={elevation_profile} />
      ) : null}
      {isFlatProfile ? (
        <Text style={styles.emptyInline}>{translate("Flat profile.")}</Text>
      ) : null}
      <View style={styles.elevationRow}>
        <ElevationStat
          label={translate("Min")}
          value={hasMin ? format.elevation(elevation_min!) : "—"}
        />
        <ElevationStat
          label={translate("Max")}
          value={hasMax ? format.elevation(elevation_max!) : "—"}
        />
        <ElevationStat
          label={translate("Range")}
          value={range !== null ? format.elevation(range) : "—"}
        />
      </View>
    </View>
  );
}

function ElevationProfileChart({ profile }: { profile: number[] }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const paths = useMemo(
    () => buildElevationChartPaths(profile, width, ELEVATION_CHART_HEIGHT),
    [profile, width],
  );

  // Once we know the layout width, only render the sized container when we
  // actually have a path to draw — otherwise an unrenderable profile (flat
  // or too few finite samples) would leave a fixed-height empty box behind.
  if (width > 0 && !paths) return null;

  return (
    <View onLayout={onLayout} style={styles.elevationChartWrap}>
      {paths ? (
        <Svg
          width={width}
          height={ELEVATION_CHART_HEIGHT}
          // Disable accessibility focus on the SVG itself; the SectionTitle
          // already announces ascent/descent which is the actionable info.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Path d={paths.area} fill="rgba(194,65,12,0.10)" />
          <Path
            d={paths.line}
            stroke={ACCENT_DARK}
            strokeWidth={2}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}

function HazardsCard({
  hazards,
  totalCount,
}: {
  hazards: Hazard[];
  totalCount: number;
}) {
  const format = useFormat();
  const translate = useTranslation();
  // The array is capped server-side at ACTIVE_HAZARD_LIMIT; show the full
  // count in the badge so a segment with 30 reports doesn't misleadingly
  // render "10". Fall back to the array length if the DTO is missing the
  // count (older cached response shape).
  const badgeCount = totalCount > 0 ? totalCount : hazards.length;
  const truncated = totalCount > hazards.length;
  return (
    <View style={styles.card}>
      <SectionTitle
        icon="alert"
        title={translate("Active hazards")}
        rightLabel={badgeCount ? format.integer(badgeCount) : undefined}
      />
      {badgeCount === 0 ? (
        <Text style={styles.empty}>
          {translate("No active hazards reported.")}
        </Text>
      ) : (
        <>
          {hazards.map((h) => (
            <HazardRow key={h.id} hazard={h} />
          ))}
          {truncated ? (
            <Text style={styles.emptyInline}>
              {translate("Showing the {shown} most recent of {total}.", {
                shown: hazards.length,
                total: totalCount,
              })}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function HazardRow({ hazard }: { hazard: Hazard }) {
  const translate = useTranslation();
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
          {translate(HAZARD_TYPE_LABELS[hazard.hazard_type])}
        </Text>
        {hazard.note ? (
          <Text style={styles.hazardNote} numberOfLines={2}>
            {hazard.note}
          </Text>
        ) : null}
        <Text style={styles.hazardMeta}>
          {translate(
            "{count, plural, one {# confirmation} other {# confirmations}} · {time}",
            {
              count: hazard.confirmations,
              time: formatRelativeTime(hazard.created_at),
            },
          )}
        </Text>
      </View>
    </View>
  );
}

function ReviewsCard({
  segmentId,
  reviews: embeddedReviews,
  avgRating,
  onSegmentChanged,
}: {
  segmentId: string;
  reviews: RoadReview[];
  avgRating: number | null;
  /** Refetch the parent segment after a successful create/update/delete. */
  onSegmentChanged: () => Promise<void> | void;
}) {
  const format = useFormat();
  const translate = useTranslation();
  // Local mirror so helpful-vote taps can update the row immediately
  // without waiting for a full segment refetch. Seeded from the
  // embedded `recent_reviews` array on first mount / segment change,
  // then immediately replaced by the personalised /roads/:id/reviews
  // fetch so `is_mine` / `my_vote` are accurate (the /roads/:id
  // endpoint is anonymous-friendly and always reports both as
  // null/false).
  const [reviews, setReviews] = useState<RoadReview[]>(embeddedReviews);
  const [myReview, setMyReview] = useState<RoadReview | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  // Tracks the segmentId that was current at fetch start. Used by
  // `refreshReviews` to discard a late response from segment A after
  // navigation has switched to B — without this guard, the late A
  // response would overwrite B's `reviews`/`myReview` and surface the
  // wrong ownership state on the new road.
  const currentSegmentRef = useRef(segmentId);
  useEffect(() => {
    currentSegmentRef.current = segmentId;
  }, [segmentId]);

  // Hold a ref to the latest embeddedReviews so `refreshReviews`'s
  // failure-fallback can read the current value without invalidating
  // the callback (and re-firing every effect that depends on it) on
  // every parent render.
  const embeddedReviewsRef = useRef(embeddedReviews);
  useEffect(() => {
    embeddedReviewsRef.current = embeddedReviews;
  }, [embeddedReviews]);

  const refreshReviews = useCallback(async () => {
    const fetchedSegmentId = segmentId;
    try {
      const personalised = await api.getReviews(fetchedSegmentId);
      if (currentSegmentRef.current !== fetchedSegmentId) return;
      setReviews(personalised);
      const own = personalised.find((r) => r.is_mine) ?? null;
      setMyReview(own);
    } catch {
      // Personalised fetch failed (network blip, server error). Fall
      // back to the latest embedded list so newly created or deleted
      // reviews fetched by the parent (pull-to-refresh /
      // onSegmentChanged) still surface — without this, the local
      // mirror would stay pinned to the previous personalised
      // snapshot until the next successful refetch. Also drop
      // `myReview`: we can't confirm ownership from the embedded
      // list (every entry has `is_mine: false`), and a stale
      // `myReview` would surface "Edit your review" while none of
      // the rendered rows offered an Edit affordance — and tapping
      // the button would open the form with potentially
      // out-of-date data (e.g. the rider deleted from another
      // session). Better to hide the affordance until a successful
      // refetch confirms ownership again.
      if (currentSegmentRef.current !== fetchedSegmentId) return;
      setReviews(embeddedReviewsRef.current);
      setMyReview(null);
    }
  }, [segmentId]);

  // Reset my-review state on segment change. `embeddedReviews` is
  // intentionally NOT in the deps: pull-to-refresh on the same
  // segment updates the prop ref but we don't want to clear
  // `myReview` / `statusBanner`.
  useEffect(() => {
    setReviews(embeddedReviews);
    setMyReview(null);
    setStatusBanner(null);
  }, [segmentId]);

  // Refetch personalised reviews on mount, segment change (via the
  // `refreshReviews` dep churn), AND when the parent's
  // `embeddedReviews` ref changes (pull-to-refresh on the same
  // segment). Without the embeddedReviews dep, newly-added rows from
  // other riders fetched by pull-to-refresh wouldn't show up until
  // navigation. We refetch personalised rather than blindly seeding
  // from the embedded (anonymous-friendly) list so `is_mine` /
  // `my_vote` stay accurate.
  useEffect(() => {
    void refreshReviews();
  }, [refreshReviews, embeddedReviews]);

  // Drain any reviews queued offline on a previous session. Without
  // this, a single review queued by a rider who never writes a second
  // one could sit in MMKV indefinitely — `submitReviewWithQueue` only
  // drains the backlog as part of the next submit attempt. The drain
  // is scoped to the current user id so a queued payload from a
  // previous account on this device doesn't get uploaded under the
  // new session.
  //
  // After a successful flush we trigger the parent's segment refetch
  // so the freshly-uploaded reviews show up in `embeddedReviews` and
  // the personalised effect picks up the new `is_mine` rows. Without
  // this follow-up, the rider's just-flushed-on-mount review stays
  // invisible until they pull-to-refresh or navigate away.
  const currentUserId = useAuthStore((s) => s.user?.id);
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.flushPendingReviews(currentUserId);
        if (cancelled) return;
        if (result.flushed > 0) {
          // Refetch the parent segment; the embedded-effect then
          // runs `refreshReviews()` once to land personalised state.
          await onSegmentChanged();
        }
      } catch {
        // Drain failures stay queued for next time; nothing to surface.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUserId, onSegmentChanged]);

  const handleVoteChange = useCallback(
    (reviewId: string, next: Partial<RoadReview>) => {
      setReviews((prev) =>
        prev.map((r) => (r.id === reviewId ? { ...r, ...next } : r)),
      );
    },
    [],
  );

  // Submit / delete / conflict handlers all rely on the parent's
  // `onSegmentChanged()` to drive the personalised refetch — when
  // the segment refetch resolves and `embeddedReviews` updates, the
  // `[refreshReviews, embeddedReviews]` effect above runs
  // `refreshReviews()` exactly once. Calling it explicitly here too
  // would double the API hit for every write (the explicit fetch
  // races with the parent setState; the embedded-driven fetch fires
  // once the parent's state propagates regardless).
  const handleSubmitted = useCallback(
    async (result: ReviewFormSubmitResult) => {
      setFormVisible(false);
      setStatusBanner(
        result.status === "queued"
          ? translate(
              "You're offline — your review is saved locally and will upload when you reconnect.",
            )
          : null,
      );
      await onSegmentChanged();
    },
    [onSegmentChanged, translate],
  );

  const handleDeleted = useCallback(async () => {
    setFormVisible(false);
    // Optimistically clear my-review so the Edit affordance hides
    // before the parent refetch lands. The effect-driven refresh
    // confirms (or restores) ownership state once the segment
    // refetch propagates.
    setMyReview(null);
    setStatusBanner(null);
    await onSegmentChanged();
  }, [onSegmentChanged]);

  const handleConflict = useCallback(async (): Promise<boolean> => {
    // 409 — server already has a review from this rider on this
    // segment. We explicitly fetch personalised reviews here (NOT
    // via `onSegmentChanged`, which silently swallows fetch errors)
    // so the form can know whether the existing review actually
    // landed in `myReview` before it commits to the
    // "loaded for editing" banner. The boolean return is the form's
    // signal: true → switch to edit mode, false → fall back to a
    // create-mode error.
    const fetchedSegmentId = segmentId;
    let own: RoadReview | null;
    try {
      const personalised = await api.getReviews(fetchedSegmentId);
      if (currentSegmentRef.current !== fetchedSegmentId) return false;
      setReviews(personalised);
      own = personalised.find((r) => r.is_mine) ?? null;
      setMyReview(own);
    } catch {
      // Personalised fetch failed; the form will surface its own
      // error and stay in create mode.
      return false;
    }
    // Best-effort segment refetch in parallel so the embedded list
    // (other riders' newly-added reviews) catches up too. Errors
    // here don't change the form's outcome — the boolean below
    // captures whether the rider's own review was loaded.
    void onSegmentChanged();
    return own !== null;
  }, [onSegmentChanged, segmentId]);

  const openForm = useCallback(() => setFormVisible(true), []);

  const showAvg = reviews.length > 0 && avgRating !== null;
  return (
    <View style={styles.card}>
      <SectionTitle
        icon="star-outline"
        title={translate("Recent reviews")}
        rightLabel={showAvg ? `${format.decimal(avgRating!, 1)} ★` : undefined}
      />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={
          myReview
            ? translate("Edit your review")
            : translate("Write a review for this road")
        }
        style={styles.writeReviewButton}
        onPress={openForm}
      >
        <Icon
          name={myReview ? "pencil-outline" : "comment-edit-outline"}
          size={16}
          color={INTERACTIVE}
        />
        <Text style={styles.writeReviewLabel}>
          {myReview
            ? translate("Edit your review")
            : translate("Write a review")}
        </Text>
      </TouchableOpacity>
      {statusBanner ? (
        <Text style={styles.statusBanner}>{statusBanner}</Text>
      ) : null}
      {reviews.length === 0 ? (
        <Text style={styles.empty}>
          {translate("No reviews yet — be the first to review this road.")}
        </Text>
      ) : (
        reviews.map((r) => (
          <ReviewRow
            key={r.id}
            review={r}
            onVoteChange={handleVoteChange}
            onEditOwn={r.is_mine ? openForm : undefined}
          />
        ))
      )}
      <ReviewFormModal
        visible={formVisible}
        segmentId={segmentId}
        initialReview={myReview}
        onClose={() => setFormVisible(false)}
        onSubmitted={handleSubmitted}
        onDeleted={handleDeleted}
        onConflict={handleConflict}
      />
    </View>
  );
}

function ReviewRow({
  review,
  onVoteChange,
  onEditOwn,
}: {
  review: RoadReview;
  onVoteChange: (reviewId: string, next: Partial<RoadReview>) => void;
  /** Defined only when this row is the viewer's own review. */
  onEditOwn?: (() => void) | undefined;
}) {
  const translate = useTranslation();
  const photos = Array.isArray(review.photos) ? review.photos : [];
  // US-27 follow-up (#335): tapping a reviewer name opens their profile
  // in the Profile tab. RoadPreview lives in HomeStack, so we cross-tab
  // navigate to keep the Profile back-stack clean. user_id is null for
  // soft-deleted authors — fall back to plain text in that case.
  const rootNav = useNavigation<NativeStackNavigationProp<RootTabParamList>>();
  const profileUserId = review.is_mine ? null : review.user_id;
  const openProfile =
    profileUserId == null
      ? null
      : () =>
          rootNav.navigate("ProfileTab", {
            screen: "ViewProfile",
            params: { userId: profileUserId },
          });
  return (
    <View style={styles.reviewRow}>
      <View style={styles.reviewHeader}>
        <View style={styles.reviewAuthorRow}>
          {openProfile ? (
            <TouchableOpacity
              onPress={openProfile}
              accessibilityRole="button"
              accessibilityLabel={translate("Open {value0}'s profile", {
                value0: review.user_display_name,
              })}
            >
              <Text style={styles.reviewAuthorLink}>
                {review.user_display_name}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.reviewAuthor}>{review.user_display_name}</Text>
          )}
          {review.is_mine ? (
            <View style={styles.reviewMineBadge}>
              <Text style={styles.reviewMineBadgeLabel}>
                {translate("You")}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.reviewRating}>
          {reviewRatingStars(review.rating)}
        </Text>
      </View>
      {review.comment ? (
        <Text style={styles.reviewComment}>{review.comment}</Text>
      ) : null}
      {photos.length > 0 ? <ReviewPhotos photos={photos} /> : null}
      <View style={styles.reviewFooter}>
        {review.bike_model ? (
          <View style={styles.reviewMetaRow}>
            <Icon name="motorbike" size={12} color={t.dim} />
            <Text style={styles.reviewMeta}>{review.bike_model}</Text>
          </View>
        ) : null}
        <Text style={styles.reviewMeta}>
          {formatRelativeTime(review.created_at)}
        </Text>
      </View>
      {onEditOwn ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={translate("Edit or delete your review")}
          style={styles.reviewEditButton}
          onPress={onEditOwn}
        >
          <Icon name="pencil-outline" size={14} color={INTERACTIVE} />
          <Text style={styles.reviewEditLabel}>
            {translate("Edit / delete")}
          </Text>
        </TouchableOpacity>
      ) : (
        <ReviewHelpfulRow review={review} onVoteChange={onVoteChange} />
      )}
    </View>
  );
}

function reviewRatingStars(rating: number): string {
  return "★".repeat(Math.max(0, Math.min(5, Math.round(rating))));
}

/**
 * Helpful / not-helpful controls (US-55). Updates optimistically on tap
 * and reconciles against the server response so the thumb count matches
 * what the next reader will see. Tapping the current vote direction
 * again clears it — matching the YouTube / Reddit pattern riders expect.
 */
function ReviewHelpfulRow({
  review,
  onVoteChange,
}: {
  review: RoadReview;
  onVoteChange: (reviewId: string, next: Partial<RoadReview>) => void;
}) {
  const format = useFormat();
  const translate = useTranslation();
  const [pending, setPending] = useState(false);

  const vote = useCallback(
    async (isHelpful: boolean) => {
      if (pending) return;
      const wasSame = review.my_vote === isHelpful;
      setPending(true);

      // Optimistic update: adjust counts locally assuming the call
      // succeeds. If it fails we roll back to the previous values.
      const prevSnapshot: Partial<RoadReview> = {
        helpful_count: review.helpful_count,
        not_helpful_count: review.not_helpful_count,
        my_vote: review.my_vote,
      };
      const optimistic = applyVoteDelta(review, wasSame ? null : isHelpful);
      onVoteChange(review.id, optimistic);

      try {
        const result = wasSame
          ? await api.clearReviewVote(review.id)
          : await api.voteOnReview(review.id, isHelpful);
        onVoteChange(review.id, {
          helpful_count: result.helpful_count,
          not_helpful_count: result.not_helpful_count,
          my_vote: result.my_vote,
        });
      } catch {
        onVoteChange(review.id, prevSnapshot);
      } finally {
        setPending(false);
      }
    },
    [review, onVoteChange, pending],
  );

  const helpfulActive = review.my_vote === true;
  const notHelpfulActive = review.my_vote === false;

  return (
    <View style={styles.reviewHelpfulRow}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={
          helpfulActive
            ? translate("Remove helpful vote")
            : translate("Mark this review as helpful")
        }
        accessibilityState={{ selected: helpfulActive, busy: pending }}
        style={[
          styles.reviewHelpfulButton,
          helpfulActive && styles.reviewHelpfulButtonActive,
        ]}
        onPress={() => vote(true)}
        disabled={pending}
      >
        <Icon
          name={helpfulActive ? "thumb-up" : "thumb-up-outline"}
          size={14}
          color={helpfulActive ? t.fg : t.dim}
        />
        <Text
          style={[
            styles.reviewHelpfulCount,
            helpfulActive && styles.reviewHelpfulCountActive,
          ]}
        >
          {format.integer(review.helpful_count)}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={
          notHelpfulActive
            ? translate("Remove not-helpful vote")
            : translate("Mark this review as not helpful")
        }
        accessibilityState={{ selected: notHelpfulActive, busy: pending }}
        style={[
          styles.reviewHelpfulButton,
          notHelpfulActive && styles.reviewHelpfulButtonActive,
        ]}
        onPress={() => vote(false)}
        disabled={pending}
      >
        <Icon
          name={notHelpfulActive ? "thumb-down" : "thumb-down-outline"}
          size={14}
          color={notHelpfulActive ? statusFg.danger : t.dim}
        />
        <Text
          style={[
            styles.reviewHelpfulCount,
            notHelpfulActive && styles.reviewHelpfulCountActive,
          ]}
        >
          {format.integer(review.not_helpful_count)}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function ReviewPhotos({ photos }: { photos: string[] }) {
  const translate = useTranslation();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.reviewPhotosRow}
      // Allow scrolling photos without fighting the parent vertical scroll;
      // RN handles the gesture handoff but we hint it explicitly here.
      directionalLockEnabled
      accessibilityLabel={translate(
        "{count, plural, one {# review photo} other {# review photos}}",
        { count: photos.length },
      )}
    >
      {photos.map((uri, idx) => (
        <Image
          key={`${uri}-${idx}`}
          source={{ uri }}
          style={styles.reviewPhoto}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ))}
    </ScrollView>
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
  rightLabel?: string | undefined;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Icon name={icon} size={16} color={t.dim} />
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
      <Icon name={icon} size={12} color={t.dim} />
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

// Hazard-severity icon tint (AA-safe status tones) + a low-alpha wash of the
// same tone for the icon disc. Low severity has no brand "info" colour, so it
// reads as neutral ink.
function severityBg(severity: Hazard["severity"]): string {
  if (severity === "high") return "rgba(179,38,30,0.12)";
  if (severity === "medium") return "rgba(138,83,0,0.12)";
  return "rgba(14,14,16,0.06)";
}

function severityFg(severity: Hazard["severity"]): string {
  if (severity === "high") return statusFg.danger;
  if (severity === "medium") return statusFg.warning;
  return t.dim;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
    gap: brandSpacing.s3,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
  },
  errorTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  errorBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    marginTop: brandSpacing.s1,
    textAlign: "center",
  },
  retryButton: {
    marginTop: brandSpacing.s4,
    backgroundColor: t.invBg,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
  },
  retryLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },

  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  headerCard: {
    gap: brandSpacing.s2,
  },
  headerCardDimmed: {
    opacity: 0.7,
    borderColor: t.line,
  },
  thresholdBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  thresholdBadgeLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  thresholdHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  headerTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 24,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s1,
    marginTop: brandSpacing.s1,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    backgroundColor: t.raised2,
    borderRadius: brandRadii.pill,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s1,
  },
  metaPillLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "500",
  },

  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  sectionTitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    flex: 1,
  },
  sectionRight: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },

  qualityHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  qualityScore: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 40,
    fontWeight: "800",
  },
  qualitySubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    marginTop: brandSpacing.s1,
  },
  qualityEstimate: {
    fontSize: 12,
    color: UNSCORED_COLOR,
    marginTop: 2,
    fontStyle: "italic",
  },
  qualityScoreMax: {
    paddingBottom: brandSpacing.s2,
  },
  qualityScoreMaxText: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },

  breakdownBar: {
    flexDirection: "row",
    height: 10,
    borderRadius: brandRadii.sm,
    overflow: "hidden",
    backgroundColor: t.sunken,
  },
  breakdownLegend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s2,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },

  curvinessRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  curvinessScore: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 40,
    fontWeight: "800",
  },
  curvinessPips: {
    flexDirection: "row",
    gap: brandSpacing.s1,
  },
  curvinessHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },

  elevationChartWrap: {
    width: "100%",
    height: ELEVATION_CHART_HEIGHT,
    backgroundColor: t.raised2,
    borderRadius: brandRadii.sm,
    overflow: "hidden",
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
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 18,
    fontWeight: "700",
  },
  elevationLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    marginTop: brandSpacing.s1,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },

  hazardRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    paddingVertical: brandSpacing.s1,
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
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  hazardNote: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  hazardMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },

  writeReviewButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  writeReviewLabel: {
    color: INTERACTIVE,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  statusBanner: {
    color: statusFg.warning,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  reviewAuthorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  reviewMineBadge: {
    backgroundColor: t.raised2,
    borderRadius: brandRadii.pill,
    paddingHorizontal: brandSpacing.s1,
    paddingVertical: 2,
  },
  reviewMineBadgeLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
  },
  reviewEditButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: brandSpacing.s1,
    marginTop: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s2,
    minHeight: 36,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  reviewEditLabel: {
    color: INTERACTIVE,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
  },
  reviewRow: {
    gap: brandSpacing.s1,
    paddingVertical: brandSpacing.s2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.line,
  },
  reviewHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  reviewAuthor: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  reviewAuthorLink: {
    color: INTERACTIVE,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  reviewRating: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    letterSpacing: 1,
  },
  reviewComment: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  reviewPhotosRow: {
    gap: brandSpacing.s2,
    paddingTop: brandSpacing.s1,
  },
  reviewPhoto: {
    width: REVIEW_PHOTO_SIZE,
    height: REVIEW_PHOTO_SIZE,
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
  },
  reviewFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: brandSpacing.s1,
  },
  reviewMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  reviewMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  reviewHelpfulRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s1,
  },
  reviewHelpfulButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s2,
    minHeight: 36,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  reviewHelpfulButtonActive: {
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  reviewHelpfulCount: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    fontWeight: "500",
    minWidth: 12,
    textAlign: "center",
  },
  reviewHelpfulCountActive: {
    color: t.fg,
  },

  empty: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  emptyInline: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
});
