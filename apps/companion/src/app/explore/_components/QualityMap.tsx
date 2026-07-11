"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
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
  TARMOTO_SURFACE_LAYER,
  type MapCanvasHandle,
  type MapCanvasViewChange,
} from "@/components/map/MapCanvas";
import {
  ensureAerialBasemap,
  setAerialBasemapVisible,
} from "@/components/map/AerialBasemap";
import { FSQ_ATTRIBUTION } from "@/components/map/attribution";
import { hazardsApi, type HazardResponse } from "@/lib/api";
import { onHazardNew, subscribeHazards } from "@/lib/socket";
import {
  applyHazardWsEvent,
  mergeHazardsWithInFlightWsArrivals,
} from "@/lib/hazard-merge";
import { useRealtimeStore } from "@/stores/realtime";
import { haversineMeters } from "@tarmoto/shared";
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
  HAZARD_ICON,
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
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import type {
  PlannerClosure,
  PlannerClosureRoute,
} from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import { plannerApi } from "@/lib/planner/api";
import type { Poi, PoiCategory } from "@/lib/planner/types";

// Stable empty route list — the explorer never checks conditions against a
// route, so both hooks always fetch the viewport-only (regional) list.
const NO_ROUTES: PlannerClosureRoute[] = [];

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

const POI_FETCH_DEBOUNCE_MS = 300;

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
      showHazards,
      showConditions,
      conditionBbox,
      conditionsMonth,
      conditionsDate,
      onSegmentSelect,
      selectedSegmentId,
      onViewChange,
    },
    ref,
  ) {
    const handleRef = useRef<MapCanvasHandle>(null);
    // Latest fetched conditions, so ready-time click handlers and the
    // imperative focus method resolve a feature id → full DTO.
    const closuresRef = useRef<readonly PlannerClosure[]>([]);
    const passesRef = useRef<readonly MountainPass[]>([]);

    useImperativeHandle(
      ref,
      () => ({
        flyTo(target) {
          const map = handleRef.current?.map;
          if (!map) return;
          map.flyTo({
            center: [target.lng, target.lat],
            zoom: target.zoom,
            essential: true,
          });
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
            // Open passes are filtered out of the marker layer — there is no
            // pin to focus, so decline rather than float a popover over nothing.
            if (!pass || pass.status === "open") return;
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
          if (typeof map.flyTo === "function") {
            map.flyTo({
              center: [lng, lat],
              zoom: Math.max(map.getZoom?.() ?? 0, 9),
              duration: 1200,
              essential: true,
            });
          }
        },
      }),
      [],
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
    const [poiViewportToken, setPoiViewportToken] = useState(0);
    const poisByIdRef = useRef(new Map<string, Poi>());
    // One-way latch: once the viewport has yielded any Foursquare-sourced POI,
    // add the required map-level FSQ credit and keep it (mirrors the planner).
    const sawFsqRef = useRef(false);
    const segmentSelectionRef = useRef({
      showQuality,
      showSurface,
      onSegmentSelect,
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
    const { closures } = useClosures(conditionsMonth, NO_ROUTES, {
      bbox: conditionBbox ?? undefined,
      previewDate: conditionsDate,
      enabled: conditionsEnabled,
    });
    const { passes } = usePasses(conditionsMonth, NO_ROUTES, {
      bbox: conditionBbox ?? undefined,
      enabled: conditionsEnabled,
    });

    useEffect(() => {
      segmentSelectionRef.current = {
        showQuality,
        showSurface,
        onSegmentSelect,
      };
    }, [showQuality, showSurface, onSegmentSelect]);

    const handleReady = (map: MapLibreMap) => {
      ensureHazardLayers(map, { visible: showHazards });
      ensureConditionLayers(map);
      setConditionLayersVisible(map, showConditions);
      ensurePoiLayers(map);

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
      const selectSegmentAt = (e: MapMouseEvent) => {
        // A non-marker click dismisses an open popover, then tries the road.
        setPointMenu(null);
        const {
          showQuality: canSelectQuality,
          showSurface: canSelectSurface,
          onSegmentSelect: selectSegment,
        } = segmentSelectionRef.current;
        if (!selectSegment) return;
        const layers = [
          ...(canSelectQuality ? [TARMOTO_QUALITY_LAYER] : []),
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
          { layers: [CLOSURE_MARKER_LAYER], handle: openClosure },
          { layers: [PASS_MARKER_LAYER], handle: openPass },
          { layers: [HAZARD_BG, HAZARD_ICON], handle: openHazard },
          {
            layers: [HAZARD_CLUSTERS],
            handle: (f) => expandHazardCluster(map, f),
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
        HAZARD_ICON,
        HAZARD_CLUSTERS,
        POI_PIN_LAYER,
        POI_CLUSTER_LAYER,
        CLOSURE_MARKER_LAYER,
        PASS_MARKER_LAYER,
      ]) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }
      for (const id of [TARMOTO_QUALITY_LAYER, TARMOTO_SURFACE_LAYER]) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }

      // Aerial imagery basemap, inserted below the quality overlay so the
      // road-quality lines still read on top of it. Hidden until toggled.
      ensureAerialBasemap(map, TARMOTO_QUALITY_LAYER);
      setAerialBasemapVisible(map, basemap === "aerial");

      setReady(true);
      onViewChange?.(readMapView(map));
    };

    const handleViewChange = (view: MapCanvasViewChange) => {
      onViewChange?.(view);
      // Refetch POIs for the new viewport (debounced in the effect below).
      setPoiViewportToken((token) => token + 1);
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
      // Reconcile an open condition popover with the fresh list: refresh its
      // DTO (e.g. a new seasonal status after a month change), or drop it if the
      // condition is gone (panned away / toggled off → []) — or, for a pass,
      // now `open`, since open passes are filtered out of the marker layer and
      // a popover with no marker to anchor would float over empty map.
      setPointMenu((menu) => {
        if (!menu) return menu;
        const point = menu.point;
        if (point.kind === "closure") {
          const fresh = closures.find((c) => c.id === point.closure.id);
          return fresh
            ? {
                ...menu,
                point: { kind: "closure", closure: fresh, affectsRoute: false },
              }
            : null;
        }
        if (point.kind === "pass") {
          const fresh = passes.find((p) => p.id === point.pass.id);
          if (!fresh || fresh.status === "open") return null;
          return {
            ...menu,
            point: { kind: "pass", pass: fresh, affectsRoute: false },
          };
        }
        return menu;
      });
    }, [ready, closures, passes]);

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
            onClose={() => setPointMenu(null)}
          />
        ) : null}
      </MapCanvas>
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
