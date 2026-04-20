"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { API_BASE, MAP_STYLE_URL } from "@/lib/config";
import { QUALITY_CONFIG, HAZARD_CONFIG } from "@/lib/utils";
import {
  FILTERABLE_SURFACES,
  type MapFilters,
  type FilterableSurface,
} from "@/lib/map-filters";

const SOURCE_ID = "tarmoto-roads";
const QUALITY_LAYER = "tarmoto-quality";
const SURFACE_LAYER = "tarmoto-surface";
const HAZARD_LAYER = "tarmoto-hazards";
const HAZARD_OVERVIEW_LAYER = "tarmoto-hazards-cluster";

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

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

const HAZARD_COLORS: Record<string, string> = {
  pothole: "#ef4444",
  gravel: "#f59e0b",
  oil_spill: "#78350f",
  roadworks: "#facc15",
  animals: "#84cc16",
  police: "#3b82f6",
  flooding: "#0ea5e9",
  ice: "#67e8f9",
};

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

      // Low-zoom overview pass — small uniform red dots so the user can see
      // hazard density without visual clutter. NOT clustering: MapLibre vector
      // sources can't cluster client-side. Real aggregation would need a
      // GeoJSON hazards endpoint or server-side preclustering in the MVT
      // pipeline; tracked as a follow-up under #79.
      map.addLayer({
        id: HAZARD_OVERVIEW_LAYER,
        type: "circle",
        source: SOURCE_ID,
        "source-layer": "hazards",
        minzoom: 6,
        maxzoom: 11,
        layout: { visibility: showHazards ? "visible" : "none" },
        paint: {
          "circle-color": "#ef4444",
          "circle-opacity": 0.75,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            4,
            11,
            6,
          ] as ExpressionSpecification,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      map.addLayer({
        id: HAZARD_LAYER,
        type: "circle",
        source: SOURCE_ID,
        "source-layer": "hazards",
        minzoom: 11,
        layout: { visibility: showHazards ? "visible" : "none" },
        paint: {
          "circle-color": [
            "match",
            ["get", "hazard_type"],
            "pothole",
            HAZARD_COLORS.pothole,
            "gravel",
            HAZARD_COLORS.gravel,
            "oil_spill",
            HAZARD_COLORS.oil_spill,
            "roadworks",
            HAZARD_COLORS.roadworks,
            "animals",
            HAZARD_COLORS.animals,
            "police",
            HAZARD_COLORS.police,
            "flooding",
            HAZARD_COLORS.flooding,
            "ice",
            HAZARD_COLORS.ice,
            "#ef4444",
          ] as ExpressionSpecification,
          "circle-opacity": 0.9,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            5,
            16,
            9,
          ] as ExpressionSpecification,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      // Hazard popup on click.
      map.on("click", HAZARD_LAYER, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as {
          hazard_type?: string;
          severity?: string;
          confirmations?: number;
        } | null;
        if (!props?.hazard_type) return;
        const cfg =
          HAZARD_CONFIG[props.hazard_type as keyof typeof HAZARD_CONFIG];
        const label = cfg?.label ?? props.hazard_type;
        const emoji = cfg?.emoji ?? "⚠️";
        const html = `
          <div style="font-family: system-ui, sans-serif; color: #0f172a;">
            <div style="font-weight:600; font-size:14px;">${emoji} ${escapeHtml(label)}</div>
            <div style="font-size:12px; color:#475569; margin-top:4px;">
              Severity: ${escapeHtml(props.severity ?? "—")}<br/>
              Confirmations: ${props.confirmations ?? 0}
            </div>
          </div>
        `;
        new maplibregl.Popup({ closeButton: true, offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      map.on("mouseenter", HAZARD_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", HAZARD_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });

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

  // ── apply filters to line-opacity (dim non-matching) ──
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

  // ── layer visibility from toggles ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setVisibility(map, QUALITY_LAYER, showQuality);
    setVisibility(map, SURFACE_LAYER, showSurface);
    setVisibility(map, HAZARD_LAYER, showHazards);
    setVisibility(map, HAZARD_OVERVIEW_LAYER, showHazards);
  }, [ready, showQuality, showSurface, showHazards]);

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
