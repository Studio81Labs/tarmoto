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
import { useRoadQualityZoomCap } from "@/hooks";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { resolveQualityLayerMaxZoom } from "@/lib/map-entitlements";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import { QUALITY_CONFIG } from "@/lib/utils";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

// Attribution curation is OpenFreeMap-specific; a different
// NEXT_PUBLIC_MAP_STYLE_URL is used as-is so it keeps its own attribution and
// resolves relative sprite/glyph/tile paths against the style URL (#902).
const CURATE_ATTRIBUTION = isCuratableBaseMap(MAP_STYLE_URL);

export const TARMOTO_ROADS_SOURCE = "tarmoto-roads";
export const TARMOTO_SURFACE_SOURCE = "tarmoto-road-surfaces";
export const TARMOTO_QUALITY_LAYER = "tarmoto-quality";
export const TARMOTO_SURFACE_LAYER = "tarmoto-surface";
// An INVISIBLE, UNCAPPED copy of the road geometry used purely as a hit target
// for pointer interactions (waypoint snapping, tap-for-detail, hover cursor).
// The visible quality overlay is zoom-capped by the `road_quality_max_zoom`
// entitlement, but road INTERACTION must not be — snapping a waypoint to a
// road is a routing affordance, not gated quality detail. Querying this layer
// instead of the capped overlay keeps interaction working past the cap.
export const TARMOTO_ROAD_HIT_LAYER = "tarmoto-road-hit";
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
// Neutral casing UNDER the quality-graded highlight, uncapped: it conveys no
// quality colour, so it stays visible past the entitlement zoom cap and on
// surfaces that never show the quality overlay (PersonalRoadMap, surface-only
// Explore/planner). Below the cap the same-width quality line covers it, so the
// selected road still glows in its own colour; above the cap it's the only
// selection feedback, so a selected road never opens its detail drawer with no
// highlight on the map.
const SEGMENT_SELECTED_OUTLINE_LAYER = "tarmoto-segment-selected-outline";
const SEGMENT_SELECTED_GLOW_LAYER = "tarmoto-segment-selected-glow";
const SEGMENT_SELECTED_LINE_LAYER = "tarmoto-segment-selected-line";
// Slate casing colour for the neutral selection outline — reads as "selected"
// without encoding any quality grade.
const SEGMENT_SELECTED_NEUTRAL_COLOR = "#334155";
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
    showQuality: showQualityProp,
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
  // Operator kill switch for the road-quality overlay, applied INSIDE the canvas
  // so every map that renders it is covered by one gate. Fails safe: the overlay
  // stays visible until a `force_off` is confirmed.
  //
  // It gates the HIT layer too, not just the painted one. The hit layer is
  // deliberately uncapped for planner snapping, so leaving it alive would let a
  // click on an invisible road still pull that segment's quality score and
  // history — serving the exact data the kill switch was flipped to stop.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const showQuality = showQualityProp && qualityOverlayEnabled;
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
  // renders. Resolves for BOTH authenticated riders (/users/me) and anonymous
  // public viewers (the global launch-mode override) — see useRoadQualityZoomCap
  // — and fails closed to the free floor until it resolves.
  const { limit: qualityZoomLimit, isResolved: qualityZoomResolved } =
    useRoadQualityZoomCap();
  // Per the rollout spec the limit feeds the overlay layer's maxzoom DIRECTLY,
  // so MapLibre stops drawing quality past the cap (free → 12, unlimited → the
  // source ceiling 18); fails closed to the free floor until it resolves.
  const qualityMaxZoom = resolveQualityLayerMaxZoom(
    qualityZoomLimit,
    qualityZoomResolved,
  );
  // A cap AT OR BELOW the layer's floor (`TARMOTO_ROADS_MIN_ZOOM`) has no valid
  // render range — MapLibre rejects `setLayerZoomRange`/`maxzoom` where
  // `minzoom >= maxzoom`, which would leave the previous (higher) cap active and
  // leak quality past the low cap. Represent such caps by HIDING the
  // quality-graded layers, using a valid placeholder maxzoom so the layers stay
  // addable and can be restored if the cap later rises above the floor.
  const qualityRenderable = qualityMaxZoom > TARMOTO_ROADS_MIN_ZOOM;
  const qualityLayerMaxzoom = qualityRenderable
    ? qualityMaxZoom
    : TARMOTO_ROADS_MIN_ZOOM + 1;
  // The quality layers are added inside the `load` handler below, a closure
  // captured once at map-init time — bounce the latest values through refs so
  // that closure reads the current cap rather than the one from first render.
  const qualityLayerMaxzoomRef = useRef(qualityLayerMaxzoom);
  qualityLayerMaxzoomRef.current = qualityLayerMaxzoom;
  const qualityRenderableRef = useRef(qualityRenderable);
  qualityRenderableRef.current = qualityRenderable;
  // Same idiom, same reason: the initialisation effect's `load` callback runs
  // after the style finishes, which can be well after the effect closed over its
  // values. Reading the switch through a ref means a `force_off` that resolves in
  // that gap is applied when the layers are actually ADDED, instead of adding
  // them visible and relying on the correcting effect to undo it.
  const qualityOverlayEnabledRef = useRef(qualityOverlayEnabled);
  qualityOverlayEnabledRef.current = qualityOverlayEnabled;

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
        maxzoom: qualityLayerMaxzoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // Ref, not the closed-over `showQuality`, for the same reason as the
          // selection layers below: this runs in the `load` callback, which can
          // fire long after the effect captured its values.
          visibility:
            showQualityProp &&
            qualityOverlayEnabledRef.current &&
            qualityRenderableRef.current
              ? "visible"
              : "none",
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

      // Invisible, UNCAPPED hit target (see TARMOTO_ROAD_HIT_LAYER). Same road
      // geometry + promoted `id`/`quality_score` as the overlay, but no
      // `maxzoom` and zero opacity — kept queryable for snapping / tap / hover
      // at every zoom while the visible overlay stays entitlement-capped. A
      // fat, transparent line gives a comfortable snap radius.
      map.addLayer({
        id: TARMOTO_ROAD_HIT_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility:
            showQualityProp && qualityOverlayEnabledRef.current
              ? "visible"
              : "none",
        },
        paint: {
          "line-color": "#000000",
          "line-width": 12,
          "line-opacity": 0,
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
      // Neutral casing (uncapped) — added first so it sits BELOW the quality
      // glow/line. Same crisp width as SEGMENT_SELECTED_LINE_LAYER, so below the
      // cap the opaque quality line covers it exactly (look unchanged); above
      // the cap it's the surviving selection outline.
      map.addLayer({
        id: SEGMENT_SELECTED_OUTLINE_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        filter: NO_SEGMENT_FILTER,
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        // No maxzoom: it encodes no quality grade, so it must NOT be clamped —
        // that is exactly what keeps selection feedback alive past the cap.
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // The kill switch applies at ADD time too. The correcting effect below
          // runs only after `setReady`, so a resolved `force_off` with a segment
          // already selected at mount would otherwise paint the selection for
          // the window between map load and that effect.
          visibility:
            selectedSegmentId && qualityOverlayEnabledRef.current
              ? "visible"
              : "none",
        },
        paint: {
          "line-color": SEGMENT_SELECTED_NEUTRAL_COLOR,
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
      map.addLayer({
        id: SEGMENT_SELECTED_GLOW_LAYER,
        type: "line",
        source: TARMOTO_ROADS_SOURCE,
        "source-layer": "quality",
        filter: NO_SEGMENT_FILTER,
        minzoom: TARMOTO_ROADS_MIN_ZOOM,
        // The glow/line highlight is quality-GRADED (QUALITY_LINE_COLOR), so it
        // carries the same entitlement zoom cap as the overlay — otherwise a
        // free rider could read a segment's quality colour past the cap by
        // selecting it. The neutral outline above stays uncapped for feedback.
        // See the runtime clamp effect below.
        maxzoom: qualityLayerMaxzoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // A filtered-but-visible layer still makes MapLibre fetch its source.
          // Keep the selected-road layers hidden until a segment is selected
          // (and while the cap is at/below the layer floor).
          visibility:
            selectedSegmentId &&
            qualityRenderableRef.current &&
            qualityOverlayEnabledRef.current
              ? "visible"
              : "none",
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
        maxzoom: qualityLayerMaxzoomRef.current,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility:
            selectedSegmentId &&
            qualityRenderableRef.current &&
            qualityOverlayEnabledRef.current
              ? "visible"
              : "none",
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
    // Hide the quality overlay when the cap is at/below the layer floor — it has
    // no valid render range, so the alternative (an invalid maxzoom) would leak.
    setVisibility(map, TARMOTO_QUALITY_LAYER, showQuality && qualityRenderable);
    // The hit target shadows the quality overlay's ON/OFF state (but not its
    // zoom cap) so pointer interaction is available exactly when the roads are —
    // interaction survives the cap, so it is NOT gated on `qualityRenderable`.
    setVisibility(map, TARMOTO_ROAD_HIT_LAYER, showQuality);
    setVisibility(map, TARMOTO_SURFACE_LAYER, showSurface);
  }, [ready, showQuality, showSurface, qualityRenderable]);

  // ── quality overlay maxzoom from the road_quality_max_zoom entitlement ──
  // The cap can resolve (or change, e.g. a tier upgrade) after the layers were
  // already added with the ref-captured value above; apply changes live. Every
  // layer that renders the quality-GRADED colour (the overlay + both selection
  // highlights) carries the cap, so selecting a segment can't leak its quality
  // colour past the cap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // A cap at/below the layer floor has no valid range; the visibility effects
    // hide these layers instead, so skip `setLayerZoomRange` (MapLibre rejects
    // `minzoom >= maxzoom`, which would otherwise leave the previous cap active
    // and leak quality past the low cap).
    if (!qualityRenderable) return;
    for (const layerId of [
      TARMOTO_QUALITY_LAYER,
      SEGMENT_SELECTED_GLOW_LAYER,
      SEGMENT_SELECTED_LINE_LAYER,
    ]) {
      if (map.getLayer(layerId)) {
        map.setLayerZoomRange(layerId, TARMOTO_ROADS_MIN_ZOOM, qualityMaxZoom);
      }
    }
  }, [qualityMaxZoom, qualityRenderable]);

  // ── selected-segment highlight filter ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter: FilterSpecification = selectedSegmentId
      ? ["==", ["get", "id"], selectedSegmentId]
      : NO_SEGMENT_FILTER;
    const selected = Boolean(selectedSegmentId);
    for (const layer of [
      SEGMENT_SELECTED_OUTLINE_LAYER,
      SEGMENT_SELECTED_GLOW_LAYER,
      SEGMENT_SELECTED_LINE_LAYER,
    ]) {
      if (!map.getLayer(layer)) continue;
      map.setFilter(layer, filter);
      // The neutral OUTLINE is uncapped, so it shows whenever a segment is
      // selected. The quality-GRADED glow/line additionally require a valid cap
      // range — hide them when the cap is at/below the layer floor.
      //
      // ALL THREE also respect the operator kill switch. This effect keys off
      // `selectedSegmentId`, not `showQuality`, so without it a segment that was
      // already selected when the switch flipped would stay drawn — and the
      // graded layers would keep the quality source alive, still fetching the
      // tiles the kill was meant to stop.
      const visible =
        layer === SEGMENT_SELECTED_OUTLINE_LAYER
          ? selected && qualityOverlayEnabled
          : selected && qualityRenderable && qualityOverlayEnabled;
      setVisibility(map, layer, visible);
    }
  }, [ready, selectedSegmentId, qualityRenderable, qualityOverlayEnabled]);

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
