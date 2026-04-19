/**
 * MapScreen — US-1 road quality overlay + US-11 mountain pass markers
 * + US-6 fun zone discovery.
 *
 * Renders a MapLibre basemap with three independent overlays toggled via
 * the FAB column on the right. Toggles persist in `useMapStore` so the
 * preferences survive tab switches.
 *
 *   - Quality: vector-tile overlay fed by the backend's
 *     `/roads/tiles/{z}/{x}/{y}.mvt?layers=quality` endpoint. Segments
 *     are coloured by `quality_score` (1..5) and faded by `confidence`.
 *
 *   - Passes (US-11): point markers fetched once from `/passes`,
 *     colour-coded by current open/closed/unknown status. The seasonal
 *     status is computed server-side from the typical open/close window.
 *
 *   - Fun Zones (US-6): polygon heatmap patches fetched from
 *     `/roads/fun-zones?bbox=…` for the current viewport. Panning the map
 *     re-queries (debounced). Tapping a zone opens a bottom card with
 *     the composite score, road count, total curve km, and best season.
 *     Mobile intentionally uses the viewport as the "region" rather than
 *     a draw-polygon tool — that's a desktop-first pattern covered on
 *     web by #43.
 *
 * Offline tiles (US-18 AC #3): when the current viewport centre sits
 * inside a rider's completed offline region, we feed MapLibre a
 * `file://` tile template pointing at the cached bytes on disk instead
 * of the backend URL. Full offline detection (NetInfo) is a follow-up;
 * for now the rule is "if you've cached this area, you want to see the
 * cached copy here". A subtle legend line tells the rider which region
 * is feeding the overlay. Offline routing (US-18 AC #2) remains out of
 * scope.
 */
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  Camera,
  CircleLayer,
  FillLayer,
  LineLayer,
  MapView,
  type RegionPayload,
  ShapeSource,
  UserLocation,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/services/api";
import { getDefaultDocsDir } from "@/services/offlineRegions";
import {
  findBestOfflineRegion,
  offlineTileUrlTemplate,
} from "@/services/offlineTileLookup";
import { useMapStore, useOfflineStore, usePreferencesStore } from "@/stores";
import type { FunZone, MountainPass } from "@/types";
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
import {
  bboxFromVisibleBounds,
  buildQualityLineStyle,
  DEV_MAP_STYLE_URL,
  FUN_ZONE_COLORS,
  funZoneFillStyle,
  funZoneLineStyle,
  funZonesToFeatureCollection,
  getQualityTileUrlTemplate,
  PASS_STATUS_COLORS,
  PASS_STATUS_LABELS,
  passesToFeatureCollection,
  passMarkerStyle,
} from "./MapScreen.helpers";
import { formatKm } from "./TripScreens.helpers";

type RegionChangeFeature = GeoJSON.Feature<GeoJSON.Point, RegionPayload>;
type IconName = ComponentProps<typeof Icon>["name"];

// The quality legend grows when offline tiles are active (an extra row
// announces the cached region), so a hardcoded height would leave the
// passes legend and fun-zone card overlapping it. The actual height is
// measured via `onLayout` and fed to both. This fallback is only used
// before the first layout pass.
const QUALITY_LEGEND_FALLBACK_HEIGHT = 76;
const FUN_ZONE_CARD_PASSES_OFFSET = 60 + spacing.sm;

export default function MapScreen() {
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const showQualityOverlay = useMapStore((s) => s.showQualityOverlay);
  const showPassesOverlay = useMapStore((s) => s.showPassesOverlay);
  const showFunZonesOverlay = useMapStore((s) => s.showFunZonesOverlay);
  const setCenter = useMapStore((s) => s.setCenter);
  const setZoom = useMapStore((s) => s.setZoom);
  const toggleQuality = useMapStore((s) => s.toggleQuality);
  const togglePasses = useMapStore((s) => s.togglePasses);
  const toggleFunZones = useMapStore((s) => s.toggleFunZones);
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const offlineRegions = useOfflineStore((s) => s.regions);

  // Actual rendered height of the quality legend. Passed to siblings
  // (passes legend, fun-zone card) so their stacking offsets track the
  // legend's real size — the offline row can grow it by ~25 px. Guarded
  // against duplicate layout events (same height) so we don't thrash
  // re-renders during settle.
  const [qualityLegendHeight, setQualityLegendHeight] = useState(
    QUALITY_LEGEND_FALLBACK_HEIGHT,
  );
  const handleQualityLegendLayout = useCallback((height: number) => {
    setQualityLegendHeight((prev) => (prev === height ? prev : height));
  }, []);

  // US-18 AC #3: when the rider is panning inside a completed offline
  // region at a zoom the region caches, serve the overlay from the
  // on-disk `file://` template instead of hitting the backend. When the
  // rider pans out of any cached bbox we flip back to the online URL —
  // MapLibre will re-request tiles for the new source, which is the
  // intended behaviour. `getDefaultDocsDir` reaches into RNFS, so guard
  // with try/catch so environments without the native binding (tests,
  // web preview) fall through to the online path rather than crashing.
  const offlineSource = useMemo(() => {
    const region = findBestOfflineRegion(offlineRegions, center, zoom);
    if (!region) return null;
    try {
      const docsDir = getDefaultDocsDir();
      return {
        // `regionId` (not `regionName`) drives the VectorSource remount key:
        // rider-chosen names are not guaranteed unique, so two same-named
        // regions on different bboxes would leave MapLibre pointed at the
        // old tile URL when the rider pans from one to the other.
        regionId: region.id,
        regionName: region.name,
        template: offlineTileUrlTemplate(docsDir, region.id),
      };
    } catch {
      return null;
    }
  }, [offlineRegions, center, zoom]);

  const tileUrl = offlineSource?.template ?? getQualityTileUrlTemplate();

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

  // US-6: fun-zone overlay state. Fetches are keyed on the viewport bbox
  // string so repeated region events at the same camera position don't
  // thrash the network. The last-bbox ref lets the region handler skip
  // any refetch while we're already holding fresh data for that window.
  const [funZones, setFunZones] = useState<FunZone[]>([]);
  const [selectedZone, setSelectedZone] = useState<FunZone | null>(null);
  const lastFunZoneBboxRef = useRef<string | null>(null);

  const fetchFunZones = useCallback(async (bbox: string) => {
    // Don't refetch the same window twice — the backend query is GIST-bound
    // and cheap, but repeated fetches would repaint the layer and cause
    // flicker on every debounced region event. Keying on the rounded bbox
    // string also means tiny pan jitter after a settle won't refire.
    if (lastFunZoneBboxRef.current === bbox) return;
    lastFunZoneBboxRef.current = bbox;
    try {
      const next = await api.getFunZones(bbox);
      // Drop the response if a newer fetch has since taken over the ref —
      // otherwise a slow in-flight call for a previous viewport can resolve
      // after a fresher one and silently clobber the correct zones with
      // stale data. Ref, not state, because this check is synchronous.
      if (lastFunZoneBboxRef.current !== bbox) return;
      setFunZones(next);
    } catch {
      // Soft-fail — clear the ref so the same viewport can be retried.
      // Without this, an optimistic dedup entry pins a failed bbox and
      // both the region handler and the toggle-on fallback short-circuit
      // forever until the rider pans to a distinctly different window.
      // Guard on `=== bbox` so a newer in-flight fetch (which has already
      // taken over the ref) stays untouched and remains the source of
      // truth for the current viewport.
      if (lastFunZoneBboxRef.current === bbox) {
        lastFunZoneBboxRef.current = null;
      }
    }
  }, []);

  // Sync settled camera back to the store so the next visit opens where
  // the rider left off. `onRegionDidChange` fires only after the gesture
  // settles, so no extra throttling is needed. When the fun-zones overlay
  // is on we piggyback a fetch here so the layer always matches what the
  // rider sees.
  const handleRegionDidChange = useCallback(
    (feature: RegionChangeFeature) => {
      const [lng, lat] = feature.geometry.coordinates;
      setCenter({ lat, lng });
      setZoom(feature.properties.zoomLevel);

      if (showFunZonesOverlay) {
        const bounds = (feature.properties as { visibleBounds?: unknown })
          .visibleBounds as [[number, number], [number, number]] | undefined;
        if (bounds) {
          void fetchFunZones(bboxFromVisibleBounds(bounds));
        }
      }
    },
    [setCenter, setZoom, showFunZonesOverlay, fetchFunZones],
  );

  // When the rider toggles fun zones ON without panning the camera we
  // still need to populate the layer. Derive an approximate bbox from the
  // stored camera centre + zoom using a rough degrees-per-pixel lookup
  // that only needs to be coarse enough to cover the visible viewport.
  useEffect(() => {
    if (!showFunZonesOverlay) {
      // Clear cached bbox + any open card when toggled off so re-opening
      // refetches fresh. Also drop the rendered zones — otherwise, if the
      // rider pans while the overlay is off and then re-enables it, the
      // previous viewport's polygons flash on screen until the new fetch
      // resolves (and the legend reports a stale count).
      //
      // Guard the state setters on actual state presence: this effect's
      // deps include `zoom` + `center.{lat,lng}`, which fire on every map
      // settle even while the overlay is off. Without the guards we'd
      // allocate fresh null/[] references each pan and force a re-render
      // (which would also invalidate the `funZoneFc` memo for nothing).
      lastFunZoneBboxRef.current = null;
      setSelectedZone((prev) => (prev === null ? prev : null));
      setFunZones((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Only fire the fallback fetch if the region handler hasn't already
    // cached a bbox — otherwise we'd double-fetch every toggle flip.
    if (lastFunZoneBboxRef.current !== null) return;
    // Degrees of latitude per screen row are roughly constant (parallels are
    // parallel), but degrees of longitude compress by a factor of cos(φ) as
    // we move towards the poles — so a square viewport covers MORE degrees
    // of longitude at higher latitudes. The fallback bbox only needs to be
    // approximate (the region handler refines it on the next pan), but the
    // correction has to go on longitude, not latitude.
    //
    // Slippy-map convention: the world spans 360° of longitude at zoom 0 and
    // halves per zoom level — `360 / 2^zoom` is the span of ONE tile. A
    // typical mobile viewport shows roughly 1-3 tiles per axis depending on
    // device/DPI, so we multiply by a conservative factor to over-cover the
    // visible window. The region handler overwrites this on the next settle,
    // so a one-off over-fetch is cheaper than missing zones at the edges.
    const tileDegrees = 360 / Math.pow(2, zoom);
    const viewportTiles = 3;
    const halfLat = (tileDegrees * viewportTiles) / 2;
    const halfLng =
      (tileDegrees * viewportTiles) /
      2 /
      Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
    const bbox = bboxFromVisibleBounds([
      [center.lng - halfLng, center.lat - halfLat],
      [center.lng + halfLng, center.lat + halfLat],
    ]);
    void fetchFunZones(bbox);
  }, [showFunZonesOverlay, zoom, center.lat, center.lng, fetchFunZones]);

  const funZoneFc = useMemo(
    () => funZonesToFeatureCollection(funZones),
    [funZones],
  );

  const handleFunZonePress = useCallback(
    (event: { features: GeoJSON.Feature[] }) => {
      const id = event.features[0]?.properties?.id as string | undefined;
      if (!id) return;
      const zone = funZones.find((z) => z.id === id);
      if (zone) setSelectedZone(zone);
    },
    [funZones],
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
          // `key` includes the offline source so MapLibre fully remounts the
          // VectorSource when we swap between the backend URL and a cached
          // `file://` template. Keeping the same `id` across templates would
          // leave the native side pointing at the old tile URL even after
          // React updated the prop.
          <VectorSource
            key={`quality-${offlineSource?.regionId ?? "online"}`}
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

        {showFunZonesOverlay && funZoneFc.features.length > 0 ? (
          <ShapeSource
            id="tarmoto-fun-zones"
            shape={funZoneFc}
            onPress={handleFunZonePress}
            hitbox={{ width: 1, height: 1 }}
          >
            <FillLayer
              id="tarmoto-fun-zones-fill"
              sourceID="tarmoto-fun-zones"
              style={funZoneFillStyle}
            />
            <LineLayer
              id="tarmoto-fun-zones-line"
              sourceID="tarmoto-fun-zones"
              style={funZoneLineStyle}
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
        <ToggleFab
          icon="fire"
          label="Fun zones"
          active={showFunZonesOverlay}
          onPress={toggleFunZones}
        />
      </View>

      {showQualityOverlay ? (
        <QualityLegend
          minQuality={minQuality}
          offlineRegionName={offlineSource?.regionName}
          onHeightChange={handleQualityLegendLayout}
        />
      ) : null}
      {showPassesOverlay && passes.length > 0 ? (
        <PassesLegend
          stacked={showQualityOverlay}
          qualityLegendHeight={qualityLegendHeight}
        />
      ) : null}
      {showFunZonesOverlay && selectedZone ? (
        <FunZoneCard
          zone={selectedZone}
          onClose={() => setSelectedZone(null)}
          // Shift the card above whatever bottom legends are currently
          // visible so the two don't overlap. Quality legend height is
          // measured via `onLayout` (it grows when the offline row is
          // showing), while the passes legend is still a fixed ~60 px.
          hasQualityLegend={showQualityOverlay}
          hasPassesLegend={showPassesOverlay && passes.length > 0}
          qualityLegendHeight={qualityLegendHeight}
        />
      ) : showFunZonesOverlay ? (
        <FunZonesLegend zoneCount={funZones.length} />
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

function QualityLegend({
  minQuality,
  offlineRegionName,
  onHeightChange,
}: {
  minQuality: number;
  offlineRegionName?: string;
  onHeightChange?: (height: number) => void;
}) {
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
    <View
      style={styles.legend}
      onLayout={(event) => {
        onHeightChange?.(event.nativeEvent.layout.height);
      }}
    >
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
      {offlineRegionName ? (
        <View style={styles.legendOfflineRow}>
          <Icon
            name="cloud-check-outline"
            size={12}
            color={colors.textSecondary}
          />
          <Text style={styles.legendOfflineText} numberOfLines={1}>
            Offline tiles · {offlineRegionName}
          </Text>
        </View>
      ) : null}
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

function PassesLegend({
  stacked,
  qualityLegendHeight,
}: {
  stacked: boolean;
  qualityLegendHeight: number;
}) {
  // When stacked, pin above the quality legend using its measured height
  // (grows when offline tiles are active) plus a small gutter so the two
  // legends never kiss. Falls back to the default bottom from
  // `styles.legend` when quality is hidden.
  const stackedStyle = stacked
    ? { bottom: spacing.xl + qualityLegendHeight + spacing.sm }
    : null;
  return (
    <View style={[styles.legend, stackedStyle]}>
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

function FunZonesLegend({ zoneCount }: { zoneCount: number }) {
  return (
    <View style={styles.funZonesLegend}>
      <Icon name="fire" size={16} color={colors.primary} />
      <Text style={styles.funZonesLegendTitle}>
        {zoneCount > 0
          ? `${zoneCount} fun zone${zoneCount === 1 ? "" : "s"} · tap to open`
          : "Pan the map to find fun zones"}
      </Text>
      <View style={styles.funZonesLegendGradient}>
        <View
          style={[
            styles.funZonesLegendSwatch,
            { backgroundColor: FUN_ZONE_COLORS.veryPoor },
          ]}
        />
        <View
          style={[
            styles.funZonesLegendSwatch,
            { backgroundColor: FUN_ZONE_COLORS.poor },
          ]}
        />
        <View
          style={[
            styles.funZonesLegendSwatch,
            { backgroundColor: FUN_ZONE_COLORS.fair },
          ]}
        />
        <View
          style={[
            styles.funZonesLegendSwatch,
            { backgroundColor: FUN_ZONE_COLORS.good },
          ]}
        />
        <View
          style={[
            styles.funZonesLegendSwatch,
            { backgroundColor: FUN_ZONE_COLORS.excellent },
          ]}
        />
      </View>
    </View>
  );
}

function FunZoneCard({
  zone,
  onClose,
  hasQualityLegend,
  hasPassesLegend,
  qualityLegendHeight,
}: {
  zone: FunZone;
  onClose: () => void;
  hasQualityLegend: boolean;
  hasPassesLegend: boolean;
  qualityLegendHeight: number;
}) {
  // Reuse the quality colour ramp — composite scores sit on the same 0-5
  // scale and the breakpoints match, so a separate function would just be a
  // drift risk if the buckets ever change.
  const accent = qualityColor(zone.composite_score);
  // Push above whichever bottom legends are showing. Quality legend height
  // is measured (it grows when the offline row is active); passes legend
  // is still an approximate fixed height since its content never changes.
  const stackOffset =
    (hasQualityLegend ? qualityLegendHeight + spacing.sm : 0) +
    (hasPassesLegend ? FUN_ZONE_CARD_PASSES_OFFSET : 0);
  const bottom = spacing.xl + stackOffset;
  const title = zone.name?.trim() || "Fun zone";
  const curveKm =
    zone.total_curve_km != null ? formatKm(zone.total_curve_km) : null;
  const avgQuality =
    zone.avg_quality != null ? qualityLabel(zone.avg_quality) : null;
  return (
    <View style={[styles.funZoneCard, { bottom }]}>
      <View style={styles.funZoneCardHeader}>
        <View style={[styles.funZoneScoreChip, { borderColor: accent }]}>
          <Text style={[styles.funZoneScoreChipValue, { color: accent }]}>
            {zone.composite_score.toFixed(1)}
          </Text>
          <Text style={styles.funZoneScoreChipLabel}>score</Text>
        </View>
        <View style={styles.funZoneCardHeaderText}>
          <Text style={styles.funZoneCardTitle} numberOfLines={1}>
            {title}
          </Text>
          {zone.best_season ? (
            <Text style={styles.funZoneCardSubtitle}>
              Best: {formatSeason(zone.best_season)}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close fun zone details"
          hitSlop={10}
        >
          <Icon name="close" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <View style={styles.funZoneStatsRow}>
        <FunZoneStat
          label="Roads"
          value={zone.road_count > 0 ? zone.road_count.toString() : "—"}
        />
        <FunZoneStat label="Curve km" value={curveKm ?? "—"} />
        <FunZoneStat label="Avg quality" value={avgQuality ?? "—"} />
      </View>
    </View>
  );
}

function FunZoneStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.funZoneStat}>
      <Text style={styles.funZoneStatLabel}>{label}</Text>
      <Text style={styles.funZoneStatValue}>{value}</Text>
    </View>
  );
}

function formatSeason(season: string): string {
  const cleaned = season.replace(/_/g, " ").trim();
  if (!cleaned) return season;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
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
  legendOfflineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  legendOfflineText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    flex: 1,
  },
  // Compact pill in the top-left so fun-zones status stays visible without
  // competing with the stacked bottom legends (Quality, Passes) or the FAB
  // column on the right.
  funZonesLegend: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  funZonesLegendTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  funZonesLegendGradient: {
    flexDirection: "row",
    gap: 2,
  },
  funZonesLegendSwatch: {
    width: 10,
    height: 6,
    borderRadius: 2,
  },
  funZoneCard: {
    // `bottom` is supplied inline — it shifts based on which other
    // legends are open (Quality, Passes) so the card never lands on top
    // of them. Default 0 keeps the card glued to the screen edge when no
    // inline override lands (e.g. in a future context that doesn't pass
    // the legend flags).
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.lg,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
    ...shadows.card,
  },
  funZoneCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  funZoneCardHeaderText: {
    flex: 1,
    gap: 2,
  },
  funZoneCardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  funZoneCardSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
  funZoneScoreChip: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgElevated,
  },
  funZoneScoreChipValue: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  funZoneScoreChipLabel: {
    color: colors.textTertiary,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  funZoneStatsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  funZoneStat: {
    flex: 1,
  },
  funZoneStatLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  funZoneStatValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
});
