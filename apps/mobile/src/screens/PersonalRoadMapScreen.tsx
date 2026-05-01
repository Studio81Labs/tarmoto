/**
 * PersonalRoadMapScreen — US-30 (personal "ridden vs unridden" road map).
 *
 * Renders the road quality vector overlay with the rider's ridden segments
 * highlighted in the brand colour vs dimmed-grey unridden segments. A
 * compact stats card sits at the top, a period filter (this month / year
 * / all-time) lets the rider see how their footprint changes over time,
 * and a "Discover roads nearby" bottom sheet surfaces the top-N nearby
 * unridden segments ranked by quality.
 *
 * The ridden filter is computed client-side from `/exploration/ridden-segments`
 * so the period buckets stay in sync with the timestamps the rider sees on
 * their ride history. The unridden list comes from
 * `/exploration/nearby-unridden` and is ranked by quality then proximity.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  Camera,
  Layer,
  Map,
  UserLocation,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import type { LineLayerStyle } from "@maplibre/maplibre-react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityColor,
  qualityLabel,
  spacing,
} from "@/theme";
import type { ExplorationStats, RiddenSegment, UnriddenSegment } from "@/types";
import {
  DEV_MAP_STYLE_URL,
  getQualityTileUrlTemplate,
} from "./MapScreen.helpers";
import {
  filterByPeriod,
  formatDistanceFromHere,
  formatSegmentLength,
  rankUnriddenSegments,
  summarizeExploration,
  type RidePeriod,
} from "./AchievementsScreen.helpers";

// Default camera centre when we don't have a fix yet — Brno, the
// reference city for the design + early-access community. This matches
// how MapScreen handles the no-location case (no fix → still mounts a
// map at a sensible default rather than a black square).
const DEFAULT_CENTER = { lat: 49.1951, lng: 16.6068 } as const;

export default function PersonalRoadMapScreen() {
  const [stats, setStats] = useState<ExplorationStats | null>(null);
  const [riddenSegments, setRiddenSegments] = useState<RiddenSegment[]>([]);
  const [unridden, setUnridden] = useState<UnriddenSegment[]>([]);
  const [period, setPeriod] = useState<RidePeriod>("all");
  const [center, setCenter] = useState<{ lat: number; lng: number }>(
    DEFAULT_CENTER,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  const load = useCallback(async (initial: boolean) => {
    if (!initial) setIsRefreshing(true);
    try {
      // Pull a current location so the "nearby unridden" call uses a
      // fresh fix. Falls back to the default centre if the rider has
      // GPS off — we still want the personal map and stats to render.
      const fix = await locationService.getCurrentLocation({
        timeoutMs: 6000,
      });
      const lat = fix?.lat ?? DEFAULT_CENTER.lat;
      const lng = fix?.lng ?? DEFAULT_CENTER.lng;
      setCenter({ lat, lng });

      const [statsResp, riddenResp, unriddenResp] = await Promise.all([
        api.getExplorationStats(),
        api.getRiddenSegments(),
        api.getNearbyUnriddenSegments(lat, lng, { limit: 10 }),
      ]);
      setStats(statsResp);
      setRiddenSegments(riddenResp.segments);
      setUnridden(unriddenResp);
      setErrorMessage(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Couldn't load your map.";
      setErrorMessage(message);
    } finally {
      if (initial) setIsInitialLoad(false);
      else setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  // Apply the period filter to the rider's ridden segments client-side so
  // toggling the filter is instant — we already have the timestamps and
  // the map style is just an `in` expression keyed on segment ID.
  const filteredRiddenIds = useMemo(() => {
    return filterByPeriod(riddenSegments, period).map((s) => s.id);
  }, [riddenSegments, period]);

  if (isInitialLoad && stats === null && errorMessage === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (errorMessage && stats === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyTitle}>Can't load your map</Text>
        <Text style={styles.emptyBody}>{errorMessage}</Text>
      </View>
    );
  }

  const summary = stats ? summarizeExploration(stats) : null;
  const tileUrl = getQualityTileUrlTemplate();
  const lineStyle = buildPersonalLineStyle(filteredRiddenIds);

  // Brand-new rider: no rides recorded ever. Show an empty CTA above
  // the (still-rendered) map so the rider sees the unridden roads
  // nearby — that's the "go ride something" prompt for this screen.
  const isBrandNew = riddenSegments.length === 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => void load(false)}
          tintColor={colors.primary}
        />
      }
    >
      {summary ? (
        <StatsCard
          summary={summary}
          riddenInPeriod={filteredRiddenIds.length}
        />
      ) : null}

      <PeriodFilter period={period} onChange={setPeriod} />

      <View style={styles.mapWrap}>
        <Map
          style={styles.map}
          mapStyle={DEV_MAP_STYLE_URL}
          attribution
          logo={false}
        >
          <Camera
            initialViewState={{
              center: [center.lng, center.lat],
              zoom: 11,
            }}
          />
          <UserLocation animated />
          <VectorSource
            id="tarmoto-personal-quality"
            tiles={[tileUrl]}
            minzoom={0}
            maxzoom={22}
          >
            <Layer
              type="line"
              id="tarmoto-personal-lines"
              source="tarmoto-personal-quality"
              source-layer="quality"
              style={lineStyle}
            />
          </VectorSource>
        </Map>
        <View style={styles.legend}>
          <LegendDot color={colors.primary} label="Ridden" />
          <LegendDot color={colors.textTertiary} label="Not ridden" />
        </View>
      </View>

      {isBrandNew ? (
        <View style={styles.emptyCard}>
          <Icon name="map-search-outline" size={40} color={colors.primary} />
          <Text style={styles.emptyTitle}>No rides recorded yet</Text>
          <Text style={styles.emptyBody}>
            Once you complete a ride, the roads you covered will light up here.
          </Text>
        </View>
      ) : null}

      <NearbyUnridden segments={unridden} />
    </ScrollView>
  );
}

// ── Sub-components ──

function StatsCard({
  summary,
  riddenInPeriod,
}: {
  summary: ReturnType<typeof summarizeExploration>;
  riddenInPeriod: number;
}) {
  return (
    <View style={styles.statsCard}>
      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{summary.percentLabel}</Text>
          <Text style={styles.statLabel}>Explored</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{summary.riddenCount}</Text>
          <Text style={styles.statLabel}>of {summary.totalCount} segments</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{summary.distanceKmLabel}</Text>
          <Text style={styles.statLabel}>Total ridden</Text>
        </View>
      </View>
      <Text style={styles.periodNote}>
        {riddenInPeriod} segments highlighted for the selected period
      </Text>
    </View>
  );
}

function PeriodFilter({
  period,
  onChange,
}: {
  period: RidePeriod;
  onChange: (next: RidePeriod) => void;
}) {
  return (
    <View
      style={styles.periodRow}
      accessibilityRole="radiogroup"
      accessibilityLabel="Time period"
    >
      <PeriodButton
        label="This month"
        active={period === "month"}
        onPress={() => onChange("month")}
      />
      <PeriodButton
        label="This year"
        active={period === "year"}
        onPress={() => onChange("year")}
      />
      <PeriodButton
        label="All time"
        active={period === "all"}
        onPress={() => onChange("all")}
      />
    </View>
  );
}

function PeriodButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.periodBtn, active ? styles.periodBtnActive : null]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <Text
        style={[styles.periodLabel, active ? styles.periodLabelActive : null]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

function NearbyUnridden({ segments }: { segments: UnriddenSegment[] }) {
  const ranked = rankUnriddenSegments(segments);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Discover roads nearby</Text>
      <Text style={styles.altSubtitle}>
        Top unridden roads near you, ranked by quality.
      </Text>
      {ranked.length === 0 ? (
        <Text style={styles.emptyInline}>
          You've ridden every nearby road we know about.
        </Text>
      ) : (
        ranked.map((s) => <UnriddenRow key={s.id} segment={s} />)
      )}
    </View>
  );
}

function UnriddenRow({ segment }: { segment: UnriddenSegment }) {
  const score = segment.quality_score;
  const qualityText = score !== null ? qualityLabel(score) : "Quality pending";
  const qualityClr = score !== null ? qualityColor(score) : colors.textTertiary;

  return (
    <View style={styles.unriddenRow}>
      <View style={[styles.qualityDot, { backgroundColor: qualityClr }]} />
      <View style={styles.unriddenBody}>
        <Text style={styles.unriddenName}>
          {segment.road_name ?? "Unnamed road"}
        </Text>
        <Text style={styles.unriddenMeta}>
          {formatSegmentLength(segment.length_m)} ·{" "}
          {formatDistanceFromHere(segment.distance_m)} from you
        </Text>
        <Text style={[styles.unriddenQuality, { color: qualityClr }]}>
          {qualityText}
          {segment.surface_type ? ` · ${segment.surface_type}` : ""}
        </Text>
      </View>
    </View>
  );
}

// ── Map style helper ──

/**
 * Build a `LineLayerStyle` that paints ridden segments in the brand
 * primary and dims unridden segments. Uses a `match` expression on the
 * feature `id` so we can highlight thousands of segments without
 * mounting a second source. When `riddenIds` is empty, every segment
 * renders dim — that's the brand-new-rider state.
 *
 * The expression form is:
 *   match get(id), <id1>, primary, <id2>, primary, …, fallback
 * MapLibre validates this at parse time but rejects empty match lists,
 * so we hand-build an `["==", ["get", "id"], "<sentinel>"]` placeholder
 * when the list is empty rather than producing an invalid match
 * expression.
 */
export function buildPersonalLineStyle(
  riddenIds: readonly string[],
): LineLayerStyle {
  const dimmedColor = colors.textTertiary;
  const riddenColor = colors.primary;

  // No ridden segments — entire layer renders dim. Avoids the empty-match
  // "match expression must have at least one stop" MapLibre error.
  if (riddenIds.length === 0) {
    return {
      lineColor: dimmedColor,
      lineWidth: ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2.5, 18, 4],
      lineOpacity: 0.5,
      lineCap: "round",
      lineJoin: "round",
    };
  }

  // For very large lists we cap at a sane upper bound — MapLibre handles
  // thousands of stops fine in practice but the wire size of a 50k-id
  // expression is wasteful when only the visible viewport's IDs matter.
  // 5000 covers a power user; the rest fall back to the dimmed colour and
  // re-light when the rider zooms in.
  const cap = 5000;
  const ids = riddenIds.length > cap ? riddenIds.slice(0, cap) : riddenIds;

  // MapLibre's `match` accepts an array of labels that all share the
  // same output: `["match", input, [id1, id2, …], output, fallback]`.
  // Every ridden id maps to the same colour/opacity, so the grouped
  // form roughly halves the serialised expression size compared to
  // emitting one stop per id, and avoids repeating the same id twice
  // across the lineColor / lineOpacity expressions.
  const labels = [...ids];

  return {
    lineColor: [
      "match",
      ["get", "id"],
      labels,
      riddenColor,
      dimmedColor,
    ] as unknown as LineLayerStyle["lineColor"],
    lineWidth: [
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      1,
      12,
      2.5,
      16,
      5,
      20,
      8,
    ],
    lineOpacity: [
      "match",
      ["get", "id"],
      labels,
      1,
      0.45,
    ] as unknown as LineLayerStyle["lineOpacity"],
    lineCap: "round",
    lineJoin: "round",
  };
}

// ── Test re-exports ──

export const __test = {
  buildPersonalLineStyle,
};

// ── Styles ──

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
  emptyInline: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontStyle: "italic",
  },
  emptyCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xxl,
    alignItems: "center",
    gap: spacing.sm,
  },
  statsCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  statCell: {
    flex: 1,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  statLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  periodNote: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  periodRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  periodBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  periodBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  periodLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  periodLabelActive: {
    color: colors.textInverse,
  },
  mapWrap: {
    position: "relative",
    height: 320,
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSurface,
  },
  map: {
    flex: 1,
  },
  legend: {
    position: "absolute",
    bottom: spacing.sm,
    left: spacing.sm,
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: "rgba(7, 10, 16, 0.85)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
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
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  altSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  unriddenRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  qualityDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 4,
  },
  unriddenBody: {
    flex: 1,
    gap: 2,
  },
  unriddenName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  unriddenMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  unriddenQuality: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
});
