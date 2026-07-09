"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import maplibregl, {
  type FilterSpecification,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  BASE_MAP_ATTRIBUTION,
  isCuratableBaseMap,
  loadCuratedMapStyle,
} from "./attribution";
import { API_BASE, MAP_STYLE_URL } from "@/lib/config";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import { QUALITY_CONFIG } from "@/lib/utils";

// Attribution curation is OpenFreeMap-specific; a different
// NEXT_PUBLIC_MAP_STYLE_URL is used as-is so it keeps its own attribution and
// resolves relative sprite/glyph/tile paths against the style URL (#902).
const CURATE_ATTRIBUTION = isCuratableBaseMap(MAP_STYLE_URL);

export const TARMOTO_ROADS_SOURCE = "tarmoto-roads";
export const TARMOTO_QUALITY_LAYER = "tarmoto-quality";
export const TARMOTO_SURFACE_LAYER = "tarmoto-surface";
// Accent glow + line painted over the selected road segment (the one whose
// detail drawer is open), filtered to its promoted feature id. Lives here so
// every MapCanvas surface — /explore and the trip planner — highlights the
// same way.
const SEGMENT_SELECTED_GLOW_LAYER = "tarmoto-segment-selected-glow";
const SEGMENT_SELECTED_LINE_LAYER = "tarmoto-segment-selected-line";
// A feature id that never matches: hides the highlight when nothing's selected.
const NO_SEGMENT_FILTER: FilterSpecification = ["==", ["id"], " "];
const ACTIVE_OPACITY = 0.9;

// Surface palette — must stay in sync with --color-surface-* in globals.css
// so the legend swatches match what's painted on the map. "unknown" is not
// user-filterable but always renders so the map doesn't blank fresh data.
// Exported so the planner's surface line-coloring mode paints the route
// with the same vocabulary as the all-roads tile overlay.
export const SURFACE_COLORS = {
  asphalt: "#3B82F6",
  concrete: "#6B7280",
  cobblestone: "#A78BFA",
  gravel: "#D97706",
  dirt: "#92400E",
  unknown: "#64748B",
} as const;

export interface MapCanvasHandle {
  readonly map: MapLibreMap | null;
}

export interface MapCanvasViewChange {
  lng: number;
  lat: number;
  zoom: number;
  bbox: [number, number, number, number];
}

interface Props {
  center: { lng: number; lat: number };
  zoom: number;
  showQuality: boolean;
  showSurface: boolean;
  /**
   * Road segment whose detail drawer is open — painted with the accent
   * highlight overlay. Null/undefined hides it.
   */
  selectedSegmentId?: string | null;
  /** Expression to set on the quality line layer's `line-opacity` paint prop. */
  qualityOpacityExpression?: ExpressionSpecification | number;
  /** Expression to set on the surface line layer's `line-opacity` paint prop. */
  surfaceOpacityExpression?: ExpressionSpecification | number;
  onViewChange?: (view: MapCanvasViewChange) => void;
  onReady?: (map: MapLibreMap) => void;
  /**
   * Pin the basemap to a specific theme instead of following the viewer's
   * color-scheme preference. Used by the public share pages, which always
   * render on cream regardless of who's viewing.
   */
  forceColorScheme?: MapColorScheme;
  children?: React.ReactNode;
}

/**
 * Reusable MapLibre canvas: mounts the map, registers the shared
 * `tarmoto-roads` vector source and the quality/surface line layers with
 * the same paint expressions used across the product. Consumers add their
 * own sources/layers inside `onReady`.
 *
 * Extracted from the original /explore `QualityMap` so that future map
 * surfaces (US-31 discover, US-32 trip planner) don't duplicate the init
 * boilerplate. Behavior matches the pre-extraction implementation.
 */
export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  {
    center,
    zoom,
    showQuality,
    showSurface,
    selectedSegmentId,
    qualityOpacityExpression = ACTIVE_OPACITY,
    surfaceOpacityExpression = 0.75,
    onViewChange,
    onReady,
    forceColorScheme,
    children,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  // Base map style with the provider's baked-in credit stripped, so we drive
  // the attribution control with our own linked, ordered list (#852). Null until
  // the fetch resolves — the map isn't created until then.
  const [curatedStyle, setCuratedStyle] = useState<
    StyleSpecification | string | null
  >(null);
  // Always call the hook (rules of hooks); `forceColorScheme` overrides the
  // viewer preference when set.
  const viewerColorScheme = useMapColorScheme();
  const colorScheme = forceColorScheme ?? viewerColorScheme;
  const colorSchemeRef = useRef(colorScheme);
  const appliedColorSchemeRef = useRef<MapColorScheme | null>(null);

  useEffect(() => {
    colorSchemeRef.current = colorScheme;
  }, [colorScheme]);

  // Expose the raw map handle to parents so they can add custom sources/layers.
  useImperativeHandle(ref, () => ({
    get map() {
      return mapRef.current;
    },
  }));

  // Latest callback refs — the init effect runs once, so we bounce callbacks
  // through refs to avoid stale closures after prop changes.
  const onViewChangeRef = useRef(onViewChange);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onViewChangeRef.current = onViewChange;
  }, [onViewChange]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // Fetch + curate the base map style once: strip its baked-in attribution so
  // the control shows only our own linked, ordered credits (#852). A non-
  // OpenFreeMap style is used as-is — MapLibre keeps its own attribution and
  // resolves relative resources against the style URL (#902).
  useEffect(() => {
    if (!CURATE_ATTRIBUTION) {
      setCuratedStyle(MAP_STYLE_URL);
      return;
    }
    let cancelled = false;
    void loadCuratedMapStyle(MAP_STYLE_URL).then((style) => {
      if (!cancelled) setCuratedStyle(style);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── init map once (after the curated style resolves) ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current || curatedStyle === null)
      return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: curatedStyle,
      center: [center.lng, center.lat],
      zoom,
      attributionControl: CURATE_ATTRIBUTION
        ? {
            compact: true,
            // One joined string, not the array: the control length-sorts
            // multiple entries but never reorders within one, so this preserves
            // our provenance order (see attribution.ts).
            customAttribution: BASE_MAP_ATTRIBUTION.join(" | "),
          }
        : { compact: true },
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
      applyTarmotoMapTheme(map, colorSchemeRef.current);
      appliedColorSchemeRef.current = colorSchemeRef.current;

      map.addSource(TARMOTO_ROADS_SOURCE, {
        type: "vector",
        tiles: [`${originForTiles()}${API_BASE}/roads/tiles/{z}/{x}/{y}.mvt`],
        minzoom: 6,
        maxzoom: 18,
        // Hoist the segment UUID from properties to the feature `id` so
        // consumers (notably the personal road-map US-50) can drive
        // ridden/unridden styling via `feature-state` instead of a
        // 10k-entry `["match", ["get", "id"], …]` filter.
        promoteId: { quality: "id", surface: "id" },
      });

      // Each layer's initial visibility is read from the current props so the
      // map renders the user's stored toggle state immediately on load.

      map.addLayer({
        id: TARMOTO_QUALITY_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
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
          "line-opacity": qualityOpacityExpression,
        },
      });

      map.addLayer({
        id: TARMOTO_SURFACE_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
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
          "line-opacity": surfaceOpacityExpression,
        },
      });

      // Selected-segment highlight, painted from the `quality` source-layer
      // (which stays loaded even in surface-only mode). Filtered to nothing
      // until a segment is selected. Added last so it sits above the coloured
      // overlays; consumers add their own markers/route in `onReady`, i.e. on
      // top of this.
      map.addLayer({
        id: SEGMENT_SELECTED_GLOW_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        filter: NO_SEGMENT_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#FF6A1A",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            8,
            12,
            12,
            16,
            20,
          ] as ExpressionSpecification,
          "line-opacity": 0.35,
          "line-blur": 3,
        },
      });
      map.addLayer({
        id: SEGMENT_SELECTED_LINE_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        filter: NO_SEGMENT_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#FF6A1A",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            2.5,
            12,
            4,
            16,
            7,
          ] as ExpressionSpecification,
          "line-opacity": 1,
        },
      });

      map.on("moveend", () => {
        const c = map.getCenter();
        const b = map.getBounds();
        onViewChangeRef.current?.({
          lng: Number(c.lng.toFixed(5)),
          lat: Number(c.lat.toFixed(5)),
          zoom: Number(map.getZoom().toFixed(2)),
          bbox: [
            Number(b.getWest().toFixed(5)),
            Number(b.getSouth().toFixed(5)),
            Number(b.getEast().toFixed(5)),
            Number(b.getNorth().toFixed(5)),
          ],
        });
      });

      setReady(true);
      onReadyRef.current?.(map);
    });

    mapRef.current = map;

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      appliedColorSchemeRef.current = null;
      setReady(false);
    };
    // Init center/zoom read once at mount; updates come from moveend so the
    // map doesn't yank the user's view when they pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curatedStyle]);

  // ── layer visibility from toggles ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setVisibility(map, TARMOTO_QUALITY_LAYER, showQuality);
    setVisibility(map, TARMOTO_SURFACE_LAYER, showSurface);
  }, [ready, showQuality, showSurface]);

  // ── selected-segment highlight filter ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter: FilterSpecification = selectedSegmentId
      ? ["==", ["id"], selectedSegmentId]
      : NO_SEGMENT_FILTER;
    for (const layer of [
      SEGMENT_SELECTED_GLOW_LAYER,
      SEGMENT_SELECTED_LINE_LAYER,
    ]) {
      if (map.getLayer(layer)) map.setFilter(layer, filter);
    }
  }, [ready, selectedSegmentId]);

  // ── paint updates for opacity expressions ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (map.getLayer(TARMOTO_QUALITY_LAYER)) {
      map.setPaintProperty(
        TARMOTO_QUALITY_LAYER,
        "line-opacity",
        qualityOpacityExpression,
      );
    }
    if (map.getLayer(TARMOTO_SURFACE_LAYER)) {
      map.setPaintProperty(
        TARMOTO_SURFACE_LAYER,
        "line-opacity",
        surfaceOpacityExpression,
      );
    }
  }, [ready, qualityOpacityExpression, surfaceOpacityExpression]);

  // Keep the branded basemap aligned with the user's system theme.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || appliedColorSchemeRef.current === colorScheme) return;
    applyTarmotoMapTheme(map, colorScheme);
    appliedColorSchemeRef.current = colorScheme;
  }, [colorScheme, ready]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      {children}
    </div>
  );
});

function setVisibility(
  map: MapLibreMap,
  layerId: string,
  visible: boolean,
): void {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function originForTiles(): string {
  if (typeof window === "undefined") return "";
  if (API_BASE.startsWith("http")) return "";
  return window.location.origin;
}
