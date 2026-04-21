"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, Point } from "geojson";
import { API_BASE, MAP_STYLE_URL } from "@/lib/config";
import {
  QUALITY_CONFIG,
  HAZARD_CONFIG,
  HAZARD_TYPES_UI,
  formatRelativeTime,
  hazardFadeOpacity,
} from "@/lib/utils";
import { hazardsApi, type HazardResponse } from "@/lib/api";
import type { HazardType } from "@tarmoto/shared";
import {
  FILTERABLE_SURFACES,
  type MapFilters,
  type FilterableSurface,
} from "@/lib/map-filters";

const SOURCE_ID = "tarmoto-roads";
const QUALITY_LAYER = "tarmoto-quality";
const SURFACE_LAYER = "tarmoto-surface";

const HAZARDS_SOURCE = "hazards-src";
const HAZARD_CLUSTERS = "tarmoto-hazard-clusters";
const HAZARD_CLUSTER_COUNT = "tarmoto-hazard-cluster-count";
const HAZARD_BG = "tarmoto-hazard-bg";
const HAZARD_ICON = "tarmoto-hazard-icon";

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

// Below this zoom the viewport covers more area than the backend's 50 km radius
// cap can reasonably serve, so we skip fetching and render nothing rather than
// a misleadingly-partial result. Users pan/zoom in before markers reappear.
const HAZARD_MIN_ZOOM = 9;
const HAZARD_FETCH_DEBOUNCE_MS = 300;
// Backend caps radius at 50 km. We derive request radius from the viewport
// diagonal so smaller viewports don't pull in off-screen hazards.
const HAZARD_MAX_RADIUS_M = 50_000;
const HAZARD_MIN_RADIUS_M = 500;

const EMPTY_COLLECTION: FeatureCollection<Point, HazardProps> = {
  type: "FeatureCollection",
  features: [],
};

// Surface palette — must stay in sync with --color-surface-* in globals.css
// so the legend swatches match what's painted on the map. "unknown" is not
// user-filterable but always renders so the map doesn't blank fresh data.
const SURFACE_COLORS: Record<FilterableSurface | "unknown", string> = {
  asphalt: "#3B82F6",
  concrete: "#6B7280",
  cobblestone: "#A78BFA",
  gravel: "#D97706",
  dirt: "#92400E",
  unknown: "#64748B",
};

interface HazardProps {
  id: string;
  hazard_type: HazardType;
  severity: string;
  note: string | null;
  confirmations: number;
  reporter: string | null;
  road_name: string | null;
  created_at: string;
  expires_at: string;
  emoji: string;
  opacity: number;
}

interface Props {
  center: { lng: number; lat: number };
  zoom: number;
  filters: MapFilters;
  showQuality: boolean;
  showSurface: boolean;
  showHazards: boolean;
  onViewChange?: (view: { lng: number; lat: number; zoom: number }) => void;
}

export function QualityMap({
  center,
  zoom,
  filters,
  showQuality,
  showSurface,
  showHazards,
  onViewChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => {
    onViewChangeRef.current = onViewChange;
  }, [onViewChange]);

  // ── init map once ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [center.lng, center.lat],
      zoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
    );
    map.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );

    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "vector",
        tiles: [`${originForTiles()}${API_BASE}/roads/tiles/{z}/{x}/{y}.mvt`],
        minzoom: 6,
        maxzoom: 18,
      });

      // Each layer's initial visibility is read from the current props so the
      // map renders the user's stored toggle state immediately on load — the
      // visibility-sync effect would otherwise correct it one frame later,
      // briefly flashing the default.

      // Quality layer — the primary overlay. Color follows tier breakpoints
      // that mirror @/lib/utils#scoreToTier so legend and map agree.
      map.addLayer({
        id: QUALITY_LAYER,
        type: "line",
        source: SOURCE_ID,
        "source-layer": "quality",
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: showQuality ? "visible" : "none",
        },
        paint: {
          "line-color": [
            "step",
            ["coalesce", ["get", "quality_score"], 0],
            QUALITY_CONFIG["very-poor"].hex,
            1.5,
            QUALITY_CONFIG.poor.hex,
            2.5,
            QUALITY_CONFIG.fair.hex,
            3.5,
            QUALITY_CONFIG.good.hex,
            4.5,
            QUALITY_CONFIG.excellent.hex,
          ] as ExpressionSpecification,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            1.5,
            12,
            2.5,
            16,
            5,
          ] as ExpressionSpecification,
          "line-opacity": ACTIVE_OPACITY,
        },
      });

      // Surface layer — toggled on top of quality. When both are visible we
      // want surface to dominate, so it renders above the quality layer.
      map.addLayer({
        id: SURFACE_LAYER,
        type: "line",
        source: SOURCE_ID,
        "source-layer": "surface",
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: showSurface ? "visible" : "none",
        },
        paint: {
          "line-color": [
            "match",
            ["get", "surface_type"],
            "asphalt",
            SURFACE_COLORS.asphalt,
            "concrete",
            SURFACE_COLORS.concrete,
            "cobblestone",
            SURFACE_COLORS.cobblestone,
            "gravel",
            SURFACE_COLORS.gravel,
            "dirt",
            SURFACE_COLORS.dirt,
            SURFACE_COLORS.unknown,
          ] as ExpressionSpecification,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            1.5,
            12,
            2.5,
            16,
            5,
          ] as ExpressionSpecification,
          "line-opacity": 0.75,
        },
      });

      // Hazards: GeoJSON source fed by /hazards REST endpoint. Cluster at low
      // zoom so overlapping reports collapse into a single bubble; individual
      // symbol markers take over once zoomed in.
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

      // Individual hazard: background disc colored by type. Opacity is
      // pre-computed per-feature in `toHazardFeatures` so the fade across a
      // hazard's lifetime works without a live expression.
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

      // Emoji glyph on top of the disc. `text-allow-overlap` prevents the
      // cluster-first placement pass from culling markers when they pile up
      // just inside the cluster radius.
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
            // Cluster may have been superseded by a refetch between click and
            // resolution; just drop the zoom-in rather than surfacing an error.
          });
      });

      // Individual hazard click → popup with full details.
      const onHazardClick = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as HazardProps | null;
        if (!props?.hazard_type) return;
        new maplibregl.Popup({
          closeButton: true,
          offset: 12,
          maxWidth: "280px",
        })
          .setLngLat(e.lngLat)
          .setHTML(renderHazardPopup(props))
          .addTo(map);
      };
      map.on("click", HAZARD_BG, onHazardClick);
      map.on("click", HAZARD_ICON, onHazardClick);

      const setPointer = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const unsetPointer = () => {
        map.getCanvas().style.cursor = "";
      };
      for (const id of [HAZARD_BG, HAZARD_ICON, HAZARD_CLUSTERS]) {
        map.on("mouseenter", id, setPointer);
        map.on("mouseleave", id, unsetPointer);
      }

      map.on("moveend", () => {
        const c = map.getCenter();
        onViewChangeRef.current?.({
          lng: Number(c.lng.toFixed(5)),
          lat: Number(c.lat.toFixed(5)),
          zoom: Number(map.getZoom().toFixed(2)),
        });
      });

      setReady(true);
    });

    mapRef.current = map;

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Init center/zoom read once at mount; subsequent updates come from the
    // moveend handler and a separate effect so the map doesn't yank the user's
    // view when they pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── apply filters to line-opacity (dim non-matching quality/surface) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const qualityOpacity = buildQualityOpacityExpression(filters);
    const surfaceOpacity = buildSurfaceOpacityExpression(filters);

    if (map.getLayer(QUALITY_LAYER)) {
      map.setPaintProperty(QUALITY_LAYER, "line-opacity", qualityOpacity);
    }
    if (map.getLayer(SURFACE_LAYER)) {
      map.setPaintProperty(SURFACE_LAYER, "line-opacity", surfaceOpacity);
    }
  }, [ready, filters]);

  // ── apply hazard type filter (hide non-matching markers; clusters unchanged) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const typeFilter = buildHazardTypeFilter(filters.hazardTypes);
    if (map.getLayer(HAZARD_BG)) map.setFilter(HAZARD_BG, typeFilter);
    if (map.getLayer(HAZARD_ICON)) map.setFilter(HAZARD_ICON, typeFilter);
  }, [ready, filters.hazardTypes]);

  // ── layer visibility from toggles ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setVisibility(map, QUALITY_LAYER, showQuality);
    setVisibility(map, SURFACE_LAYER, showSurface);
    for (const id of [
      HAZARD_CLUSTERS,
      HAZARD_CLUSTER_COUNT,
      HAZARD_BG,
      HAZARD_ICON,
    ]) {
      setVisibility(map, id, showHazards);
    }
  }, [ready, showQuality, showSurface, showHazards]);

  // ── fetch hazards when viewport settles (debounced, abortable) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // When hidden or zoomed-out, clear the source rather than hanging onto
    // stale data the user can't see.
    if (!showHazards || zoom < HAZARD_MIN_ZOOM) {
      const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
      src?.setData(EMPTY_COLLECTION);
      return;
    }

    // `cancelled` guards the async write after the await: AbortController
    // signals the fetch to stop, but if the response has already resolved the
    // continuation still runs. Without this flag a slow prior fetch could
    // overwrite fresh data from the next viewport.
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const radius = viewportRadiusMeters(map);
        const { data } = await hazardsApi.findNearby(
          { lat: center.lat, lng: center.lng, radius },
          { signal: controller.signal },
        );
        if (cancelled) return;
        const src = mapRef.current?.getSource(HAZARDS_SOURCE) as
          | GeoJSONSource
          | undefined;
        src?.setData(toHazardFeatures(data));
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        // Intentionally swallow: the hazards overlay is a secondary signal —
        // a transient fetch failure shouldn't blow up the explorer. Next
        // moveend will retry.
        console.warn("[explore] hazards fetch failed", err);
      }
    }, HAZARD_FETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ready, showHazards, center.lat, center.lng, zoom]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}

// ── expression helpers ──

function buildQualityOpacityExpression(
  filters: MapFilters,
): ExpressionSpecification {
  // Quality tier match via the same breakpoints as scoreToTier.
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
  // "unknown" isn't user-filterable but still counts as a match so the map
  // doesn't blank segments while surface classification catches up.
  const surfaceMatch: ExpressionSpecification = [
    "any",
    ["==", ["coalesce", ["get", "surface_type"], "unknown"], "unknown"],
    [
      "in",
      ["coalesce", ["get", "surface_type"], "unknown"],
      ["literal", surfaceValues],
    ],
  ];

  const curvinessMatch: ExpressionSpecification = [
    ">=",
    ["coalesce", ["get", "curviness_score"], 0],
    filters.minCurviness,
  ];

  return [
    "case",
    ["all", qualityMatch, surfaceMatch, curvinessMatch],
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
  const curvinessMatch: ExpressionSpecification = [
    ">=",
    ["coalesce", ["get", "curviness_score"], 0],
    filters.minCurviness,
  ];

  return [
    "case",
    ["all", surfaceMatch, curvinessMatch],
    0.75,
    DIMMED_OPACITY,
  ] as ExpressionSpecification;
}

function buildHazardColorExpression(): ExpressionSpecification {
  // `match` expects alternating value/output pairs. HAZARD_CONFIG is the
  // source of truth so the popup, legend, and map stay aligned.
  // The MapLibre tuple type can't be expressed with a spread, so we cast via
  // `unknown` after confirming the runtime shape matches the spec.
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

function buildHazardTypeFilter(types: Set<HazardType>): FilterSpecification {
  // When every type is selected we still want to exclude the cluster points
  // (handled by `filter` at layer definition); this filter ANDs the "not a
  // cluster" check with the type match.
  if (types.size === 0) {
    return ["all", ["!", ["has", "point_count"]], false];
  }
  if (types.size === HAZARD_TYPES_UI.length) {
    return ["!", ["has", "point_count"]];
  }
  return [
    "all",
    ["!", ["has", "point_count"]],
    ["in", ["get", "hazard_type"], ["literal", [...types]]],
  ] as FilterSpecification;
}

function setVisibility(map: MapLibreMap, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

// MapLibre expects absolute tile URLs. Running in the browser we resolve the
// API host from config; during SSR this module doesn't execute (the component
// is "use client").
function originForTiles(): string {
  if (typeof window === "undefined") return "";
  // API_BASE can be same-origin ("/api/v1") — in that case we prepend the
  // current origin to form an absolute URL.
  if (API_BASE.startsWith("http")) return "";
  return window.location.origin;
}

function toHazardFeatures(
  hazards: HazardResponse[],
  now: number = Date.now(),
): FeatureCollection<Point, HazardProps> {
  const features: Feature<Point, HazardProps>[] = hazards.map((h) => {
    const type = (
      HAZARD_CONFIG[h.hazard_type as HazardType]
        ? (h.hazard_type as HazardType)
        : "other"
    ) as HazardType;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lng, h.lat] },
      properties: {
        id: h.id,
        hazard_type: type,
        severity: h.severity,
        note: h.note,
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
  // Radius that circumscribes the viewport — the larger of the two diagonals
  // from center to a corner. NE and SW usually agree, but tilted viewports
  // (and near-antimeridian bounds) can skew the distances.
  const diagonal = Math.max(
    haversineMeters(center.lat, center.lng, ne.lat, ne.lng),
    haversineMeters(center.lat, center.lng, sw.lat, sw.lng),
  );
  return Math.max(
    HAZARD_MIN_RADIUS_M,
    Math.min(HAZARD_MAX_RADIUS_M, Math.round(diagonal)),
  );
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function renderHazardPopup(props: HazardProps): string {
  const cfg = HAZARD_CONFIG[props.hazard_type] ?? HAZARD_CONFIG.other;
  const severity = props.severity || "—";
  const reporter = props.reporter ?? "Unknown rider";
  const when = formatRelativeTime(props.created_at);
  const road = props.road_name
    ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${escapeHtml(props.road_name)}</div>`
    : "";
  const note = props.note
    ? `<div style="font-size:12px;color:#334155;margin-top:8px;padding:6px 8px;background:#f1f5f9;border-radius:6px;">${escapeHtml(props.note)}</div>`
    : "";
  return `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;min-width:200px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:20px;line-height:1;">${cfg.emoji}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(cfg.label)}</div>
          ${road}
        </div>
        <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;padding:2px 6px;border-radius:999px;background:${severityBg(severity)};color:${severityFg(severity)};">${escapeHtml(severity)}</span>
      </div>
      ${note}
      <div style="font-size:12px;color:#475569;margin-top:8px;display:flex;justify-content:space-between;gap:8px;">
        <span>${escapeHtml(reporter)} · ${escapeHtml(when)}</span>
        <span>✓ ${props.confirmations}</span>
      </div>
    </div>
  `;
}

function severityBg(severity: string): string {
  if (severity === "high") return "#fee2e2";
  if (severity === "low") return "#dcfce7";
  return "#fef3c7";
}

function severityFg(severity: string): string {
  if (severity === "high") return "#991b1b";
  if (severity === "low") return "#166534";
  return "#92400e";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Exported for tests.
export { toHazardFeatures, buildHazardTypeFilter, viewportRadiusMeters };
