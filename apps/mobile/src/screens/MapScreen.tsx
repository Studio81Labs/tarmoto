/**
 * MapScreen — US-1 road quality overlay + US-11 mountain pass markers.
 *
 * Renders a MapLibre basemap with two independent overlays toggled via
 * the FAB column on the right. Both toggles persist in `useMapStore` so
 * the preferences survive tab switches.
 *
 *   - Quality: vector-tile overlay fed by the backend's
 *     `/roads/tiles/{z}/{x}/{y}.mvt?layers=quality` endpoint. Segments
 *     are coloured by `quality_score` (1..5) and faded by `confidence`.
 *
 *   - Passes (US-11): point markers fetched once from `/passes`,
 *     colour-coded by current open/closed/unknown status. The seasonal
 *     status is computed server-side from the typical open/close window.
 *
 * Offline tile caching (US-1 AC #4) is intentionally out of scope for
 * this iteration — it belongs to US-18 "Offline maps and navigation".
 */
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  Camera,
  CircleLayer,
  LineLayer,
  MapView,
  type RegionPayload,
  ShapeSource,
  UserLocation,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/services/api";
import { useMapStore, usePreferencesStore } from "@/stores";
import type { MountainPass } from "@/types";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityLabel,
  shadows,
  spacing,
} from "@/theme";
import {
  buildQualityLineStyle,
  DEV_MAP_STYLE_URL,
  getQualityTileUrlTemplate,
  PASS_STATUS_COLORS,
  PASS_STATUS_LABELS,
  passesToFeatureCollection,
  passMarkerStyle,
} from "./MapScreen.helpers";

type RegionChangeFeature = GeoJSON.Feature<GeoJSON.Point, RegionPayload>;
type IconName = ComponentProps<typeof Icon>["name"];

export default function MapScreen() {
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const showQualityOverlay = useMapStore((s) => s.showQualityOverlay);
  const showPassesOverlay = useMapStore((s) => s.showPassesOverlay);
  const setCenter = useMapStore((s) => s.setCenter);
  const setZoom = useMapStore((s) => s.setZoom);
  const toggleQuality = useMapStore((s) => s.toggleQuality);
  const togglePasses = useMapStore((s) => s.togglePasses);
  const minQuality = usePreferencesStore((s) => s.minQuality);

  const tileUrl = getQualityTileUrlTemplate();

  // Rebuild the line style only when the rider's minimum-quality threshold
  // changes so MapLibre's style diff stays a no-op on every render. US-5:
  // segments below the threshold are grayed and faded so they recede but
  // remain visible as context for alternative-route decisions.
  const qualityStyle = useMemo(
    () => buildQualityLineStyle(minQuality),
    [minQuality],
  );

  // US-11: load mountain passes once per mount. The seeded dataset is
  // small (≈ a dozen rows), so a single global fetch is far cheaper than
  // refetching on every camera move and lets us toggle the overlay
  // without flicker. If the catalog grows past hundreds we'll switch to
  // bbox-scoped fetching driven by `handleRegionDidChange`.
  const [passes, setPasses] = useState<MountainPass[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api
      .getPasses()
      .then((next) => {
        if (!cancelled) setPasses(next);
      })
      .catch(() => {
        // Soft failure — the overlay is informational; toast/console
        // belongs to a future generic error surface.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync settled camera back to the store so the next visit opens where
  // the rider left off. `onRegionDidChange` fires only after the gesture
  // settles, so no extra throttling is needed.
  const handleRegionDidChange = useCallback(
    (feature: RegionChangeFeature) => {
      const [lng, lat] = feature.geometry.coordinates;
      setCenter({ lat, lng });
      setZoom(feature.properties.zoomLevel);
    },
    [setCenter, setZoom],
  );

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        mapStyle={DEV_MAP_STYLE_URL}
        onRegionDidChange={handleRegionDidChange}
        attributionEnabled
        logoEnabled={false}
      >
        <Camera
          defaultSettings={{
            centerCoordinate: [center.lng, center.lat],
            zoomLevel: zoom,
          }}
        />
        <UserLocation visible animated />
        {showQualityOverlay ? (
          <VectorSource
            id="tarmoto-quality"
            tileUrlTemplates={[tileUrl]}
            minZoomLevel={0}
            maxZoomLevel={22}
          >
            <LineLayer
              id="tarmoto-quality-lines"
              sourceID="tarmoto-quality"
              sourceLayerID="quality"
              style={qualityStyle}
            />
          </VectorSource>
        ) : null}

        {showPassesOverlay && passes.length > 0 ? (
          <ShapeSource
            id="tarmoto-passes"
            shape={passesToFeatureCollection(passes)}
          >
            <CircleLayer
              id="tarmoto-passes-markers"
              sourceID="tarmoto-passes"
              style={passMarkerStyle}
            />
          </ShapeSource>
        ) : null}
      </MapView>

      <View style={styles.fabColumn}>
        <ToggleFab
          icon="road-variant"
          label="Quality"
          active={showQualityOverlay}
          onPress={toggleQuality}
        />
        <ToggleFab
          icon="terrain"
          label="Passes"
          active={showPassesOverlay}
          onPress={togglePasses}
        />
      </View>

      {showQualityOverlay ? <QualityLegend minQuality={minQuality} /> : null}
      {showPassesOverlay && passes.length > 0 ? (
        <PassesLegend stacked={showQualityOverlay} />
      ) : null}
    </View>
  );
}

function ToggleFab({
  icon,
  label,
  active,
  onPress,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.toggleFab, active ? styles.toggleFabActive : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${active ? "Hide" : "Show"} ${label.toLowerCase()} overlay`}
      accessibilityState={{ selected: active }}
    >
      <Icon
        name={icon}
        size={20}
        color={active ? colors.textInverse : colors.textPrimary}
      />
      <Text
        style={[styles.toggleLabel, active ? styles.toggleLabelActive : null]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function QualityLegend({ minQuality }: { minQuality: number }) {
  // Buckets are rendered top-down (Excellent → Very poor) but the score
  // values map 5 → 1. Buckets with a score below `minQuality` are dimmed
  // and swatched in gray to match the map's below-threshold rendering.
  const buckets: Array<{ score: number; color: string; label: string }> = [
    { score: 5, color: colors.quality.excellent, label: "Excellent" },
    { score: 4, color: colors.quality.good, label: "Good" },
    { score: 3, color: colors.quality.fair, label: "Fair" },
    { score: 2, color: colors.quality.poor, label: "Poor" },
    { score: 1, color: colors.quality.veryPoor, label: "Very poor" },
  ];
  return (
    <View style={styles.legend}>
      <View style={styles.legendHeader}>
        <Text style={styles.legendTitle}>Road quality</Text>
        {minQuality > 1 ? (
          <Text style={styles.legendSubtitle}>
            Min: {qualityLabel(minQuality)}
          </Text>
        ) : null}
      </View>
      <View style={styles.legendRow}>
        {buckets.map((b) => (
          <LegendSwatch
            key={b.label}
            color={b.score < minQuality ? colors.textTertiary : b.color}
            label={b.label}
            dimmed={b.score < minQuality}
          />
        ))}
      </View>
    </View>
  );
}

function LegendSwatch({
  color,
  label,
  dimmed,
}: {
  color: string;
  label: string;
  dimmed?: boolean;
}) {
  return (
    <View style={[styles.swatchRow, dimmed ? styles.swatchRowDimmed : null]}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.swatchLabel}>{label}</Text>
    </View>
  );
}

function PassesLegend({ stacked }: { stacked: boolean }) {
  return (
    <View style={[styles.legend, stacked ? styles.legendPassesStacked : null]}>
      <Text style={styles.legendTitle}>Mountain passes</Text>
      <View style={styles.legendRow}>
        <LegendDot
          color={PASS_STATUS_COLORS.open}
          label={PASS_STATUS_LABELS.open}
        />
        <LegendDot
          color={PASS_STATUS_COLORS.closed}
          label={PASS_STATUS_LABELS.closed}
        />
        <LegendDot
          color={PASS_STATUS_COLORS.unknown}
          label={PASS_STATUS_LABELS.unknown}
        />
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.swatchLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  map: {
    flex: 1,
  },
  fabColumn: {
    position: "absolute",
    top: spacing.xl,
    right: spacing.lg,
    gap: spacing.sm,
  },
  toggleFab: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  toggleFabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  toggleLabelActive: {
    color: colors.textInverse,
  },
  legend: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  // Applied only when the quality legend is also visible — shifts the
  // passes legend just above it so both fit at the bottom without
  // colliding with the FAB column on the right. Quality's legend is
  // roughly 76 px tall (title + single row + padding); keep in sync if
  // that ever changes. When quality is hidden the passes legend stays
  // pinned at the default `bottom: spacing.xl` from `styles.legend`.
  legendPassesStacked: {
    bottom: spacing.xl + 76 + spacing.sm,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  legendTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  legendSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  legendRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  swatchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  swatchRowDimmed: {
    opacity: 0.5,
  },
  swatch: {
    width: 12,
    height: 4,
    borderRadius: 2,
  },
  swatchLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
});
