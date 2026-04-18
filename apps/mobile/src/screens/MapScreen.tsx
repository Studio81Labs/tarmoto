/**
 * MapScreen — US-1 road quality overlay on the map.
 *
 * Renders a MapLibre basemap with a vector-tile overlay fed by the
 * backend's `/roads/tiles/{z}/{x}/{y}.mvt?layers=quality` endpoint.
 * Segments are coloured by `quality_score` (1..5) matching the rest of
 * the app's theme, and opacity fades with `confidence` so thinly-sampled
 * roads don't pretend to be authoritative.
 *
 * The quality layer can be toggled on/off via the floating FAB; state
 * lives in `useMapStore` so the preference survives tab switches.
 *
 * Offline tile caching (US-1 AC #4) is intentionally out of scope for
 * this iteration — it's a substantial feature that belongs to US-18
 * "Offline maps and navigation".
 */
import React, { useCallback } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  Camera,
  LineLayer,
  MapView,
  type RegionPayload,
  UserLocation,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useMapStore } from "@/stores";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  shadows,
  spacing,
} from "@/theme";
import {
  DEV_MAP_STYLE_URL,
  getQualityTileUrlTemplate,
  qualityLineStyle,
} from "./MapScreen.helpers";

type RegionChangeFeature = GeoJSON.Feature<GeoJSON.Point, RegionPayload>;

export default function MapScreen() {
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const showQualityOverlay = useMapStore((s) => s.showQualityOverlay);
  const setCenter = useMapStore((s) => s.setCenter);
  const setZoom = useMapStore((s) => s.setZoom);
  const toggleQuality = useMapStore((s) => s.toggleQuality);

  const tileUrl = getQualityTileUrlTemplate();

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
              style={qualityLineStyle}
            />
          </VectorSource>
        ) : null}
      </MapView>

      <QualityToggleFab active={showQualityOverlay} onPress={toggleQuality} />

      {showQualityOverlay ? <QualityLegend /> : null}
    </View>
  );
}

function QualityToggleFab({
  active,
  onPress,
}: {
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.toggleFab, active ? styles.toggleFabActive : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        active ? "Hide road quality overlay" : "Show road quality overlay"
      }
      accessibilityState={{ selected: active }}
    >
      <Icon
        name="road-variant"
        size={20}
        color={active ? colors.textInverse : colors.textPrimary}
      />
      <Text
        style={[styles.toggleLabel, active ? styles.toggleLabelActive : null]}
      >
        Quality
      </Text>
    </TouchableOpacity>
  );
}

function QualityLegend() {
  return (
    <View style={styles.legend}>
      <Text style={styles.legendTitle}>Road quality</Text>
      <View style={styles.legendRow}>
        <LegendSwatch color={colors.quality.excellent} label="Excellent" />
        <LegendSwatch color={colors.quality.good} label="Good" />
        <LegendSwatch color={colors.quality.fair} label="Fair" />
        <LegendSwatch color={colors.quality.poor} label="Poor" />
        <LegendSwatch color={colors.quality.veryPoor} label="Very poor" />
      </View>
    </View>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
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
  toggleFab: {
    position: "absolute",
    top: spacing.xl,
    right: spacing.lg,
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
  legendTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
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
