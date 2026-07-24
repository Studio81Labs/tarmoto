"use client";

import {
  forwardRef,
  useCallback,
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
import { useLimit } from "@/hooks";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { resolveQualityMaxZoom } from "@/lib/map-entitlements";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import { QUALITY_CONFIG } from "@/lib/utils";

// Attribution curation is OpenFreeMap-specific; a different
// NEXT_PUBLIC_MAP_STYLE_URL is used as-is so it keeps its own attribution and
// resolves relative sprite/glyph/tile paths against the style URL (#902).
const CURATE_ATTRIBUTION = isCuratableBaseMap(MAP_STYLE_URL);

export const TARMOTO_ROADS_SOURCE = "tarmoto-roads";
export const TARMOTO_SURFACE_SOURCE = "tarmoto-road-surfaces";
export const TARMOTO_QUALITY_LAYER = "tarmoto-quality";
export const TARMOTO_SURFACE_LAYER = "tarmoto-surface";
// Individual road segments are not visually useful below neighbourhood scale,
// and country-scale z6-z8 tiles can contain tens of megabytes of features.
// Routed lines still render at every zoom; this only gates the all-roads
// background overlays until the rider zooms in far enough to inspect them.
const TARMOTO_ROADS_MIN_ZOOM = 10;
// The personal road-map adds its own coverage layers to the shared quality
// source and opens at z8. Keep the source available there; the MapCanvas
// quality layer's higher minzoom still prevents country-scale background
// overlay requests everywhere else.
const TARMOTO_ROADS_SOURCE_MIN_ZOOM = 6;
// Accent glow + line painted over the selected road segment (the one whose
// detail drawer is open), filtered on the segment's `id` property. Lives here
// so every MapCanvas surface — /explore and the trip planner — highlights the
// same way. Match the `id` *property* (via `get`), not the promoted feature
// id (`["id"]`), which doesn't resolve reliably inside a filter expression.
const SEGMENT_SELECTED_GLOW_LAYER = "tarmoto-segment-selected-glow";
const SEGMENT_SELECTED_LINE_LAYER = "tarmoto-segment-selected-line";
// A value that never matches a real UUID: hides the highlight when nothing's
// selected.
const NO_SEGMENT_FILTER: FilterSpecification = ["==", ["get", "id"], ""];
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

// Quality line-color: a step over quality_score into the QUALITY_CONFIG
// palette. Shared by the quality overlay and the selected-segment highlight so
// the highlight glows in the segment's OWN colour rather than a fixed accent —
// the wider stroke + halo is what reads as "selected".
const QUALITY_LINE_COLOR: ExpressionSpecification = [
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
];

export interface MapCanvasHandle {
  readonly map: MapLibreMap | null;
  /**
   * Set the extra POI-data credits appended to the attribution control beyond
   * the base-map ones (#869) — e.g. `[FSQ_ATTRIBUTION]` once Foursquare POIs
   * appear. Pass `[]` to clear. Rebuilds the control, so call it only when the
   * set actually changes (the caller latches it), not on every data refresh.
   */
  setPoiAttribution(entries: readonly string[]): void;
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
   * Render the interactive control chrome (zoom / geolocate / scale).
   * Non-interactive previews (e.g. RadiusPreviewMap) pass `false` so no
   * dead-but-focusable buttons appear; the attribution control is always
   * added regardless — the basemap licence requires it stays visible and
   * clickable.
   */
  controls?: boolean;
  /**
   * MapLibre's construction-time interactivity switch. `false` never
   * installs the drag/scroll/keyboard handlers at all — unlike disabling
   * handlers in `onReady`, there is no window before style load where a
   * "static" preview could still capture wheel or drag input.
   */
  interactive?: boolean;
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
    controls = true,
    interactive = true,
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

  // road_quality_max_zoom entitlement: caps how far the quality overlay layer
  // renders. Fails closed to the free floor until the cap resolves.
  const { limit: qualityZoomLimit, isSuccess: qualityZoomResolved } = useLimit(
    "road_quality_max_zoom",
  );
  const qualityMaxZoom = resolveQualityMaxZoom(
    qualityZoomLimit,
    qualityZoomResolved,
  );
  // The quality layer is added inside the `load` handler below, a closure
  // captured once at map-init time — bounce the latest cap through a ref so
  // that closure reads the current value rather than the one from first
  // render.
  const qualityMaxZoomRef = useRef(qualityMaxZoom);
  qualityMaxZoomRef.current = qualityMaxZoom;

  useEffect(() => {
    colorSchemeRef.current = colorScheme;
  }, [colorScheme]);

  // Attribution control we own (rather than the Map's default) so we can rebuild
  // it when the POI-data credits change — MapLibre binds a source's `attribution`
  // statically and offers no live setter, and the control has no update method.
  const attributionControlRef = useRef<maplibregl.AttributionControl | null>(
    null,
  );
  const poiAttributionRef = useRef<string[]>([]);

  const applyAttribution = useCallback((map: MapLibreMap) => {
    if (attributionControlRef.current) {
      map.removeControl(attributionControlRef.current);
    }
    // Base-map credits (only for a curatable base — a commercial style keeps its
    // own) plus the POI-data credits the parent latches on. OSM is already in
    // BASE_MAP_ATTRIBUTION, so the POI credits carry only the extra source(s).
    const credits = [
      ...(CURATE_ATTRIBUTION ? BASE_MAP_ATTRIBUTION : []),
      ...poiAttributionRef.current,
    ];
    const control = new maplibregl.AttributionControl({
      compact: true,
      // One joined string, not the array: the control length-sorts multiple
      // entries but never reorders within one, so this preserves provenance
      // order (see attribution.ts).
      ...(credits.length > 0 ? { customAttribution: credits.join(" | ") } : {}),
    });
    map.addControl(control);
    attributionControlRef.current = control;
  }, []);

  // Expose the raw map handle to parents so they can add custom sources/layers.
  useImperativeHandle(ref, () => ({
    get map() {
      return mapRef.current;
    },
    setPoiAttribution(entries: readonly string[]) {
      poiAttributionRef.current = [...entries];
      const map = mapRef.current;
      if (map) applyAttribution(map);
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
      // We manage our own AttributionControl (applyAttribution) so it can be
      // rebuilt when the POI-data credits change (#869); disable the default.
      attributionControl: false,
      // Init-time prop, like center/zoom: previews pass false so the
      // interaction handlers are never installed.
      interactive,
    });
    applyAttribution(map);
    // Like center/zoom below, `controls` is an init-time prop — read once
    // when the map mounts.
    if (controls) {
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
    }

    map.on("load", () => {
      applyTarmotoMapTheme(map, colorSchemeRef.current);
      appliedColorSchemeRef.current = colorSchemeRef.current;

      const roadTileBase = `${originForTiles()}${API_BASE}/roads/tiles/{z}/{x}/{y}.mvt`;
      map.addSource(TARMOTO_ROADS_SOURCE, {
        type: "vector",
        // The quality layer already carries surface + curviness properties.
        // Do not download the separate surface layer when only quality is
        // visible (the common planner/explore path from the performance HAR).
        tiles: [`${roadTileBase}?layers=quality`],
        minzoom: TARMOTO_ROADS_SOURCE_MIN_ZOOM,
        maxzoom: 18,
        // Hoist the segment UUID from properties to the feature `id` so
        // consumers (notably the personal road-map US-50) can drive
        // ridden/unridden styling via `feature-state` instead of a
        // 10k-entry `["match", ["get", "id"], …]` filter.
        promoteId: { quality: "id" },
      });

      map.addSource(TARMOTO_SURFACE_SOURCE, {
        type: "vector",
        tiles: [`${roadTileBase}?layers=surface`],
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        maxzoom: 18,
        promoteId: { surface: "id" },
      });

      // Each layer's initial visibility is read from the current props so the
      // map renders the user's stored toggle state immediately on load.

      map.addLayer({
        id: TARMOTO_QUALITY_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        maxzoom: qualityMaxZoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: showQuality ? "visible" : "none",
        },
        paint: {
          "line-color": QUALITY_LINE_COLOR,
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
        source: TARMOTO_SURFACE_SOURCE,
        "source-layer": "surface",
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
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
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        // The selection highlight is quality-GRADED (QUALITY_LINE_COLOR), so it
        // carries the same entitlement zoom cap as the overlay — otherwise a
        // free rider could read a segment's quality colour past the cap by
        // selecting it. See the runtime clamp effect below.
        maxzoom: qualityMaxZoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // A filtered-but-visible layer still makes MapLibre fetch its source.
          // Keep both selected-road layers hidden until a segment is selected.
          visibility: selectedSegmentId ? "visible" : "none",
        },
        paint: {
          "line-color": QUALITY_LINE_COLOR,
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
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        // Quality-graded selection highlight — same entitlement cap as above.
        maxzoom: qualityMaxZoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: selectedSegmentId ? "visible" : "none",
        },
        paint: {
          "line-color": QUALITY_LINE_COLOR,
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
      // map.remove() disposes its controls; drop our ref so a remount rebuilds.
      attributionControlRef.current = null;
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

  // ── quality overlay maxzoom from the road_quality_max_zoom entitlement ──
  // The cap can resolve (or change, e.g. a tier upgrade) after the layers were
  // already added with the ref-captured value above; apply changes live. Every
  // layer that renders the quality-GRADED colour (the overlay + both selection
  // highlights) carries the cap, so selecting a segment can't leak its quality
  // colour past the cap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const layerId of [
      TARMOTO_QUALITY_LAYER,
      SEGMENT_SELECTED_GLOW_LAYER,
      SEGMENT_SELECTED_LINE_LAYER,
    ]) {
      if (map.getLayer(layerId)) {
        map.setLayerZoomRange(layerId, TARMOTO_ROADS_MIN_ZOOM, qualityMaxZoom);
      }
    }
  }, [qualityMaxZoom]);

  // ── selected-segment highlight filter ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter: FilterSpecification = selectedSegmentId
      ? ["==", ["get", "id"], selectedSegmentId]
      : NO_SEGMENT_FILTER;
    for (const layer of [
      SEGMENT_SELECTED_GLOW_LAYER,
      SEGMENT_SELECTED_LINE_LAYER,
    ]) {
      if (!map.getLayer(layer)) continue;
      map.setFilter(layer, filter);
      setVisibility(map, layer, Boolean(selectedSegmentId));
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
