/**
 * MapScreen — US-1 road quality overlay + US-11 mountain pass markers
 * + US-6 fun zone discovery.
 *
 * Renders a MapLibre basemap with three independent overlays toggled via
 * the FAB column on the right. Toggles persist in `useMapStore` so the
 * preferences survive tab switches.
 *
 *   - Quality: vector-tile overlay fed by the backend's
 *     `/api/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality` endpoint. Segments
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
import {
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  type PressEventWithFeatures,
  UserLocation,
  type ViewStateChangeEvent,
} from "@maplibre/maplibre-react-native";
import { Icon } from "@/components/Icon";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { formatDisplayLowerCase } from "@tarmoto/shared";
import HazardReportFab from "@/components/HazardReportFab";
import { api } from "@/services/api";
import { hazardSocket } from "@/services/hazardSocket";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { MapStackParamList } from "@/navigation/RootNavigator";
import type { Hazard, HazardType } from "@/types";
import { getDefaultDocsDir, isRegionUsableBy } from "@/services/offlineRegions";
import {
  findBestOfflineRegion,
  offlineTileUrlTemplate,
} from "@/services/offlineTileLookup";
import {
  useAuthStore,
  useMapStore,
  useOfflineStore,
  usePreferencesStore,
} from "@/stores";
import type { FunZone, MountainPass } from "@/types";
import {
  shouldShowQualityUpgradePrompt,
  useQualityLayerMaxZoom,
} from "./MapScreen.entitlement";
import { QualityOverlaySource } from "./MapScreen.qualityOverlay";
import { useEntitlements, useFeature, useLimit } from "@/hooks/useEntitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
// The brand quality ramp is imported so the legend swatches mirror the
// MapLibre overlay colours (both now paint `QUALITY_COLORS` from
// `MapScreen.helpers`).
import { qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  qualityBrandColor,
  QUALITY_COLORS,
} from "@/theme/brand";
import {
  applyHazardAlert,
  bboxFromVisibleBounds,
  buildQualityLineStyle,
  APP_MAP_STYLE_URL,
  mergeHazardsRest,
  FUN_ZONE_COLORS,
  funZoneFillStyle,
  funZoneLineStyle,
  funZonesToFeatureCollection,
  formatFunZoneSeason,
  getQualityTileUrlTemplate,
  hazardsToFeatureCollection,
  hazardMarkerStyle,
  PASS_STATUS_COLORS,
  PASS_STATUS_LABELS,
  passesToFeatureCollection,
  passMarkerStyle,
} from "./MapScreen.helpers";
import { formatKm } from "./TripScreens.helpers";
import { useTranslation, useI18n } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";

type IconName = ComponentProps<typeof Icon>["name"];

// The quality legend grows when offline tiles are active (an extra row
// announces the cached region), so a hardcoded height would leave the
// passes legend and fun-zone card overlapping it. The actual height is
// measured via `onLayout` and fed to both. This fallback is only used
// before the first layout pass.
const QUALITY_LEGEND_FALLBACK_HEIGHT = 76;
const FUN_ZONE_CARD_PASSES_OFFSET = 60 + brandSpacing.s2;

type MapNav = NativeStackNavigationProp<MapStackParamList, "Map">;

const t = brandColorsLight;
// Overlay chrome floats over the map tiles, so it follows the dark-overlay
// pattern (ink pills + cream labels) rather than cream cards — the ramp
// swatches and accent then pop against the ink at >=6:1.
const INK_PILL = "rgba(14,14,16,0.85)";
const INK_CARD = "rgba(14,14,16,0.92)";
const ON_DARK = t.invFg;
const ON_DARK_DIM = "rgba(245,239,230,0.66)";
const ON_DARK_FAINT = "rgba(245,239,230,0.40)";
const HAIRLINE_ON_DARK = "rgba(245,239,230,0.15)";

export default function MapScreen() {
  const translate = useTranslation();
  const navigation = useNavigation<MapNav>();
  const handleOpenReport = useCallback(
    (preselectedType?: HazardType) => {
      navigation.navigate(
        "HazardReport",
        preselectedType ? { preselectedType } : undefined,
      );
    },
    [navigation],
  );
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const showQualityOverlay = useMapStore((s) => s.showQualityOverlay);
  const showHazardOverlay = useMapStore((s) => s.showHazardOverlay);
  // Operator kill switch (`hazard_alerts`, off the public /config/flags fast
  // path): an operator disables community hazard reception globally during an
  // alert-spam / false-positive storm. Fold it into the overlay flag so a kill
  // stops the REST fetch, the WS subscription, the markers, AND hides the
  // toggle — for signed-out riders too. Fail SAFE (on unless force_off), so the
  // common path is unchanged.
  const hazardAlertsEnabled = useFeatureKillSwitchActive("hazard_alerts");
  const hazardsActive = showHazardOverlay && hazardAlertsEnabled;
  // Operator kill switch (`road_quality_overlay`, same fail-SAFE /config/flags
  // path): disables the quality-coloured overlay globally when a bad tile build
  // ships. Fold it into the overlay flag so a kill stops the tile source, hides
  // the legend AND the toggle, and suppresses the zoom-limit upgrade nudge —
  // for signed-out riders too. The stored `showQualityOverlay` intent is left
  // intact, so the overlay returns if the operator flips it back on.
  const qualityOverlayEnabled = useFeatureKillSwitchActive(
    "road_quality_overlay",
  );
  const qualityOverlayActive = showQualityOverlay && qualityOverlayEnabled;
  const showPassesOverlay = useMapStore((s) => s.showPassesOverlay);
  const showFunZonesOverlay = useMapStore((s) => s.showFunZonesOverlay);
  const setCenter = useMapStore((s) => s.setCenter);
  const setZoom = useMapStore((s) => s.setZoom);
  const toggleQuality = useMapStore((s) => s.toggleQuality);
  const toggleHazards = useMapStore((s) => s.toggleHazards);
  const togglePasses = useMapStore((s) => s.togglePasses);
  const toggleFunZones = useMapStore((s) => s.toggleFunZones);
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const offlineRegions = useOfflineStore((s) => s.regions);
  const riderId = useAuthStore((s) => s.user?.id ?? null);
  const { maxzoom: qualityMaxZoom, visible: qualityMaxZoomVisible } =
    useQualityLayerMaxZoom();
  // Discovery prompt for a rider on a FINITE cap who zooms past it — the
  // clamp above is the actual enforcement; this is a one-shot-per-mount
  // nudge, not a gate. `tier` and the raw (unclamped) limit come from a
  // second read of the same entitlement snapshot the clamp hook already
  // subscribes to.
  const { tier: qualityTier } = useEntitlements();
  const { limit: qualityZoomLimit } = useLimit("road_quality_max_zoom");
  const [qualityUpgradePromptVisible, setQualityUpgradePromptVisible] =
    useState(false);
  const qualityUpgradePromptDismissedRef = useRef(false);

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
  // Reset to the fallback whenever the quality overlay is toggled off so
  // the next toggle-on doesn't briefly use a stale (possibly larger)
  // height for positioning the passes legend / fun-zone card before
  // `onLayout` fires.
  useEffect(() => {
    if (!showQualityOverlay) {
      setQualityLegendHeight(QUALITY_LEGEND_FALLBACK_HEIGHT);
    }
  }, [showQualityOverlay]);

  // Dismiss an already-open zoom-upgrade nudge if `road_quality_overlay` gets
  // killed while it's showing — the source, legend, and toggle all disappear,
  // so a modal still upselling the (now operator-disabled) overlay is stale.
  // Gating only the trigger above prevents FUTURE prompts, not an open one.
  useEffect(() => {
    if (!qualityOverlayActive) {
      setQualityUpgradePromptVisible(false);
    }
  }, [qualityOverlayActive]);

  // US-18 AC #3: when the rider is panning inside a completed offline
  // region at a zoom the region caches, serve the overlay from the
  // on-disk `file://` template instead of hitting the backend. When the
  // rider pans out of any cached bbox we flip back to the online URL —
  // MapLibre will re-request tiles for the new source, which is the
  // intended behaviour. `getDefaultDocsDir` reaches into RNFS, so guard
  // with try/catch so environments without the native binding (tests,
  // web preview) fall through to the online path rather than crashing.
  // offline_maps is a Pro entitlement. Serving previously-cached tiles is the
  // paid capability, so gate the on-disk read too — otherwise a rider who
  // downloaded regions while entitled would keep getting offline functionality
  // after a downgrade / force-off (and can't even open OfflineRegionsScreen to
  // delete them). Fail closed while unresolved: fall back to the online URL.
  const { enabled: offlineMapsEnabled, isResolved: offlineMapsResolved } =
    useFeature("offline_maps");
  const offlineTilesAllowed = offlineMapsResolved && offlineMapsEnabled;
  const offlineSource = useMemo(() => {
    if (!offlineTilesAllowed) return null;
    // Only packs this rider downloaded (#1279). The store is device-global and
    // survives sign-out, and a pack's contents are shaped by its downloader's
    // `road_quality_max_zoom` — so reading someone else's would serve their
    // entitlement, not this rider's.
    const region = findBestOfflineRegion(
      offlineRegions.filter((r) => isRegionUsableBy(r, riderId)),
      center,
      zoom,
    );
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
  }, [offlineTilesAllowed, offlineRegions, riderId, center, zoom]);

  const tileUrl = offlineSource?.template ?? getQualityTileUrlTemplate();

  // Rebuild the line style only when the rider's minimum-quality threshold
  // changes so MapLibre's style diff stays a no-op on every render. US-5:
  // segments below the threshold are grayed and faded so they recede but
  // remain visible as context for alternative-route decisions.
  const qualityStyle = useMemo(
    () => buildQualityLineStyle(minQuality),
    [minQuality],
  );

  // US-11: load mountain passes once per mount. `getPasses` follows the
  // backend's bounded pages, so a growing catalog remains complete without
  // one unbounded query or camera-move refetches, and toggling the overlay
  // stays flicker-free.
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

  // #341 — hazards on the map. Seed via REST so the rider sees the
  // current state on cold load, then keep up to date via the
  // `hazard:new` WS fan-out. Re-seed when the camera centre crosses a
  // ~5 km threshold so a long pan eventually reflects what the gateway
  // covers — anything tighter would thrash the network on every settle
  // for no rider-visible benefit.
  const [hazards, setHazards] = useState<Hazard[]>([]);
  // Tombstone map: id → ms timestamp when a `dismissed` WS event was observed.
  // Passed to mergeHazardsRest so stale in-flight REST responses can't
  // resurrect admin-moderated markers.
  const dismissedTombstonesRef = useRef<Map<string, number>>(
    // `Map` in this file is shadowed by the MapLibre react-native import;
    // use globalThis to reach the built-in collection constructor.
    new globalThis.Map<string, number>(),
  );
  // WS arrival map: id → ms timestamp when a non-dismissed `hazard:new`
  // socket event was received. Passed to mergeHazardsRest so hazards that
  // arrived during an in-flight REST fetch are not silently dropped when the
  // REST response lands and replaces local state. Same globalThis.Map idiom
  // as dismissedTombstonesRef — `Map` is shadowed by the MapLibre import.
  const wsHazardArrivalRef = useRef<Map<string, number>>(
    new globalThis.Map<string, number>(),
  );
  // Snapshot of the (lat, lng) we last fetched hazards for. Compared
  // against current centre via a coarse great-circle distance to decide
  // whether the next settle warrants a refetch.
  const lastHazardFetchRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!hazardsActive) {
      // Soft reset on toggle-off (or an operator kill) so flipping back on
      // doesn't briefly flash the previous viewport's pins before the new
      // fetch lands.
      lastHazardFetchRef.current = null;
      setHazards((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const last = lastHazardFetchRef.current;
    const movedFar =
      !last || Math.hypot(last.lat - center.lat, last.lng - center.lng) > 0.05; // ~5 km
    if (!movedFar) return;

    let cancelled = false;
    // Stash a stable reference for THIS fetch's snapshot so the catch
    // handler can tell whether a newer settle has since taken over the
    // ref. Comparing against `last` (the pre-fetch value) would always
    // be false because we overwrite the ref on the very next line, so
    // a failed fetch would silently pin the coordinate and block the
    // next retry until the rider moved >5 km.
    const snapshot = { lat: center.lat, lng: center.lng };
    lastHazardFetchRef.current = snapshot;
    const fetchStartedAt = Date.now();
    void api
      .getHazards(center.lat, center.lng)
      .then((next) => {
        if (cancelled) return;
        setHazards((prev) =>
          mergeHazardsRest(
            next,
            prev,
            wsHazardArrivalRef.current,
            dismissedTombstonesRef.current,
            fetchStartedAt,
          ),
        );
      })
      .catch(() => {
        // Soft failure — clear our snapshot so the next settle retries
        // rather than pinning a failed coordinate forever. Skip the
        // clear if a newer fetch has already taken over the ref so we
        // don't clobber an in-flight fetch's coordinate.
        if (lastHazardFetchRef.current === snapshot) {
          lastHazardFetchRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hazardsActive, center.lat, center.lng]);

  // Subscribe to the gateway fan-out while the overlay is on. The
  // service handles AppState (foreground = connected, background =
  // disconnected) and socket.io reconnects internally, so the screen
  // only has to bind handlers and update the geographic subscription
  // when the rider pans far enough.
  useEffect(() => {
    if (!hazardsActive) return;
    hazardSocket.start(
      { lat: center.lat, lng: center.lng },
      {
        onHazard: (event) => {
          // Record a tombstone for dismissed events regardless of whether the
          // marker is currently in state — the race is specifically when it's
          // absent (dismissed arrived while a REST fetch started before it was
          // still in flight). The tombstone lets mergeHazardsRest drop the
          // stale entry from the REST response when it eventually lands.
          if (event.severity === "dismissed") {
            dismissedTombstonesRef.current.set(event.id, Date.now());
            // Clear any WS arrival entry for this id — the hazard is gone
            // and a lingering entry would cause it to be re-preserved on
            // the next REST response even though it was just dismissed.
            wsHazardArrivalRef.current.delete(event.id);
          } else {
            // A normal event (restore / confirm / create) supersedes any
            // prior dismissal: clear the tombstone so an in-flight REST
            // `.then` (whose snapshot predates the dismissal) doesn't filter
            // the now-restored marker back out.
            dismissedTombstonesRef.current.delete(event.id);
            // Record the WS arrival timestamp so mergeHazardsRest can
            // preserve this hazard if a REST response lands while the
            // server snapshot predates this event.
            wsHazardArrivalRef.current.set(event.id, Date.now());
          }
          setHazards((prev) => applyHazardAlert(prev, event));
        },
      },
    );
    return () => {
      hazardSocket.stop();
    };
  }, [hazardsActive]);

  useEffect(() => {
    if (!hazardsActive) return;
    hazardSocket.updateSubscription({ lat: center.lat, lng: center.lng });
  }, [hazardsActive, center.lat, center.lng]);

  const hazardFc = useMemo(
    () => hazardsToFeatureCollection(hazards),
    [hazards],
  );

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
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const { bounds, center: viewCenter, zoom: viewZoom } = event.nativeEvent;
      const [lng, lat] = viewCenter;
      setCenter({ lat, lng });
      setZoom(viewZoom);

      if (showFunZonesOverlay) {
        void fetchFunZones(
          bboxFromVisibleBounds([
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ]),
        );
      }

      // One-shot discovery nudge — see `shouldShowQualityUpgradePrompt`.
      if (
        shouldShowQualityUpgradePrompt({
          showQualityOverlay: qualityOverlayActive,
          dismissed: qualityUpgradePromptDismissedRef.current,
          limit: qualityZoomLimit,
          maxzoom: qualityMaxZoom,
          viewZoom,
          tier: qualityTier,
        })
      ) {
        setQualityUpgradePromptVisible(true);
      }
    },
    [
      setCenter,
      setZoom,
      showFunZonesOverlay,
      fetchFunZones,
      qualityOverlayActive,
      qualityZoomLimit,
      qualityMaxZoom,
      qualityTier,
    ],
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
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      const id = event.nativeEvent.features[0]?.properties?.id as
        string | undefined;
      if (!id) return;
      const zone = funZones.find((z) => z.id === id);
      if (zone) setSelectedZone(zone);
    },
    [funZones],
  );

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={APP_MAP_STYLE_URL}
        onRegionDidChange={handleRegionDidChange}
        attribution
        logo={false}
      >
        <Camera
          initialViewState={{
            center: [center.lng, center.lat],
            zoom,
          }}
        />
        <UserLocation animated />
        <QualityOverlaySource
          show={qualityOverlayActive}
          visible={qualityMaxZoomVisible}
          regionKey={offlineSource?.regionId ?? "online"}
          tileUrl={tileUrl}
          maxzoom={qualityMaxZoom}
          style={qualityStyle}
        />

        {showPassesOverlay && passes.length > 0 ? (
          <GeoJSONSource
            id="tarmoto-passes"
            data={passesToFeatureCollection(passes)}
          >
            <Layer
              type="circle"
              id="tarmoto-passes-markers"
              source="tarmoto-passes"
              {...passMarkerStyle}
            />
          </GeoJSONSource>
        ) : null}

        {hazardsActive && hazardFc.features.length > 0 ? (
          <GeoJSONSource id="tarmoto-hazards" data={hazardFc}>
            <Layer
              type="circle"
              id="tarmoto-hazards-markers"
              source="tarmoto-hazards"
              {...hazardMarkerStyle}
            />
          </GeoJSONSource>
        ) : null}

        {showFunZonesOverlay && funZoneFc.features.length > 0 ? (
          <GeoJSONSource
            id="tarmoto-fun-zones"
            data={funZoneFc}
            onPress={handleFunZonePress}
            hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
          >
            <Layer
              type="fill"
              id="tarmoto-fun-zones-fill"
              source="tarmoto-fun-zones"
              {...funZoneFillStyle}
            />
            <Layer
              type="line"
              id="tarmoto-fun-zones-line"
              source="tarmoto-fun-zones"
              {...funZoneLineStyle}
            />
          </GeoJSONSource>
        ) : null}
      </Map>

      <View style={styles.fabColumn}>
        {qualityOverlayEnabled && (
          <ToggleFab
            icon="road-variant"
            label={translate("Quality")}
            active={showQualityOverlay}
            onPress={toggleQuality}
          />
        )}
        {hazardAlertsEnabled && (
          <ToggleFab
            icon="alert-circle"
            label={translate("Hazards")}
            active={showHazardOverlay}
            onPress={toggleHazards}
          />
        )}
        <ToggleFab
          icon="terrain"
          label={translate("Passes")}
          active={showPassesOverlay}
          onPress={togglePasses}
        />
        <ToggleFab
          icon="fire"
          label={translate("Fun zones")}
          active={showFunZonesOverlay}
          onPress={toggleFunZones}
        />
      </View>

      {qualityOverlayActive ? (
        <QualityLegend
          minQuality={minQuality}
          offlineRegionName={offlineSource?.regionName}
          onHeightChange={handleQualityLegendLayout}
        />
      ) : null}
      {showPassesOverlay && passes.length > 0 ? (
        <PassesLegend
          stacked={qualityOverlayActive}
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
          hasQualityLegend={qualityOverlayActive}
          hasPassesLegend={showPassesOverlay && passes.length > 0}
          qualityLegendHeight={qualityLegendHeight}
        />
      ) : showFunZonesOverlay ? (
        <FunZonesLegend zoneCount={funZones.length} />
      ) : null}

      <HazardReportFab
        onOpenReport={handleOpenReport}
        style={styles.hazardFab}
      />

      <UpgradePrompt
        // Belt-and-braces with the reset effect: derive visibility from the
        // live overlay state so the nudge can't show for a killed overlay even
        // for the one frame before the reset effect commits.
        visible={qualityUpgradePromptVisible && qualityOverlayActive}
        capability={{
          limit: "road_quality_max_zoom",
          resolvedLimit: qualityZoomLimit,
        }}
        currentTier={qualityTier ?? "free"}
        message={translate(
          "Zoom in further for full road-quality detail with Pro.",
        )}
        onClose={() => {
          setQualityUpgradePromptVisible(false);
          qualityUpgradePromptDismissedRef.current = true;
        }}
      />
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
  const translate = useTranslation();
  const { locale } = useI18n();
  return (
    <TouchableOpacity
      style={[styles.toggleFab, active ? styles.toggleFabActive : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        active
          ? translate("Hide {label} overlay", {
              label: formatDisplayLowerCase(label, locale),
            })
          : translate("Show {label} overlay", {
              label: formatDisplayLowerCase(label, locale),
            })
      }
      accessibilityState={{ selected: active }}
    >
      <Icon name={icon} size={20} color={active ? t.fg : ON_DARK} />
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
  offlineRegionName?: string | undefined;
  onHeightChange?: (height: number) => void;
}) {
  const translate = useTranslation();
  // Buckets are rendered top-down (Excellent → Very poor) but the score
  // values map 5 → 1. Buckets with a score below `minQuality` are dimmed
  // and swatched in gray to match the map's below-threshold rendering.
  const buckets: Array<{ score: number; color: string; label: string }> = [
    { score: 5, color: QUALITY_COLORS[4], label: translate("Excellent") },
    { score: 4, color: QUALITY_COLORS[3], label: translate("Good") },
    { score: 3, color: QUALITY_COLORS[2], label: translate("Fair") },
    { score: 2, color: QUALITY_COLORS[1], label: translate("Poor") },
    { score: 1, color: QUALITY_COLORS[0], label: translate("Very poor") },
  ];
  return (
    <View
      style={styles.legend}
      onLayout={(event) => {
        onHeightChange?.(event.nativeEvent.layout.height);
      }}
    >
      <View style={styles.legendHeader}>
        <Text style={styles.legendTitle}>{translate("Road quality")}</Text>
        {minQuality > 1 ? (
          <Text style={styles.legendSubtitle}>
            {translate("Min: {quality}", {
              quality: qualityLabel(minQuality),
            })}
          </Text>
        ) : null}
      </View>
      <View style={styles.legendRow}>
        {buckets.map((b) => (
          <LegendSwatch
            key={b.label}
            color={b.score < minQuality ? ON_DARK_FAINT : b.color}
            label={b.label}
            dimmed={b.score < minQuality}
          />
        ))}
      </View>
      {offlineRegionName ? (
        <View style={styles.legendOfflineRow}>
          <Icon name="cloud-check-outline" size={12} color={ON_DARK_DIM} />
          <Text style={styles.legendOfflineText} numberOfLines={1}>
            {translate("Offline tiles · {name}", { name: offlineRegionName })}
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
  const translate = useTranslation();
  // When stacked, pin above the quality legend using its measured height
  // (grows when offline tiles are active) plus a small gutter so the two
  // legends never kiss. Falls back to the default bottom from
  // `styles.legend` when quality is hidden.
  const stackedStyle = stacked
    ? { bottom: brandSpacing.s5 + qualityLegendHeight + brandSpacing.s2 }
    : null;
  return (
    <View style={[styles.legend, stackedStyle]}>
      <Text style={styles.legendTitle}>{translate("Mountain passes")}</Text>
      <View style={styles.legendRow}>
        <LegendDot
          color={PASS_STATUS_COLORS.open}
          label={translate(PASS_STATUS_LABELS.open)}
        />
        <LegendDot
          color={PASS_STATUS_COLORS.closed}
          label={translate(PASS_STATUS_LABELS.closed)}
        />
        <LegendDot
          color={PASS_STATUS_COLORS.unknown}
          label={translate(PASS_STATUS_LABELS.unknown)}
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
  const translate = useTranslation();
  return (
    <View style={styles.funZonesLegend}>
      <Icon name="fire" size={16} color={t.accent} />
      <Text style={styles.funZonesLegendTitle}>
        {zoneCount > 0
          ? translate(
              "{count, plural, one {# fun zone} other {# fun zones}} · tap to open",
              { count: zoneCount },
            )
          : translate("Pan the map to find fun zones")}
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
  const format = useFormat();
  const translate = useTranslation();
  // Reuse the quality colour ramp — composite scores sit on the same 0-5
  // scale and the breakpoints match, so a separate function would just be a
  // drift risk if the buckets ever change.
  const accent = qualityBrandColor(zone.composite_score);
  // Push above whichever bottom legends are showing. Quality legend height
  // is measured (it grows when the offline row is active); passes legend
  // is still an approximate fixed height since its content never changes.
  const stackOffset =
    (hasQualityLegend ? qualityLegendHeight + brandSpacing.s2 : 0) +
    (hasPassesLegend ? FUN_ZONE_CARD_PASSES_OFFSET : 0);
  const bottom = brandSpacing.s5 + stackOffset;
  const title = zone.name?.trim() || translate("Fun zone");
  const curveKm =
    zone.total_curve_km != null ? formatKm(zone.total_curve_km) : null;
  const avgQuality =
    zone.avg_quality != null ? qualityLabel(zone.avg_quality) : null;
  return (
    <View style={[styles.funZoneCard, { bottom }]}>
      <View style={styles.funZoneCardHeader}>
        <View style={[styles.funZoneScoreChip, { borderColor: accent }]}>
          <Text style={[styles.funZoneScoreChipValue, { color: accent }]}>
            {format.decimal(zone.composite_score, 1)}
          </Text>
          <Text style={styles.funZoneScoreChipLabel}>{translate("score")}</Text>
        </View>
        <View style={styles.funZoneCardHeaderText}>
          <Text style={styles.funZoneCardTitle} numberOfLines={1}>
            {title}
          </Text>
          {zone.best_season ? (
            <Text style={styles.funZoneCardSubtitle}>
              {translate("Best: {season}", {
                season: formatFunZoneSeason(zone.best_season),
              })}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={translate("Close fun zone details")}
          hitSlop={10}
        >
          <Icon name="close" size={20} color={ON_DARK_DIM} />
        </TouchableOpacity>
      </View>
      <View style={styles.funZoneStatsRow}>
        <FunZoneStat
          label={translate("Roads")}
          value={zone.road_count > 0 ? format.integer(zone.road_count) : "—"}
        />
        <FunZoneStat label={translate("Curve km")} value={curveKm ?? "—"} />
        <FunZoneStat
          label={translate("Avg quality")}
          value={avgQuality ?? "—"}
        />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  map: {
    flex: 1,
  },
  fabColumn: {
    position: "absolute",
    top: brandSpacing.s5,
    right: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  toggleFab: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s4,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: INK_PILL,
    borderWidth: 1,
    borderColor: HAIRLINE_ON_DARK,
  },
  toggleFabActive: {
    backgroundColor: t.accent,
    borderColor: t.accent,
  },
  toggleLabel: {
    color: ON_DARK,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
  },
  toggleLabelActive: {
    color: t.fg,
  },
  legend: {
    position: "absolute",
    bottom: brandSpacing.s5,
    left: brandSpacing.s4,
    right: brandSpacing.s4,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: INK_PILL,
    borderWidth: 1,
    borderColor: HAIRLINE_ON_DARK,
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
    gap: brandSpacing.s2,
  },
  legendTitle: {
    color: ON_DARK,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: brandSpacing.s2,
  },
  legendSubtitle: {
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  legendRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
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
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  legendOfflineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: brandSpacing.s2,
    paddingTop: brandSpacing.s2,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE_ON_DARK,
  },
  legendOfflineText: {
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    flex: 1,
  },
  // Compact pill in the top-left so fun-zones status stays visible without
  // competing with the stacked bottom legends (Quality, Passes) or the FAB
  // column on the right.
  funZonesLegend: {
    position: "absolute",
    top: brandSpacing.s5,
    left: brandSpacing.s4,
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: INK_PILL,
    borderWidth: 1,
    borderColor: HAIRLINE_ON_DARK,
  },
  funZonesLegendTitle: {
    color: ON_DARK,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
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
    bottom: brandSpacing.s5,
    left: brandSpacing.s4,
    right: brandSpacing.s4,
    padding: brandSpacing.s4,
    borderRadius: brandRadii.md,
    backgroundColor: INK_CARD,
    borderWidth: 1,
    borderColor: HAIRLINE_ON_DARK,
    gap: brandSpacing.s3,
  },
  funZoneCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  funZoneCardHeaderText: {
    flex: 1,
    gap: 2,
  },
  funZoneCardTitle: {
    color: ON_DARK,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  funZoneCardSubtitle: {
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  funZoneScoreChip: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(245,239,230,0.08)",
  },
  funZoneScoreChipValue: {
    fontFamily: brandFonts.mono,
    fontSize: 16,
    fontWeight: "700",
  },
  funZoneScoreChipLabel: {
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  funZoneStatsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  funZoneStat: {
    flex: 1,
  },
  funZoneStatLabel: {
    color: ON_DARK_DIM,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  funZoneStatValue: {
    color: ON_DARK,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2,
  },
  // Bottom-right thumb-reach for a quick "panic" tap. Offset above the
  // bottom legends (Quality ≈ 76 px, Passes ≈ 60 px) so the FAB clears
  // a single legend without overlap and keeps a comfortable gap above
  // the screen edge when no overlay legends are visible.
  hazardFab: {
    position: "absolute",
    right: brandSpacing.s4,
    bottom: brandSpacing.s5 + 100,
  },
});
