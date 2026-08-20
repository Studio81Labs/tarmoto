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
  type LineLayerSpecification,
  Map,
  UserLocation,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import { Icon } from "@/components/Icon";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import { qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  UNSCORED_COLOR,
} from "@/theme/brand";
import type { ExplorationStats, RiddenSegment, UnriddenSegment } from "@/types";
import {
  APP_MAP_STYLE_URL,
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
import { surfaceLabel } from "./RideScreens.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { useTileCredentialKey } from "@/hooks/useTileCredentialKey";
import { useFormat } from "@/format/FormatProvider";

// Default camera centre when we don't have a fix yet — Brno, the
// reference city for the design + early-access community. This matches
// how MapScreen handles the no-location case (no fix → still mounts a
// map at a sensible default rather than a black square).
const DEFAULT_CENTER = { lat: 49.1951, lng: 16.6068 } as const;

const t = brandColorsLight;
// Dimmed grey for unridden roads on the map + their legend dot. A brand-
// sympathetic neutral (the "unscored" grey) rather than an ink alpha, so it
// reads as a real line colour over the map tiles.
const UNRIDDEN_COLOR = UNSCORED_COLOR;

export default function PersonalRoadMapScreen() {
  const translate = useTranslation();
  // Operator `road_quality_overlay` kill switch: this screen paints its roads
  // from the quality tile layer, so the bad-tile-build kill must drop that
  // source here too (MapScreen's overlay is gated separately). The stats,
  // period filter, and user location stay; only the quality VectorSource goes.
  const qualityOverlayEnabled = useFeatureKillSwitchActive(
    "road_quality_overlay",
  );
  const credentialKey = useTileCredentialKey();
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

  const load = useCallback(
    async (initial: boolean) => {
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
        const message = getUserFacingErrorMessage(
          err,
          translate("Couldn't load your map."),
        );
        setErrorMessage(message);
      } finally {
        if (initial) setIsInitialLoad(false);
        else setIsRefreshing(false);
      }
    },
    [translate],
  );

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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (errorMessage && stats === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={t.dim} />
        <Text style={styles.emptyTitle}>
          {translate("Can't load your map")}
        </Text>
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
          tintColor={t.fg}
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
          mapStyle={APP_MAP_STYLE_URL}
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
          {qualityOverlayEnabled ? (
            // `key` carries the tile credential's presence so the source
            // remounts when tiles start (or stop) being fetched as this rider
            // (#1279) — the native URL transform changes neither the URL
            // template nor MapLibre's tile cache key, so tiles fetched before
            // the credential landed would otherwise stay free-capped.
            <VectorSource
              key={`personal-quality-${credentialKey}`}
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
                {...lineStyle}
              />
            </VectorSource>
          ) : null}
        </Map>
        <View style={styles.legend}>
          <LegendDot color={t.accent} label={translate("Ridden")} />
          <LegendDot color={UNRIDDEN_COLOR} label={translate("Not ridden")} />
        </View>
      </View>

      {isBrandNew ? (
        <View style={styles.emptyCard}>
          <Icon name="map-search-outline" size={40} color={t.accent} />
          <Text style={styles.emptyTitle}>
            {translate("No rides recorded yet")}
          </Text>
          <Text style={styles.emptyBody}>
            {translate(
              "Once you complete a ride, the roads you covered will light up here.",
            )}
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
  const format = useFormat();
  const translate = useTranslation();
  return (
    <View style={styles.statsCard}>
      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{summary.percentLabel}</Text>
          <Text style={styles.statLabel}>{translate("Explored")}</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>
            {format.integer(summary.riddenCount)}
          </Text>
          <Text style={styles.statLabel}>
            {translate(
              "of {count, plural, one {# segment} other {# segments}}",
              { count: summary.totalCount },
            )}
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{summary.distanceKmLabel}</Text>
          <Text style={styles.statLabel}>{translate("Total ridden")}</Text>
        </View>
      </View>
      <Text style={styles.periodNote}>
        {translate(
          "{count, plural, one {# segment highlighted} other {# segments highlighted}} for the selected period",
          { count: riddenInPeriod },
        )}
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
  const translate = useTranslation();
  return (
    <View
      style={styles.periodRow}
      accessibilityRole="radiogroup"
      accessibilityLabel={translate("Time period")}
    >
      <PeriodButton
        label={translate("This month")}
        active={period === "month"}
        onPress={() => onChange("month")}
      />
      <PeriodButton
        label={translate("This year")}
        active={period === "year"}
        onPress={() => onChange("year")}
      />
      <PeriodButton
        label={translate("All time")}
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
  const translate = useTranslation();
  const ranked = rankUnriddenSegments(segments);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>
        {translate("Discover roads nearby")}
      </Text>
      <Text style={styles.altSubtitle}>
        {translate("Top unridden roads near you, ranked by quality.")}
      </Text>
      {ranked.length === 0 ? (
        <Text style={styles.emptyInline}>
          {translate("You've ridden every nearby road we know about.")}
        </Text>
      ) : (
        ranked.map((s) => <UnriddenRow key={s.id} segment={s} />)
      )}
    </View>
  );
}

function UnriddenRow({ segment }: { segment: UnriddenSegment }) {
  const translate = useTranslation();
  const score = segment.quality_score;
  const qualityText =
    score !== null ? qualityLabel(score) : translate("Quality pending");
  // The quality colour rides on the swatch dot (a graphical object); the
  // quality text stays `dim` ink because the ramp fails AA as text on the
  // white card. Quality is never conveyed by colour alone.
  const dotColor = score !== null ? qualityBrandColor(score) : UNSCORED_COLOR;

  return (
    <View style={styles.unriddenRow}>
      <View style={[styles.qualityDot, { backgroundColor: dotColor }]} />
      <View style={styles.unriddenBody}>
        <Text style={styles.unriddenName}>
          {segment.road_name ?? translate("Unnamed road")}
        </Text>
        <Text style={styles.unriddenMeta}>
          {translate("{length} · {distance} from you", {
            length: formatSegmentLength(segment.length_m),
            distance: formatDistanceFromHere(segment.distance_m),
          })}
        </Text>
        <Text style={styles.unriddenQuality}>
          {segment.surface_type
            ? translate("{quality} · {surface}", {
                quality: qualityText,
                surface: surfaceLabel(segment.surface_type),
              })
            : qualityText}
        </Text>
      </View>
    </View>
  );
}

// ── Map style helper ──

/**
 * Build style-spec `paint` and `layout` props that render ridden segments in the brand
 * accent and dims unridden segments in a neutral grey. Uses a `match`
 * expression on the
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
export function buildPersonalLineStyle(riddenIds: readonly string[]): {
  paint: NonNullable<LineLayerSpecification["paint"]>;
  layout: NonNullable<LineLayerSpecification["layout"]>;
} {
  const dimmedColor = UNRIDDEN_COLOR;
  const riddenColor = t.accent;

  // No ridden segments — entire layer renders dim. Avoids the empty-match
  // "match expression must have at least one stop" MapLibre error.
  if (riddenIds.length === 0) {
    return {
      paint: {
        "line-color": dimmedColor,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          1,
          14,
          2.5,
          18,
          4,
        ],
        "line-opacity": 0.5,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
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
    paint: {
      "line-color": ["match", ["get", "id"], labels, riddenColor, dimmedColor],
      "line-width": [
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
      "line-opacity": ["match", ["get", "id"], labels, 1, 0.45],
    },
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
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
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
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
  emptyInline: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  emptyCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s6,
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  statsCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: brandSpacing.s3,
  },
  statCell: {
    flex: 1,
  },
  statValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 18,
    fontWeight: "700",
  },
  statLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: "600",
    marginTop: 2,
  },
  periodNote: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  periodRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  periodBtn: {
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    alignItems: "center",
  },
  periodBtnActive: {
    backgroundColor: t.invBg,
    borderColor: t.invBg,
  },
  periodLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  periodLabelActive: {
    color: t.invFg,
  },
  mapWrap: {
    position: "relative",
    height: 320,
    borderRadius: brandRadii.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
  },
  map: {
    flex: 1,
  },
  legend: {
    position: "absolute",
    bottom: brandSpacing.s2,
    left: brandSpacing.s2,
    flexDirection: "row",
    gap: brandSpacing.s3,
    // Dark (ink) overlay pill, as in the canonical design: the accent /
    // unridden-grey swatches clear 3:1 here (~6.7:1) where they would fall
    // below it on a white pill, keeping the colour key perceivable.
    backgroundColor: "rgba(14,14,16,0.85)",
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
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
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  altSubtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  unriddenRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderTopWidth: 1,
    borderTopColor: t.line,
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
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  unriddenMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  unriddenQuality: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
});
