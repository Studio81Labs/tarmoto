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
  type MapLayerMouseEvent,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, Point } from "geojson";
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
import { HAZARD_CONFIG, HAZARD_TYPES_UI, hazardFadeOpacity } from "@/lib/utils";
import { hazardsApi, type HazardResponse } from "@/lib/api";
import { onHazardNew, subscribeHazards } from "@/lib/socket";
import {
  applyHazardWsEvent,
  mergeHazardsWithInFlightWsArrivals,
} from "@/lib/hazard-merge";
import { useRealtimeStore } from "@/stores/realtime";
import { haversineMeters, type HazardType } from "@tarmoto/shared";
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
import { plannerApi } from "@/lib/planner/api";
import type { Poi, PoiCategory } from "@/lib/planner/types";

const HAZARDS_SOURCE = "hazards-src";
const HAZARD_CLUSTERS = "tarmoto-hazard-clusters";
const HAZARD_CLUSTER_COUNT = "tarmoto-hazard-cluster-count";
const HAZARD_BG = "tarmoto-hazard-bg";
const HAZARD_ICON = "tarmoto-hazard-icon";

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

const POI_FETCH_DEBOUNCE_MS = 300;

const HAZARD_MIN_ZOOM = 9;
const HAZARD_FETCH_DEBOUNCE_MS = 300;
const HAZARD_MAX_RADIUS_M = 50_000;
const HAZARD_MIN_RADIUS_M = 500;

const EMPTY_COLLECTION: FeatureCollection<Point, HazardProps> = {
  type: "FeatureCollection",
  features: [],
};

// GeoJSON feature-properties bag for a hazard marker. The passthrough wire
// fields are derived from the generated `HazardResponse` (a backend rename
// breaks here at typecheck time); `hazard_type` is the normalised shared
// enum, and `emoji` / `opacity` are computed client-side for the map paint.
type HazardProps = Pick<
  HazardResponse,
  | "id"
  | "note"
  | "photo_url"
  | "confirmations"
  | "reporter"
  | "road_name"
  | "created_at"
  | "expires_at"
> & {
  hazard_type: HazardType;
  severity: string;
  emoji: string;
  opacity: number;
};

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
      onSegmentSelect,
      selectedSegmentId,
      onViewChange,
    },
    ref,
  ) {
    const handleRef = useRef<MapCanvasHandle>(null);

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

    useEffect(() => {
      segmentSelectionRef.current = {
        showQuality,
        showSurface,
        onSegmentSelect,
      };
    }, [showQuality, showSurface, onSegmentSelect]);

    const handleReady = (map: MapLibreMap) => {
      map.addSource(HAZARDS_SOURCE, {
        type: "geojson",
        data: EMPTY_COLLECTION,
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 13,
      });

      map.addLayer({
        id: HAZARD_CLUSTERS,
        type: "circle",
        source: HAZARDS_SOURCE,
        filter: ["has", "point_count"],
        layout: { visibility: showHazards ? "visible" : "none" },
        paint: {
          "circle-color": "#0ED3CF",
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            14,
            10,
            18,
            25,
            24,
          ] as ExpressionSpecification,
        },
      });

      map.addLayer({
        id: HAZARD_CLUSTER_COUNT,
        type: "symbol",
        source: HAZARDS_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          visibility: showHazards ? "visible" : "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": [
            "Noto Sans Bold",
            "Open Sans Bold",
            "Arial Unicode MS Bold",
          ],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#0f172a" },
      });

      map.addLayer({
        id: HAZARD_BG,
        type: "circle",
        source: HAZARDS_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: showHazards ? "visible" : "none" },
        paint: {
          "circle-color": buildHazardColorExpression(),
          "circle-opacity": ["coalesce", ["get", "opacity"], 1],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            10,
            14,
            14,
            18,
            18,
          ] as ExpressionSpecification,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": ["coalesce", ["get", "opacity"], 1],
        },
      });

      map.addLayer({
        id: HAZARD_ICON,
        type: "symbol",
        source: HAZARDS_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: {
          visibility: showHazards ? "visible" : "none",
          "text-field": ["get", "emoji"],
          "text-size": 16,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-opacity": ["coalesce", ["get", "opacity"], 1] },
      });

      // Cluster click → expand.
      map.on("click", HAZARD_CLUSTERS, (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const clusterId = feature.properties?.cluster_id as number | undefined;
        if (clusterId == null) return;
        const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
        if (!src) return;
        src
          .getClusterExpansionZoom(clusterId)
          .then((expZoom) => {
            const geom = feature.geometry;
            if (geom.type !== "Point") return;
            map.easeTo({
              center: geom.coordinates as [number, number],
              zoom: expZoom,
            });
          })
          .catch(() => {
            // Cluster may have been superseded by a refetch; drop the zoom-in.
          });
      });

      const onHazardClick = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        const props = feature?.properties as HazardProps | null;
        if (
          !feature ||
          !props?.hazard_type ||
          feature.geometry.type !== "Point"
        )
          return;
        const [lng, lat] = feature.geometry.coordinates as [number, number];
        setPointMenu({
          point: { kind: "hazard", hazard: props },
          lng,
          lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      };
      map.on("click", HAZARD_BG, onHazardClick);
      map.on("click", HAZARD_ICON, onHazardClick);

      // ── Category-POI browse layer ──
      ensurePoiLayers(map);
      map.on("click", POI_PIN_LAYER, (e: MapLayerMouseEvent) => {
        const props = e.features?.[0]?.properties as
          | { poiId?: string }
          | undefined;
        const poi = props?.poiId
          ? poisByIdRef.current.get(props.poiId)
          : undefined;
        if (!poi) return;
        setPointMenu({
          point: { kind: "poi", poi },
          lng: poi.lng,
          lat: poi.lat,
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      });
      map.on("click", POI_CLUSTER_LAYER, (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        const clusterId = feature?.properties?.cluster_id as number | undefined;
        const src = map.getSource(POI_SOURCE) as GeoJSONSource | undefined;
        if (clusterId == null || !src || !feature) return;
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
      });

      map.on("click", (e: MapLayerMouseEvent) => {
        // POI pins/clusters and hazard markers own their click (handled above).
        const pointLayers = [
          POI_PIN_LAYER,
          POI_CLUSTER_LAYER,
          HAZARD_BG,
          HAZARD_ICON,
          HAZARD_CLUSTERS,
        ].filter((id) => map.getLayer(id));
        if (
          pointLayers.length > 0 &&
          map.queryRenderedFeatures(e.point, { layers: pointLayers }).length > 0
        ) {
          return;
        }
        // Any other click (road or empty map) dismisses an open popover.
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
      const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(
        toHazardFeatures(
          selectHazards(rawHazardsRef.current, filters.hazardTypes),
          hazardNow,
        ),
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
      for (const id of [
        HAZARD_CLUSTERS,
        HAZARD_CLUSTER_COUNT,
        HAZARD_BG,
        HAZARD_ICON,
      ]) {
        setVisibility(map, id, showHazards);
      }
    }, [ready, showHazards]);

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
          const src = map.getSource(HAZARDS_SOURCE) as
            | GeoJSONSource
            | undefined;
          src?.setData(EMPTY_COLLECTION);
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

function buildHazardColorExpression(): ExpressionSpecification {
  const pairs = HAZARD_TYPES_UI.flatMap((type) => [
    type,
    HAZARD_CONFIG[type].hex,
  ]);
  return [
    "match",
    ["get", "hazard_type"],
    ...pairs,
    HAZARD_CONFIG.other.hex,
  ] as unknown as ExpressionSpecification;
}

function normalizeHazardType(raw: string): HazardType {
  return HAZARD_CONFIG[raw as HazardType] ? (raw as HazardType) : "other";
}

function selectHazards(
  raw: HazardResponse[],
  types: Set<HazardType>,
): HazardResponse[] {
  if (types.size === HAZARD_TYPES_UI.length) return raw;
  if (types.size === 0) return [];
  return raw.filter((h) => types.has(normalizeHazardType(h.hazard_type)));
}

function setVisibility(map: MapLibreMap, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function toHazardFeatures(
  hazards: HazardResponse[],
  now: number = Date.now(),
): FeatureCollection<Point, HazardProps> {
  const features: Feature<Point, HazardProps>[] = hazards.map((h) => {
    const type = normalizeHazardType(h.hazard_type);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lng, h.lat] },
      properties: {
        id: h.id,
        hazard_type: type,
        severity: h.severity,
        note: h.note,
        photo_url: h.photo_url ?? null,
        confirmations: h.confirmations,
        reporter: h.reporter,
        road_name: h.road_name,
        created_at: h.created_at,
        expires_at: h.expires_at,
        emoji: HAZARD_CONFIG[type].emoji,
        opacity: hazardFadeOpacity(h.created_at, h.expires_at, now),
      },
    };
  });
  return { type: "FeatureCollection", features };
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
