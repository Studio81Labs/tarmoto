"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, Point } from "geojson";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import {
  HAZARD_CONFIG,
  HAZARD_TYPES_UI,
  formatRelativeTime,
  hazardFadeOpacity,
} from "@/lib/utils";
import { hazardsApi, type HazardResponse } from "@/lib/api";
import { haversineMeters, type HazardType } from "@tarmoto/shared";
import { FILTERABLE_SURFACES, type MapFilters } from "@/lib/map-filters";

const HAZARDS_SOURCE = "hazards-src";
const HAZARD_CLUSTERS = "tarmoto-hazard-clusters";
const HAZARD_CLUSTER_COUNT = "tarmoto-hazard-cluster-count";
const HAZARD_BG = "tarmoto-hazard-bg";
const HAZARD_ICON = "tarmoto-hazard-icon";

const DIMMED_OPACITY = 0.15;
const ACTIVE_OPACITY = 0.9;

const HAZARD_MIN_ZOOM = 9;
const HAZARD_FETCH_DEBOUNCE_MS = 300;
const HAZARD_MAX_RADIUS_M = 50_000;
const HAZARD_MIN_RADIUS_M = 500;

const EMPTY_COLLECTION: FeatureCollection<Point, HazardProps> = {
  type: "FeatureCollection",
  features: [],
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
  const handleRef = useRef<MapCanvasHandle>(null);
  const [ready, setReady] = useState(false);

  const rawHazardsRef = useRef<HazardResponse[]>([]);
  const [hazardsRevision, setHazardsRevision] = useState(0);
  const [hazardNow, setHazardNow] = useState(() => Date.now());

  const qualityOpacity = buildQualityOpacityExpression(filters);
  const surfaceOpacity = buildSurfaceOpacityExpression(filters);

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

    setReady(true);
  };

  const handleViewChange = (view: {
    lng: number;
    lat: number;
    zoom: number;
  }) => {
    onViewChange?.({ lng: view.lng, lat: view.lat, zoom: view.zoom });
  };

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
        setHazardsRevision((r) => r + 1);
      } else {
        const src = map.getSource(HAZARDS_SOURCE) as GeoJSONSource | undefined;
        src?.setData(EMPTY_COLLECTION);
      }
      return;
    }

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
        rawHazardsRef.current = data;
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
  }, [ready, showHazards, center.lat, center.lng, zoom]);

  return (
    <MapCanvas
      ref={handleRef}
      center={center}
      zoom={zoom}
      showQuality={showQuality}
      showSurface={showSurface}
      qualityOpacityExpression={qualityOpacity}
      surfaceOpacityExpression={surfaceOpacity}
      onReady={handleReady}
      onViewChange={handleViewChange}
    />
  );
}

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
