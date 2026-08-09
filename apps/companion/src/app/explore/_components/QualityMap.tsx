"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  MapCanvas,
  TARMOTO_QUALITY_LAYER,
  TARMOTO_ROAD_HIT_LAYER,
  TARMOTO_SURFACE_LAYER,
  type MapCanvasHandle,
  type MapCanvasViewChange,
} from "@/components/map/MapCanvas";
import {
  ensureAerialBasemap,
  firstSymbolLayerId,
  setAerialBasemapVisible,
} from "@/components/map/AerialBasemap";
import {
  FUN_ZONES_FILL,
  installFunZoneLayer,
  setFunZoneLayersVisible,
  setFunZoneSelection,
  updateFunZoneLayerData,
} from "@/components/map/FunZoneLayer";
import type { FunZoneListItem } from "@/lib/discover";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawBbox,
} from "@/components/map/RegionDrawControl";
import { FSQ_ATTRIBUTION } from "@/components/map/attribution";
import { hazardsApi, type HazardResponse } from "@/lib/api";
import { onHazardNew, subscribeHazards } from "@/lib/socket";
import {
  applyHazardWsEvent,
  mergeHazardsWithInFlightWsArrivals,
} from "@/lib/hazard-merge";
import { useRealtimeStore } from "@/stores/realtime";
import { haversineMeters, upgradeTierForLimit } from "@tarmoto/shared";
import { FILTERABLE_SURFACES, type MapFilters } from "@/lib/map-filters";
import { useNetworkReconnectRevision } from "@/lib/network-status";
import {
  pickNearestLineFeature,
  readSegmentId,
  SEGMENT_HIT_PADDING_PX,
} from "@/lib/map-segment-hit";
import {
  ensurePoiLayers,
  setPoiSourceData,
  POI_PIN_LAYER,
  POI_CLUSTER_LAYER,
  POI_SOURCE,
} from "@/components/map/PoiPinLayer";
import {
  MapPointPopover,
  type MapPoint,
} from "@/components/map/MapPointPopover";
import {
  ensureHazardLayers,
  expandHazardCluster,
  selectHazards,
  setHazardLayersVisible,
  setHazardSourceData,
  HAZARD_BG,
  HAZARD_CLUSTERS,
  type HazardProps,
} from "@/components/map/HazardPinLayer";
import {
  ensureConditionLayers,
  setConditionLayersVisible,
  setConditionSourceData,
  CLOSURE_MARKER_LAYER,
  PASS_MARKER_LAYER,
} from "@/components/map/ConditionMarkerLayer";
import { installPointClickRouter } from "@/components/map/mapPointClickRouter";
import {
  ensureTripRouteLayers,
  setTripRouteLayersVisible,
  setTripRouteSourceData,
  TRIP_ROUTE_LAYER,
} from "@/components/map/TripRouteLayer";
import {
  ensureRideRouteLayers,
  setRideRouteLayersVisible,
  setRideRouteSourceData,
  RIDE_ROUTE_LAYER,
  type RideTrack,
} from "@/components/map/RideRouteLayer";
import { getBasemapPoiLayerIds, topBasemapPlaceAt } from "@/lib/basemap-poi";
import type { TripSummary } from "@/lib/types";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import type {
  PlannerClosure,
  PlannerClosureRoute,
} from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import { plannerApi } from "@/lib/planner/api";
import type { Poi, PoiCategory } from "@/lib/planner/types";
import {
  pinnedConditionRetired,
  reconcileConditionMenu,
} from "./conditionPopoverReconcile";
import { useEntitlements, useRoadQualityZoomCap } from "@/hooks";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import {
  canSelectRoadAtZoom,
  resolveQualityLayerMaxZoom,
  shouldPromptQualityZoom,
} from "@/lib/map-entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { useTranslation } from "@/i18n/I18nProvider";

// Stable empty route list — the explorer never checks conditions against a
// route, so both hooks always fetch the viewport-only (regional) list.
const NO_ROUTES: PlannerClosureRoute[] = [];

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

const POI_FETCH_DEBOUNCE_MS = 300;

// Camera zoom a Conditions-list row tap flies to (floored — never zooms out).
// Street-level so the flown-to closure/pass sits front-and-centre.
const CONDITION_FOCUS_ZOOM = 13;

const HAZARD_MIN_ZOOM = 9;
const HAZARD_FETCH_DEBOUNCE_MS = 300;
const HAZARD_MAX_RADIUS_M = 50_000;
const HAZARD_MIN_RADIUS_M = 500;

interface Props {
  center: { lng: number; lat: number };
  zoom: number;
  filters: MapFilters;
  /** Basemap under the overlays: the branded map, or aerial imagery. */
  basemap?: "map" | "aerial";
  /**
   * Active POI categories to browse in the current viewport. Empty/undefined
   * clears the POI layer.
   */
  poiCategories?: ReadonlySet<PoiCategory>;
  /**
   * Month (1–12) used for seasonal POI status (mountain-pass open/closed), so
   * the pass popover matches the Conditions panel's selected month.
   */
  poiMonth?: number;
  showQuality: boolean;
  showSurface: boolean;
  showHazards: boolean;
  /** When on, ambient closure + pass markers are fetched for the viewport. */
  showConditions: boolean;
  /**
   * Viewport bbox string (`"w,s,e,n"`) the conditions are fetched for — the
   * same value the info panel uses, so React Query shares one cache entry.
   */
  conditionBbox?: string | null;
  /** Month-of-year for seasonal pass status (matches the Conditions panel). */
  conditionsMonth: number;
  /** Exact preview date for closures (matches the Conditions panel picker). */
  conditionsDate: Date;
  /** When on, overlay the rider's own planned trip routes (coral). */
  showMyTrips: boolean;
  /** The rider's trips, drawn from each trip's per-day overview geometry. */
  trips: readonly TripSummary[];
  /** Clicking a trip route opens its detail drawer. */
  onTripSelect: (tripId: string) => void;
  /** When on, overlay the rider's own finished ride routes (indigo). */
  showMyRides: boolean;
  /** The rider's ride tracks (id + geometry) from `/rides/tracks`. */
  rideTracks: readonly RideTrack[];
  /** Clicking a ride route opens its detail drawer. */
  onRideSelect: (rideId: string) => void;
  /** When on, overlay public Fun Zone polygons (score-ramped fills). */
  showFunZones: boolean;
  /** Zones for the current viewport, sorted best-first (drives rank labels). */
  funZones: readonly FunZoneListItem[];
  /** Zone whose detail panel is open — painted with the highlight outline. */
  selectedFunZoneId: string | null;
  /** Clicking open zone ground (no road under the cursor) opens the zone. */
  onFunZoneSelect: (zoneId: string) => void;
  /**
   * Fires when the rider finishes (or clears) a Fun Zone draw-region box —
   * `null` on clear. The page constrains the zone fetch to this bbox.
   */
  onDrawnRegionChange?: (bbox: RegionDrawBbox | null) => void;
  onSegmentSelect?: (segmentId: string) => void;
  /** Segment whose detail drawer is open — painted with the highlight overlay. */
  selectedSegmentId?: string | null;
  onViewChange?: (view: MapCanvasViewChange) => void;
}

function readMapView(map: MapLibreMap): MapCanvasViewChange {
  const center = map.getCenter();
  const bounds = map.getBounds();
  return {
    lng: Number(center.lng.toFixed(5)),
    lat: Number(center.lat.toFixed(5)),
    zoom: Number(map.getZoom().toFixed(2)),
    bbox: [
      Number(bounds.getWest().toFixed(5)),
      Number(bounds.getSouth().toFixed(5)),
      Number(bounds.getEast().toFixed(5)),
      Number(bounds.getNorth().toFixed(5)),
    ],
  };
}

/**
 * Imperative handle exposed by `QualityMap` so callers can drive
 * the underlying MapLibre camera programmatically. `MapCanvas`
 * reads `center` / `zoom` only at init (otherwise it would yank
 * user pans), so search-pick / fit-to-route style flows need this
 * narrow opt-in channel instead.
 */
export interface QualityMapHandle {
  flyTo(target: { lng: number; lat: number; zoom: number }): void;
  /** Fly to a condition and open its shared popover (list-row → map focus). */
  openConditionPopover(ref: { kind: "closure" | "pass"; id: string }): void;
  /** Arm the Fun Zone draw-region box (drag on the map to draw). */
  startDrawRegion(): void;
  /** Abort an in-progress draw without committing a box. */
  cancelDrawRegion(): void;
  /** Clear any drawn Fun Zone region (reverts the fetch to the viewport). */
  clearDrawnRegion(): void;
}

export const QualityMap = forwardRef<QualityMapHandle, Props>(
  function QualityMap(
    {
      center,
      zoom,
      filters,
      basemap = "map",
      poiCategories,
      poiMonth,
      showQuality,
      showSurface,
      showHazards: showHazardsProp,
      showConditions,
      conditionBbox,
      conditionsMonth,
      conditionsDate,
      showMyTrips,
      trips,
      onTripSelect,
      showMyRides,
      rideTracks,
      onRideSelect,
      showFunZones,
      funZones,
      selectedFunZoneId,
      onFunZoneSelect,
      onDrawnRegionChange,
      onSegmentSelect,
      selectedSegmentId,
      onViewChange,
    },
    ref,
  ) {
    const t = useTranslation();
    // Discovery nudge: a free rider zooming the overlay past the entitled
    // cap gets a one-shot upgrade modal on THIS surface only (the primary
    // interactive quality map — other quality consumers keep the silent
    // clamp from `resolveQualityLayerMaxZoom`/`MapCanvas`). `qualityCapFinite`
    // is false while the cap is unresolved OR for an unlimited (pro/premium)
    // rider — fail closed, never nag in either case. The prompt threshold is
    // the RAW entitlement cap level (finite when `qualityCapFinite`), not the
    // exclusive layer maxzoom.
    //
    // The clamp applies to EVERYONE (via MapCanvas), but only PROMPT when an
    // upgrade could actually raise the cap: `upgradeTierForLimit` returns null
    // for an operator/per-user OVERRIDE (a cap that differs from the tier
    // default) and for a rider already on the top qualifying tier. Without this
    // gate a Pro/Premium rider under a finite override — or an anonymous viewer
    // under an override like z5 — would hit a dead-end "Limit reached" modal
    // whose copy wrongly claims Pro adds detail.
    // Operator kill switch for hazards on `/explore`. This surface has its OWN
    // hazard pipeline — REST fetch, WebSocket subscription and layer visibility
    // — and does NOT use `useViewportHazards`, so gating that hook does nothing
    // here. Deriving the effective flag once means all three inherit it: the
    // fetch effect clears the pins it already holds, the socket effect
    // unsubscribes, and the layers hide.
    const { enabled: hazardAlertsEnabled } =
      useFeatureKillSwitch("hazard_alerts");
    const showHazards = showHazardsProp && hazardAlertsEnabled;

    const { tier } = useEntitlements();
    const { limit: qualityZoomLimit, isResolved: qualityZoomResolved } =
      useRoadQualityZoomCap();
    const qualityCapFinite =
      qualityZoomResolved &&
      qualityZoomLimit !== null &&
      upgradeTierForLimit(
        "road_quality_max_zoom",
        tier ?? "free",
        qualityZoomLimit,
      ) !== null;
    const qualityCap = qualityZoomLimit ?? 0;
    // The exclusive zoom above which the quality overlay is not rendered (the
    // same clamp MapCanvas applies). Explore road SELECTION must respect it too:
    // the hit layer is uncapped (for planner snapping), so without this a capped
    // Free/anonymous visitor could click an invisible road past the cap and pull
    // its exact quality_score/provenance/history via getSegmentDetail — the very
    // data the hidden overlay gates.
    const qualityMaxZoom = resolveQualityLayerMaxZoom(
      qualityZoomLimit,
      qualityZoomResolved,
    );
    const [zoomUpgradeOpen, setZoomUpgradeOpen] = useState(false);
    const [zoomUpgradeDismissed, setZoomUpgradeDismissed] = useState(false);
    const handleRef = useRef<MapCanvasHandle>(null);
    // Fun Zone draw-region control (installed once at ready). `drawnRegionCbRef`
    // keeps the latest `onDrawnRegionChange` so the once-run control closure
    // never fires a stale callback.
    const drawRef = useRef<RegionDrawControl | null>(null);
    const drawnRegionCbRef = useRef(onDrawnRegionChange);
    useEffect(() => {
      drawnRegionCbRef.current = onDrawnRegionChange;
    }, [onDrawnRegionChange]);
    // Latest fetched conditions, so ready-time click handlers and the
    // imperative focus method resolve a feature id → full DTO.
    const closuresRef = useRef<readonly PlannerClosure[]>([]);
    const passesRef = useRef<readonly MountainPass[]>([]);
    // The condition a row tap just flew the map to. The reconcile won't close
    // this one even when the settled destination list lacks it — that list can
    // be a <30s-fresh cache predating the tapped row, so `loading === false`
    // doesn't guarantee it contains the item. Cleared on the next user-driven
    // map move (a real pan-away), after which the normal "gone → close" applies.
    const pinnedConditionRef = useRef<{
      kind: "closure" | "pass";
      id: string;
    } | null>(null);
    // Previous fetching state per list, to detect a fetch *completing*
    // (true → false) — the point at which absence of the pinned item is
    // authoritative rather than a pre-refetch stale read.
    const prevFetchingRef = useRef({ closures: false, passes: false });
    const queryClient = useQueryClient();

    useImperativeHandle(
      ref,
      () => ({
        flyTo(target) {
          const map = handleRef.current?.map;
          if (!map) return;
          // A deliberate navigate-away (e.g. address search), not a fly to the
          // pinned condition — release the pin so its popover reconciles/closes
          // normally at the destination instead of lingering over a new area.
          pinnedConditionRef.current = null;
          map.flyTo({
            center: [target.lng, target.lat],
            zoom: target.zoom,
            essential: true,
          });
        },
        startDrawRegion() {
          drawRef.current?.start();
        },
        cancelDrawRegion() {
          drawRef.current?.cancel();
        },
        clearDrawnRegion() {
          drawRef.current?.clearDrawn();
        },
        openConditionPopover(conditionRef) {
          const map = handleRef.current?.map;
          if (!map) return;
          let point: MapPoint;
          let lng: number;
          let lat: number;
          if (conditionRef.kind === "closure") {
            const closure = closuresRef.current.find(
              (c) => c.id === conditionRef.id,
            );
            const anchor = closure?.geometry[0];
            if (!closure || !anchor) return;
            lng = anchor.lng;
            lat = anchor.lat;
            // No route on the explorer — conditions are always info-only.
            point = { kind: "closure", closure, affectsRoute: false };
          } else {
            const pass = passesRef.current.find(
              (p) => p.id === conditionRef.id,
            );
            // The explorer shows every pass as a marker (incl. open), so any
            // listed pass can be focused.
            if (!pass) return;
            lng = pass.lng;
            lat = pass.lat;
            point = { kind: "pass", pass, affectsRoute: false };
          }
          const rect = map.getCanvas()?.getBoundingClientRect?.();
          const projected =
            typeof map.project === "function" ? map.project([lng, lat]) : null;
          setPointMenu({
            point,
            lng,
            lat,
            x:
              rect && projected
                ? rect.left + projected.x + 10
                : (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
            y:
              rect && projected
                ? rect.top + projected.y + 10
                : (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
          });
          // Pin this condition: the fly may land on a viewport whose cached
          // list predates it, so the reconcile must not close it until the
          // rider actually pans away (see `pinnedConditionRef`).
          pinnedConditionRef.current = {
            kind: conditionRef.kind,
            id: conditionRef.id,
          };
          // The pin keeps the card alive, but the destination list also feeds
          // the markers. A <30s-fresh cache there can omit or outdate this row,
          // so invalidate that list (matches the hook keys `["closures"|
          // "passes", "list", …]`). Default `refetchType: "active"` refetches
          // the current key too — needed when the item is already centred / zoom
          // ≥9 and the fly leaves `conditionBbox` unchanged, so nothing remounts;
          // it's a background refetch (data stays visible), and any new key the
          // fly lands on refetches on mount since it's now stale. Either way the
          // completed fetch feeds the falling-edge close if the row is gone.
          void queryClient.invalidateQueries({
            queryKey: [
              conditionRef.kind === "closure" ? "closures" : "passes",
              "list",
            ],
          });
          if (typeof map.flyTo === "function") {
            map.flyTo({
              center: [lng, lat],
              // Zoom in close enough that the condition and its marker are the
              // focus of the view — zoom 9 left it a distant speck.
              zoom: Math.max(map.getZoom?.() ?? 0, CONDITION_FOCUS_ZOOM),
              duration: 1200,
              essential: true,
            });
          }
        },
      }),
      // `queryClient` is a stable singleton, so this doesn't re-create the
      // handle; it's listed only to satisfy exhaustive-deps.
      [queryClient],
    );
    const [ready, setReady] = useState(false);
    // POI browse layer: the open info popover, a viewport token bumped on
    // `moveend` to refetch, and an id→Poi lookup so a pin click resolves back
    // to the fetched object (features carry only id/category/name/source).
    // The open map-point popover (POI or hazard). `lng`/`lat` drive the
    // re-projection that keeps the card pinned while the map pans.
    const [pointMenu, setPointMenu] = useState<{
      point: MapPoint;
      lng: number;
      lat: number;
      x: number;
      y: number;
    } | null>(null);
    // An open hazard popover outlives the layers it came from: clearing the
    // source, hiding the layers and dropping the listener leave the popover
    // rendered, still showing the killed alert's detail until the rider
    // dismisses it by hand. Close it with the feature.
    //
    // Scoped to hazard points only — a condition or POI popover has nothing to
    // do with this switch and must stay open.
    useEffect(() => {
      if (showHazards) return;
      setPointMenu((current) =>
        current?.point.kind === "hazard" ? null : current,
      );
    }, [showHazards]);

    const [poiViewportToken, setPoiViewportToken] = useState(0);
    const poisByIdRef = useRef(new Map<string, Poi>());
    // One-way latch: once the viewport has yielded any Foursquare-sourced POI,
    // add the required map-level FSQ credit and keep it (mirrors the planner).
    const sawFsqRef = useRef(false);
    const segmentSelectionRef = useRef({
      showQuality,
      showSurface,
      onSegmentSelect,
      qualityMaxZoom,
    });

    const rawHazardsRef = useRef<HazardResponse[]>([]);
    // Tracks when each WS-delivered hazard arrived, so an in-flight REST
    // fetch whose snapshot predates the arrival doesn't overwrite it.
    const wsHazardArrivalRef = useRef<Map<string, number>>(new Map());
    // Tombstone map: id → ms timestamp when a `dismissed` WS event was
    // observed. Passed to mergeHazardsWithInFlightWsArrivals to filter stale
    // REST responses that would otherwise resurrect moderated markers.
    const dismissedTombstonesRef = useRef<Map<string, number>>(new Map());
    const [hazardsRevision, setHazardsRevision] = useState(0);
    const [hazardNow, setHazardNow] = useState(() => Date.now());
    const realtimeStatus = useRealtimeStore((s) => s.status);
    const reconnectRevision = useNetworkReconnectRevision();

    const qualityOpacity = buildQualityOpacityExpression(filters);
    const surfaceOpacity = buildSurfaceOpacityExpression(filters);

    // Ambient conditions: closures + passes for the current viewport bbox,
    // gated on the toggle. Same bbox/date/month the info panel passes, so
    // React Query serves both from one cache entry instead of double-fetching.
    // Wait for a real bbox — a missing bbox is an unbounded list request, so a
    // click during map load would otherwise fetch the whole catalog (the panel
    // shows "pan the map" in that window, so the markers must too).
    const conditionsEnabled = showConditions && conditionBbox != null;
    const {
      closures,
      loading: closuresLoading,
      fetching: closuresFetching = false,
    } = useClosures(conditionsMonth, NO_ROUTES, {
      bbox: conditionBbox ?? undefined,
      previewDate: conditionsDate,
      enabled: conditionsEnabled,
    });
    const {
      passes,
      loading: passesLoading,
      fetching: passesFetching = false,
    } = usePasses(conditionsMonth, NO_ROUTES, {
      bbox: conditionBbox ?? undefined,
      enabled: conditionsEnabled,
    });

    useEffect(() => {
      segmentSelectionRef.current = {
        showQuality,
        showSurface,
        onSegmentSelect,
        qualityMaxZoom,
      };
    }, [showQuality, showSurface, onSegmentSelect, qualityMaxZoom]);

    // The `moveend` handler only re-checks the zoom prompt when the rider moves
    // the map. But the quality layer can also cross above the cap without a
    // move: the overlay is toggled on while already zoomed in, or the async
    // entitlement request resolves to a finite cap after the last `moveend`. In
    // those transitions the layer clamps silently. Re-evaluate the CURRENT zoom
    // whenever the inputs change so the upgrade prompt opens without a nudge.
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!ready || !map) return;
      if (
        shouldPromptQualityZoom({
          showQuality,
          capFinite: qualityCapFinite,
          zoom: readMapView(map).zoom,
          cap: qualityCap,
          dismissed: zoomUpgradeDismissed,
        })
      ) {
        setZoomUpgradeOpen(true);
      }
    }, [
      ready,
      showQuality,
      qualityCapFinite,
      qualityCap,
      zoomUpgradeDismissed,
    ]);

    const handleReady = (map: MapLibreMap) => {
      // Capture the base style's first symbol layer BEFORE we append our own
      // symbol layers below — otherwise, on a style with no base symbols,
      // `firstSymbolLayerId` would return one of ours and slot the aerial raster
      // above our overlays instead of falling back to the quality layer.
      const baseSymbolLayerId = firstSymbolLayerId(map);
      // Fun Zone polygons go in first: broad fills belong under every
      // marker/route layer added below.
      installFunZoneLayer(map);
      setFunZoneLayersVisible(map, showFunZones);
      // Fun Zone draw-region box: the rider arms it from the sidebar
      // ("Draw region"), then drags on the map. Its bbox constrains the
      // zone fetch (page effect). Reuses the planner's control verbatim.
      drawRef.current = createRegionDrawControl(map, {
        onRegionDrawn: (bbox) => drawnRegionCbRef.current?.(bbox),
        onRegionCleared: () => drawnRegionCbRef.current?.(null),
      });
      ensureHazardLayers(map, { visible: showHazards });
      ensureConditionLayers(map, undefined, { includeOpenPasses: true });
      setConditionLayersVisible(map, showConditions);
      ensurePoiLayers(map);
      // "My trips" / "My rides" route lines, slotted UNDER the markers (before
      // the first hazard layer) so a marker on a route still owns the click.
      ensureRideRouteLayers(map, {
        visible: showMyRides,
        beforeId: HAZARD_CLUSTERS,
      });
      ensureTripRouteLayers(map, {
        visible: showMyTrips,
        beforeId: HAZARD_CLUSTERS,
      });

      // ── One click router ──
      // MapLibre fires every overlapping layer's click handler, so the topmost
      // marker used to need a manual "is a higher layer also hit?" guard. Here
      // a single router picks the topmost interactive layer under the cursor;
      // routes are listed topmost-first (render order POI > conditions >
      // hazards), and a click that hits no marker falls through to `onMiss`
      // (dismiss the popover, then try to select a road segment).
      const openHazard = (feature: MapGeoJSONFeature, e: MapMouseEvent) => {
        const props = feature.properties as HazardProps | null;
        if (!props?.hazard_type || feature.geometry.type !== "Point") return;
        const [lng, lat] = feature.geometry.coordinates as [number, number];
        setPointMenu({
          point: { kind: "hazard", hazard: props },
          lng,
          lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      };
      const openClosure = (feature: MapGeoJSONFeature, e: MapMouseEvent) => {
        const id = feature.properties?.id as string | undefined;
        const closure = id
          ? closuresRef.current.find((c) => c.id === id)
          : undefined;
        if (!closure) return;
        const anchor = closure.geometry[0];
        setPointMenu({
          point: { kind: "closure", closure, affectsRoute: false },
          lng: anchor?.lng ?? e.lngLat.lng,
          lat: anchor?.lat ?? e.lngLat.lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      };
      const openPass = (feature: MapGeoJSONFeature, e: MapMouseEvent) => {
        const id = feature.properties?.id as string | undefined;
        const pass = id
          ? passesRef.current.find((p) => p.id === id)
          : undefined;
        if (!pass) return;
        setPointMenu({
          point: { kind: "pass", pass, affectsRoute: false },
          lng: pass.lng,
          lat: pass.lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      };
      const openPoi = (feature: MapGeoJSONFeature, e: MapMouseEvent) => {
        const poiId = (feature.properties as { poiId?: string } | undefined)
          ?.poiId;
        const poi = poiId ? poisByIdRef.current.get(poiId) : undefined;
        if (!poi) return;
        setPointMenu({
          point: { kind: "poi", poi },
          lng: poi.lng,
          lat: poi.lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      };
      const expandPoiCluster = (feature: MapGeoJSONFeature) => {
        // Zooming into a cluster is a deliberate navigate-away (a programmatic
        // easeTo with no originalEvent), so release any flown-to condition pin.
        pinnedConditionRef.current = null;
        const clusterId = feature.properties?.cluster_id as number | undefined;
        const src = map.getSource(POI_SOURCE) as GeoJSONSource | undefined;
        if (clusterId == null || !src) return;
        src
          .getClusterExpansionZoom(clusterId)
          .then((expZoom) => {
            if (feature.geometry.type !== "Point") return;
            map.easeTo({
              center: feature.geometry.coordinates as [number, number],
              zoom: expZoom,
            });
          })
          .catch(() => {
            // Cluster may have been superseded by a refetch; drop the zoom-in.
          });
      };
      // Basemap (OpenStreetMap) POIs — the style's own parking/park/info icons.
      // Lowest priority: our markers (router routes) win, then a named basemap
      // POI, then the road beneath it. Visible + clickable on both basemaps —
      // the aerial raster is slotted below the labels/POIs.
      const basemapPoiLayers = getBasemapPoiLayerIds(map);
      const selectSegmentAt = (e: MapMouseEvent) => {
        const place = topBasemapPlaceAt(map, e.point, basemapPoiLayers);
        if (place) {
          setPointMenu({
            point: { kind: "place", place },
            lng: place.lng,
            lat: place.lat,
            x: e.originalEvent.clientX,
            y: e.originalEvent.clientY,
          });
          return;
        }
        // A non-marker click dismisses an open popover, then tries the road.
        setPointMenu(null);
        const {
          showQuality,
          showSurface,
          onSegmentSelect: selectSegment,
          qualityMaxZoom: capExclusiveZoom,
        } = segmentSelectionRef.current;
        if (!selectSegment) return;
        // The detail drawer is road-QUALITY intelligence, so selection through
        // EITHER overlay is entitlement-gated: the hit layers are uncapped (so
        // planner snapping survives the cap), but Explore must not let a capped
        // visitor open the drawer where the quality overlay is hidden. Gate BOTH
        // the quality and surface hit tests at the resolved cap.
        const zoom = map.getZoom();
        const canSelectQuality = canSelectRoadAtZoom(
          showQuality,
          zoom,
          capExclusiveZoom,
        );
        const canSelectSurface = canSelectRoadAtZoom(
          showSurface,
          zoom,
          capExclusiveZoom,
        );
        const layers = [
          ...(canSelectQuality ? [TARMOTO_ROAD_HIT_LAYER] : []),
          ...(canSelectSurface ? [TARMOTO_SURFACE_LAYER] : []),
        ].filter((id) => map.getLayer(id));
        if (layers.length === 0) return;
        // Hit-test a small box around the tap, not the exact pixel, so the thin
        // quality/surface lines are comfortable to click; the closest feature
        // to the tap wins so a near-miss doesn't grab a parallel road.
        const feature = pickNearestLineFeature(
          map,
          e.point,
          layers,
          SEGMENT_HIT_PADDING_PX,
        );
        const segmentId = readSegmentId(feature);
        if (segmentId) selectSegment(segmentId);
      };
      installPointClickRouter(map, {
        routes: [
          { layers: [POI_PIN_LAYER], handle: openPoi },
          { layers: [POI_CLUSTER_LAYER], handle: (f) => expandPoiCluster(f) },
          // Pass markers are painted after closures (ensureConditionLayers), so
          // a pass badge sits visually on top — click priority must match.
          { layers: [PASS_MARKER_LAYER], handle: openPass },
          { layers: [CLOSURE_MARKER_LAYER], handle: openClosure },
          { layers: [HAZARD_BG], handle: openHazard },
          {
            layers: [HAZARD_CLUSTERS],
            handle: (f) => {
              // Same as the POI cluster: a programmatic zoom-in navigate-away,
              // so drop any flown-to condition pin.
              pinnedConditionRef.current = null;
              expandHazardCluster(map, f);
            },
          },
          // Route lines are below the markers, so they're listed last — a
          // marker sitting on a route still wins the click.
          {
            layers: [TRIP_ROUTE_LAYER],
            handle: (f) => {
              const tripId = f.properties?.tripId;
              if (typeof tripId !== "string") return;
              // The route owns this click (not `onMiss`), so dismiss any open
              // point popover ourselves before opening the trip drawer.
              setPointMenu(null);
              onTripSelect(tripId);
            },
          },
          {
            layers: [RIDE_ROUTE_LAYER],
            handle: (f) => {
              const rideId = f.properties?.rideId;
              if (typeof rideId !== "string") return;
              setPointMenu(null);
              onRideSelect(rideId);
            },
          },
          // Zone fills are the broadest (and lowest-priority) click target.
          // A road under the cursor wins first, so segments inside a zone
          // stay selectable while the overlay is on; open zone ground opens
          // the zone panel.
          {
            layers: [FUN_ZONES_FILL],
            handle: (f, e) => {
              const {
                showQuality,
                showSurface,
                onSegmentSelect: selectSegment,
                qualityMaxZoom: capExclusiveZoom,
              } = segmentSelectionRef.current;
              // Same entitlement gate as the road-miss path: road-detail
              // selection through EITHER overlay only below the cap.
              const zoom = map.getZoom();
              const canSelectQuality = canSelectRoadAtZoom(
                showQuality,
                zoom,
                capExclusiveZoom,
              );
              const canSelectSurface = canSelectRoadAtZoom(
                showSurface,
                zoom,
                capExclusiveZoom,
              );
              const segmentLayers = [
                ...(canSelectQuality ? [TARMOTO_ROAD_HIT_LAYER] : []),
                ...(canSelectSurface ? [TARMOTO_SURFACE_LAYER] : []),
              ].filter((id) => map.getLayer(id));
              if (selectSegment && segmentLayers.length > 0) {
                const feature = pickNearestLineFeature(
                  map,
                  e.point,
                  segmentLayers,
                  SEGMENT_HIT_PADDING_PX,
                );
                const segmentId = readSegmentId(feature);
                if (segmentId) {
                  setPointMenu(null);
                  selectSegment(segmentId);
                  return;
                }
              }
              // A named base-map POI under the cursor also wins — its place
              // popover normally opens via `onMiss`, which this route would
              // otherwise pre-empt inside zones.
              const place = topBasemapPlaceAt(map, e.point, basemapPoiLayers);
              if (place) {
                setPointMenu({
                  point: { kind: "place", place },
                  lng: place.lng,
                  lat: place.lat,
                  x: e.originalEvent.clientX,
                  y: e.originalEvent.clientY,
                });
                return;
              }
              const zoneId = f.properties?.id;
              if (typeof zoneId !== "string") return;
              setPointMenu(null);
              onFunZoneSelect(zoneId);
            },
          },
        ],
        onMiss: selectSegmentAt,
      });

      const setPointer = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const unsetPointer = () => {
        map.getCanvas().style.cursor = "";
      };
      for (const id of [
        HAZARD_BG,
        HAZARD_CLUSTERS,
        POI_PIN_LAYER,
        POI_CLUSTER_LAYER,
        CLOSURE_MARKER_LAYER,
        PASS_MARKER_LAYER,
        TRIP_ROUTE_LAYER,
        RIDE_ROUTE_LAYER,
        FUN_ZONES_FILL,
      ]) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }
      for (const id of basemapPoiLayers) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }
      for (const id of [TARMOTO_ROAD_HIT_LAYER, TARMOTO_SURFACE_LAYER]) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }

      // Aerial imagery basemap, slotted below the base labels + OSM POI icons
      // (which stay visible over the imagery) and below our overlays. Hidden
      // until toggled.
      ensureAerialBasemap(map, baseSymbolLayerId ?? TARMOTO_QUALITY_LAYER);
      setAerialBasemapVisible(map, basemap === "aerial");

      setReady(true);
      onViewChange?.(readMapView(map));
    };

    const handleViewChange = (view: MapCanvasViewChange) => {
      onViewChange?.(view);
      // Refetch POIs for the new viewport (debounced in the effect below).
      setPoiViewportToken((token) => token + 1);
      if (
        shouldPromptQualityZoom({
          showQuality,
          capFinite: qualityCapFinite,
          zoom: view.zoom,
          cap: qualityCap,
          dismissed: zoomUpgradeDismissed,
        })
      ) {
        setZoomUpgradeOpen(true);
      }
    };

    // ── category-POI viewport fetch ──
    // Sorted, stable key so toggling categories (a new Set each time) drives
    // the effect without an unstable array dep.
    const poiCategoriesKey = poiCategories
      ? [...poiCategories].sort().join(",")
      : "";
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      const categories = (
        poiCategoriesKey ? poiCategoriesKey.split(",") : []
      ) as PoiCategory[];
      if (categories.length === 0) {
        poisByIdRef.current = new Map();
        setPoiSourceData(map, []);
        // Only dismiss a POI popover; a hazard popover is independent of POI data.
        setPointMenu((menu) => (menu?.point.kind === "poi" ? null : menu));
        return;
      }
      let cancelled = false;
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        const b = map.getBounds();
        const west = b.getWest();
        const east = b.getEast();
        const south = b.getSouth();
        const north = b.getNorth();
        // `/poi/in-bbox` needs a single in-range, non-inverted box. A viewport
        // zoomed far out (bounds past ±180/±90) or wrapped across the
        // antimeridian (e.g. west=170/east=190, or west ≥ east) would otherwise
        // 400 or fetch only a partial slice — clear and skip rather than
        // present partial/stale results. (Clamping wouldn't help: 170..190
        // clamps to 170..180 and silently drops the -180..-170 half.)
        if (
          west < -180 ||
          east > 180 ||
          south < -90 ||
          north > 90 ||
          west >= east ||
          south >= north
        ) {
          poisByIdRef.current = new Map();
          setPoiSourceData(map, []);
          // Only dismiss a POI popover; a hazard popover is independent of POI data.
          setPointMenu((menu) => (menu?.point.kind === "poi" ? null : menu));
          return;
        }
        const bbox: [number, number, number, number] = [
          west,
          south,
          east,
          north,
        ];
        plannerApi
          .getPoisByCategories(bbox, categories, poiMonth, {
            signal: controller.signal,
          })
          .then((pois) => {
            if (cancelled) return;
            poisByIdRef.current = new Map(pois.map((poi) => [poi.id, poi]));
            setPoiSourceData(map, pois);
            // Reconcile an open POI popover with the fresh list: refresh its
            // POI object (e.g. new seasonal status), or close it if that POI is
            // no longer in the active/visible set. Hazard popovers are left be.
            setPointMenu((menu) => {
              if (!menu || menu.point.kind !== "poi") return menu;
              const fresh = poisByIdRef.current.get(menu.point.poi.id);
              return fresh
                ? { ...menu, point: { kind: "poi", poi: fresh } }
                : null;
            });
            // ODbL/attribution: the source declares OSM, but FSQ rows need the
            // Foursquare map credit too. Latch it on once seen (#869).
            if (
              !sawFsqRef.current &&
              pois.some((poi) => poi.source === "fsq")
            ) {
              sawFsqRef.current = true;
              handleRef.current?.setPoiAttribution([FSQ_ATTRIBUTION]);
            }
          })
          .catch((err: unknown) => {
            // A superseded viewport/category aborts the request — that's
            // expected, so keep the current pins for the newer fetch.
            if (cancelled || (err as { name?: string }).name === "AbortError") {
              return;
            }
            // A real failure: clear rather than pass the previous viewport's
            // pins off as the current result, and surface it.
            console.error("Failed to load POIs for the viewport", err);
            poisByIdRef.current = new Map();
            setPoiSourceData(map, []);
            // Only dismiss a POI popover; a hazard popover is independent of POI data.
            setPointMenu((menu) => (menu?.point.kind === "poi" ? null : menu));
          });
      }, POI_FETCH_DEBOUNCE_MS);
      return () => {
        cancelled = true;
        controller.abort();
        window.clearTimeout(timer);
      };
    }, [ready, poiCategoriesKey, poiMonth, poiViewportToken]);

    // ── aerial basemap visibility ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setAerialBasemapVisible(map, basemap === "aerial");
    }, [basemap, ready]);

    // ── keep the point popover locked to its pin while the map pans/zooms ──
    // Re-project the point's lng/lat to screen coords on every `move` (mirrors
    // the planner), so the fixed-position card tracks its pin instead of
    // hovering at stale coordinates.
    const pointMenuOpen = pointMenu !== null;
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready || !pointMenuOpen) return;
      const reposition = () => {
        const rect = map.getCanvas()?.getBoundingClientRect?.();
        if (!rect) return;
        setPointMenu((menu) => {
          if (!menu) return menu;
          const projected = map.project([menu.lng, menu.lat]);
          return {
            ...menu,
            x: rect.left + projected.x + 10,
            y: rect.top + projected.y + 10,
          };
        });
      };
      map.on("move", reposition);
      return () => {
        map.off("move", reposition);
      };
    }, [ready, pointMenuOpen]);

    // ── release a flown-to condition pin once the rider drives the map ──
    // A user-initiated move carries `originalEvent`; the row-tap `flyTo` does
    // not. Clearing on the former means a real pan-away lets the reconcile close
    // the popover normally, while the programmatic fly keeps it pinned.
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      const releasePin = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) pinnedConditionRef.current = null;
      };
      map.on("moveend", releasePin);
      return () => {
        map.off("moveend", releasePin);
      };
    }, [ready]);

    // ── project raw hazards → filtered GeoJSON source ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setHazardSourceData(
        map,
        selectHazards(rawHazardsRef.current, filters.hazardTypes),
        hazardNow,
      );
    }, [ready, filters.hazardTypes, hazardsRevision, hazardNow]);

    // ── keep fade-opacity live while the map is open ──
    useEffect(() => {
      if (!ready || !showHazards) return;
      if (rawHazardsRef.current.length === 0) return;
      const id = window.setInterval(() => setHazardNow(Date.now()), 60_000);
      return () => window.clearInterval(id);
    }, [ready, showHazards, hazardsRevision]);

    // ── hazard layer visibility ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setHazardLayersVisible(map, showHazards);
    }, [ready, showHazards]);

    // ── conditions: keep refs + sources in sync with the fetched lists ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      closuresRef.current = closures;
      passesRef.current = passes;
      setConditionSourceData(map, { closures, passes });
      // Reconcile the open condition popover against the fresh lists — refresh
      // its DTO, keep it (still loading, or the pinned row we flew to), or close
      // it if genuinely gone. Policy lives in `reconcileConditionMenu` so it can
      // be unit tested without the map.
      const pinned = pinnedConditionRef.current;
      setPointMenu((menu) => {
        if (!menu) return menu;
        const action = reconcileConditionMenu(menu.point, {
          closures,
          passes,
          closuresLoading,
          passesLoading,
          pinned,
        });
        if (action.type === "keep") return menu;
        if (action.type === "close") return null;
        return { ...menu, point: action.point };
      });
    }, [ready, closures, passes, closuresLoading, passesLoading]);

    // ── retire a pinned popover once a completed fetch still lacks it ──
    // The pin bridges a row-fly over a stale destination cache, but it must not
    // hold forever: if the row came from a stale list, or the closure/pass was
    // deleted/expired, fresh data will settle without it. Act on the fetch's
    // falling edge (was fetching → now idle) so this fires only on a *completed*
    // fetch — the pre-refetch stale frame (idle + stale) can't trip it — and
    // close the pinned card so it doesn't linger over a marker-less viewport.
    useEffect(() => {
      const prev = prevFetchingRef.current;
      const closuresSettled = prev.closures && !closuresFetching;
      const passesSettled = prev.passes && !passesFetching;
      prevFetchingRef.current = {
        closures: closuresFetching,
        passes: passesFetching,
      };
      const pin = pinnedConditionRef.current;
      if (!pin) return;
      if (
        !pinnedConditionRetired(pin, {
          closures,
          passes,
          closuresSettled,
          passesSettled,
        })
      ) {
        return;
      }
      pinnedConditionRef.current = null;
      setPointMenu((menu) => {
        if (!menu) return menu;
        if (pin.kind === "closure") {
          return menu.point.kind === "closure" &&
            menu.point.closure.id === pin.id
            ? null
            : menu;
        }
        return menu.point.kind === "pass" && menu.point.pass.id === pin.id
          ? null
          : menu;
      });
    }, [closuresFetching, passesFetching, closures, passes]);

    // ── close a condition popover when its own date/month input changes ──
    // The reconcile above defers while its query reloads so a viewport pan/fly
    // doesn't drop the popover on the transient empty frame. But a preview-date
    // change (closures) or travel-month change (passes) also reloads the query,
    // and there the open card is now for the wrong date/month — deferring would
    // render stale details as current until the refetch lands. A closure is
    // date-specific and a pass is month-specific, so drop the matching popover
    // on that input change and let the rider re-open it against the new data.
    useEffect(() => {
      setPointMenu((menu) => (menu?.point.kind === "closure" ? null : menu));
    }, [conditionsDate]);
    useEffect(() => {
      setPointMenu((menu) => (menu?.point.kind === "pass" ? null : menu));
    }, [conditionsMonth]);

    // ── condition layer visibility ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setConditionLayersVisible(map, showConditions);
      // Only dismiss a condition popover; POI/hazard popovers are independent.
      if (!showConditions) {
        setPointMenu((menu) =>
          menu?.point.kind === "closure" || menu?.point.kind === "pass"
            ? null
            : menu,
        );
      }
    }, [ready, showConditions]);

    // ── "My trips" route overlay: keep the source + visibility in sync ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setTripRouteSourceData(map, trips);
    }, [ready, trips]);
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setTripRouteLayersVisible(map, showMyTrips);
    }, [ready, showMyTrips]);

    // ── "My rides" route overlay: keep the source + visibility in sync ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setRideRouteSourceData(map, rideTracks);
    }, [ready, rideTracks]);
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setRideRouteLayersVisible(map, showMyRides);
    }, [ready, showMyRides]);

    // ── Fun Zones overlay: keep data, visibility, and selection in sync ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      updateFunZoneLayerData(map, [...funZones]);
    }, [ready, funZones]);
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setFunZoneLayersVisible(map, showFunZones);
    }, [ready, showFunZones]);
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;
      setFunZoneSelection(map, selectedFunZoneId);
    }, [ready, selectedFunZoneId]);

    // ── fetch hazards when viewport settles ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (!map || !ready) return;

      if (!showHazards || zoom < HAZARD_MIN_ZOOM) {
        if (rawHazardsRef.current.length > 0) {
          rawHazardsRef.current = [];
          wsHazardArrivalRef.current.clear();
          setHazardsRevision((r) => r + 1);
        } else {
          setHazardSourceData(map, [], Date.now());
        }
        return;
      }

      let cancelled = false;
      const controller = new AbortController();
      const timer = window.setTimeout(async () => {
        const fetchStartedAt = Date.now();
        try {
          const radius = viewportRadiusMeters(map);
          const { data } = await hazardsApi.findNearby(
            { lat: center.lat, lng: center.lng, radius },
            { signal: controller.signal },
          );
          if (cancelled) return;
          rawHazardsRef.current = mergeHazardsWithInFlightWsArrivals(
            data,
            rawHazardsRef.current,
            wsHazardArrivalRef.current,
            fetchStartedAt,
            dismissedTombstonesRef.current,
          );
          setHazardsRevision((r) => r + 1);
        } catch (err) {
          if ((err as { name?: string }).name === "AbortError") return;
          console.warn("[explore] hazards fetch failed", err);
        }
      }, HAZARD_FETCH_DEBOUNCE_MS);

      return () => {
        cancelled = true;
        window.clearTimeout(timer);
        controller.abort();
      };
    }, [ready, showHazards, center.lat, center.lng, zoom, reconnectRevision]);

    // ── real-time: subscribe to hazards in viewport + merge incoming events ──
    useEffect(() => {
      const map = handleRef.current?.map;
      if (
        !map ||
        !ready ||
        !showHazards ||
        zoom < HAZARD_MIN_ZOOM ||
        realtimeStatus !== "connected"
      ) {
        return;
      }

      // Debounce the subscribe emit to match the REST fetch cadence — a rapid
      // pan would otherwise spam subscribe:hazards, forcing the backend to
      // leave/join rooms on every frame when only the final viewport matters.
      const subscribeTimer = window.setTimeout(() => {
        subscribeHazards(center.lat, center.lng, viewportRadiusMeters(map));
      }, HAZARD_FETCH_DEBOUNCE_MS);

      const unsubscribe = onHazardNew((hazard) => {
        const result = applyHazardWsEvent(rawHazardsRef.current, hazard);
        if (result.action === "ignore") return;
        if (result.action === "tombstone") {
          // Hazard wasn't in the local list yet, but admin dismissed it.
          // Record the tombstone so any stale in-flight REST response that
          // returns this id can be filtered before it resurrects the marker.
          dismissedTombstonesRef.current.set(result.dismissedId, Date.now());
          return;
        }
        if (result.action === "remove") {
          // Moderation removal — prune the marker immediately without
          // waiting for the next REST refetch, and tombstone the id so any
          // concurrent in-flight REST fetch can't re-add it.
          rawHazardsRef.current = result.list;
          wsHazardArrivalRef.current.delete(hazard.id);
          dismissedTombstonesRef.current.set(result.dismissedId, Date.now());
          setHazardsRevision((r) => r + 1);
          return;
        }
        // Normal append: deduplicate against the existing list so the
        // viewport REST fetch race doesn't produce duplicate markers.
        wsHazardArrivalRef.current.set(hazard.id, Date.now());
        rawHazardsRef.current = result.list;
        setHazardsRevision((r) => r + 1);
      });

      return () => {
        window.clearTimeout(subscribeTimer);
        unsubscribe();
      };
    }, [ready, showHazards, realtimeStatus, center.lat, center.lng, zoom]);

    return (
      <>
        <MapCanvas
          ref={handleRef}
          center={center}
          zoom={zoom}
          showQuality={showQuality}
          showSurface={showSurface}
          selectedSegmentId={selectedSegmentId ?? null}
          qualityOpacityExpression={qualityOpacity}
          surfaceOpacityExpression={surfaceOpacity}
          onReady={handleReady}
          onViewChange={handleViewChange}
        >
          {pointMenu ? (
            <MapPointPopover
              point={pointMenu.point}
              x={pointMenu.x}
              y={pointMenu.y}
              onClose={() => {
                // Dismissing the card also drops any condition pin, so a later
                // settle can't treat it as still-pinned.
                pinnedConditionRef.current = null;
                setPointMenu(null);
              }}
            />
          ) : null}
        </MapCanvas>
        {zoomUpgradeOpen ? (
          <UpgradePrompt
            variant="modal"
            capability={{
              limit: "road_quality_max_zoom",
              resolvedLimit: qualityZoomLimit,
            }}
            // Anonymous public viewers have no `/users/me` tier, but the modal
            // only opens on a FINITE cap (free — see `qualityCapFinite`), so
            // fall back to `free`: the CTA then routes to sign-in/upgrade rather
            // than leaving a capped logged-out viewer with no path forward.
            currentTier={tier ?? "free"}
            message={t(
              "Zoom in further for full road-quality detail with Pro.",
            )}
            onClose={() => {
              setZoomUpgradeOpen(false);
              setZoomUpgradeDismissed(true);
            }}
          />
        ) : null}
      </>
    );
  },
);

// ── expression helpers ──

function buildQualityOpacityExpression(
  filters: MapFilters,
): ExpressionSpecification {
  const qualityMatch: ExpressionSpecification = [
    "case",
    [">=", ["coalesce", ["get", "quality_score"], 0], 4.5],
    filters.quality.has("excellent") ? true : false,
    [">=", ["coalesce", ["get", "quality_score"], 0], 3.5],
    filters.quality.has("good") ? true : false,
    [">=", ["coalesce", ["get", "quality_score"], 0], 2.5],
    filters.quality.has("fair") ? true : false,
    [">=", ["coalesce", ["get", "quality_score"], 0], 1.5],
    filters.quality.has("poor") ? true : false,
    filters.quality.has("very-poor") ? true : false,
  ];

  const surfaceValues = FILTERABLE_SURFACES.filter((s) =>
    filters.surface.has(s),
  );
  const surfaceMatch: ExpressionSpecification = [
    "any",
    ["==", ["coalesce", ["get", "surface_type"], "unknown"], "unknown"],
    [
      "in",
      ["coalesce", ["get", "surface_type"], "unknown"],
      ["literal", surfaceValues],
    ],
  ];

  return [
    "case",
    ["all", qualityMatch, surfaceMatch],
    ACTIVE_OPACITY,
    DIMMED_OPACITY,
  ] as ExpressionSpecification;
}

function buildSurfaceOpacityExpression(
  filters: MapFilters,
): ExpressionSpecification {
  const surfaceValues = FILTERABLE_SURFACES.filter((s) =>
    filters.surface.has(s),
  );
  const surfaceMatch: ExpressionSpecification = [
    "any",
    ["==", ["coalesce", ["get", "surface_type"], "unknown"], "unknown"],
    [
      "in",
      ["coalesce", ["get", "surface_type"], "unknown"],
      ["literal", surfaceValues],
    ],
  ];
  return [
    "case",
    ["all", surfaceMatch],
    0.75,
    DIMMED_OPACITY,
  ] as ExpressionSpecification;
}

function viewportRadiusMeters(map: MapLibreMap): number {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const diagonal = Math.max(
    haversineMeters(center.lat, center.lng, ne.lat, ne.lng),
    haversineMeters(center.lat, center.lng, sw.lat, sw.lng),
  );
  return Math.max(
    HAZARD_MIN_RADIUS_M,
    Math.min(HAZARD_MAX_RADIUS_M, Math.round(diagonal)),
  );
}
