"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import type { MapColorScheme } from "@/lib/map-style";
import {
  DIM_LINE_COLOR,
  RIDDEN_LINE_COLOR,
  ROAD_MAP_DIM_LAYER_ID,
  ROAD_MAP_LAYER_LINE_WIDTH,
  ROAD_MAP_RIDDEN_LAYER_ID,
  ROAD_MAP_RIDDEN_LINE_WIDTH,
  indexRiddenSegments,
  type RiddenSegment,
} from "@/lib/road-map-layer";
import {
  ensureRideRouteLayers,
  setRideRouteLayersVisible,
  setRideRouteSourceData,
  type RideTrack,
} from "@/components/map/RideRouteLayer";

const SOURCE_ID = "tarmoto-roads";
const QUALITY_LAYER = "quality";
const NO_TRACKS: readonly RideTrack[] = [];

export interface PersonalRoadMapHandle {
  flyTo: (coords: { lat: number; lng: number; zoom?: number }) => void;
}

interface Props {
  /**
   * Initial center for the map. Updates after mount come from `flyTo()` via
   * the imperative handle so the map doesn't yank the view on every parent
   * re-render.
   */
  initialCenter: { lat: number; lng: number; zoom: number };
  /**
   * Filtered ridden segments (period-aware). The cyan layer paints the
   * features in this list; everything else falls through to the dim base.
   */
  ridden: readonly RiddenSegment[];
  /**
   * The rider's finished ride routes (GPS tracks). Drawn as indigo lines — the
   * primary "these are my rides" view, distinct from the ridden-segment
   * coverage. Empty/omitted draws no routes.
   */
  rideTracks?: readonly RideTrack[];
  /** Draw the ride-route lines (default view). */
  showRoutes?: boolean;
  /** Draw the ridden-segment coverage overlay (the exploration view). */
  showCoverage?: boolean;
  /**
   * Pin the basemap theme instead of following the viewer preference — the
   * public share page always renders on cream.
   */
  forceColorScheme?: MapColorScheme;
  /**
   * Override the unridden (dim) line colour. Defaults to the dashboard's
   * dark-surface slate; the cream share page passes a light tan so unridden
   * roads read against the light basemap.
   */
  dimColor?: string;
  /**
   * Called when the rider clicks a ridden segment (with its id) or clicks
   * empty map / an unridden road (with `null`). Drives the detail popover the
   * page renders in the map corner. Omit on the read-only share page.
   */
  onSegmentSelect?: (segmentId: string | null) => void;
}

/**
 * Personal road-map MapLibre overlay (US-50).
 *
 * Mounts the shared MapCanvas (which provides the basemap + the
 * `tarmoto-roads` vector source) but disables its quality/surface layers —
 * the road-map view paints its own dim base + cyan ridden overlay using
 * `feature-state` for O(1) membership at draw time. The hover popup
 * surfaces the most-recent ride date and quality reading for the segment
 * under the cursor.
 */
export const PersonalRoadMap = forwardRef<PersonalRoadMapHandle, Props>(
  function PersonalRoadMap(
    {
      initialCenter,
      ridden,
      rideTracks = NO_TRACKS,
      showRoutes = true,
      showCoverage = false,
      forceColorScheme,
      dimColor,
      onSegmentSelect,
    },
    ref,
  ) {
    const canvasRef = useRef<MapCanvasHandle>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const [ready, setReady] = useState(false);

    const indexedRidden = useMemo(() => indexRiddenSegments(ridden), [ridden]);
    const indexedRiddenRef = useRef(indexedRidden);
    useEffect(() => {
      indexedRiddenRef.current = indexedRidden;
    }, [indexedRidden]);
    // Read the latest callback from a ref so the click handler (bound once on
    // map load) doesn't need re-binding when the prop identity changes.
    const onSegmentSelectRef = useRef(onSegmentSelect);
    useEffect(() => {
      onSegmentSelectRef.current = onSegmentSelect;
    }, [onSegmentSelect]);

    useImperativeHandle(ref, () => ({
      flyTo: ({ lat, lng, zoom }) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({
          center: [lng, lat],
          zoom: zoom ?? Math.max(map.getZoom(), 9),
          essential: true,
        });
      },
    }));

    const handleReady = useCallback(
      (map: MapLibreMap) => {
        mapRef.current = map;

        // Place both layers ABOVE the basemap labels but BELOW the canvas's
        // existing quality/surface layers (which the page renders invisible
        // anyway via showQuality={false} / showSurface={false}). We insert
        // before the canvas's quality layer so the dim base + cyan overlay
        // sit at the same z-position as the rest of the road styling.
        const beforeId = map.getLayer("tarmoto-quality")
          ? "tarmoto-quality"
          : undefined;

        map.addLayer(
          {
            id: ROAD_MAP_DIM_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            "source-layer": QUALITY_LAYER,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": dimColor ?? DIM_LINE_COLOR,
              "line-width":
                ROAD_MAP_LAYER_LINE_WIDTH as unknown as ExpressionSpecification,
              "line-opacity": dimColor ? 0.7 : 0.35,
            },
          },
          beforeId,
        );

        map.addLayer(
          {
            id: ROAD_MAP_RIDDEN_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            "source-layer": QUALITY_LAYER,
            layout: {
              "line-cap": "round",
              "line-join": "round",
              // Start in the correct view (routes default → hidden) so the
              // coverage overlay doesn't flash before the effect runs.
              visibility: showCoverage ? "visible" : "none",
            },
            paint: {
              "line-color": RIDDEN_LINE_COLOR,
              "line-width":
                ROAD_MAP_RIDDEN_LINE_WIDTH as unknown as ExpressionSpecification,
              // Only paint features whose feature-state.ridden has been set
              // by the `useEffect` below. Anything else stays transparent so
              // the dim base shows through.
              "line-opacity": [
                "case",
                ["boolean", ["feature-state", "ridden"], false],
                0.95,
                0,
              ] as ExpressionSpecification,
            },
          },
          beforeId,
        );

        // Ride-route lines sit ON TOP of the coverage layers — they're the
        // primary "my finished rides" view. Source data + visibility are driven
        // by the effects below (which run as soon as `ready` flips), so the
        // initial flag here is just a placeholder.
        ensureRideRouteLayers(map, { visible: true });

        // Hit-testing binds to the cyan layer, which paints every quality
        // feature (unridden ones at opacity 0 via feature-state) so MapLibre
        // still hit-tests their geometry; the `meta` lookup distinguishes
        // ridden targets from transparent ones.
        //
        // Hover: only a *ridden* segment shows the pointer cursor — clicking
        // it opens the detail popover the page renders in the map corner.
        const handlePointerMove = (
          ev: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] },
        ) => {
          const id = ev.features?.[0]?.id;
          const isRidden =
            typeof id === "string" && indexedRiddenRef.current.has(id);
          map.getCanvas().style.cursor = isRidden ? "pointer" : "";
        };

        const handlePointerLeave = () => {
          map.getCanvas().style.cursor = "";
        };

        map.on("mousemove", ROAD_MAP_RIDDEN_LAYER_ID, handlePointerMove);
        map.on("mouseleave", ROAD_MAP_RIDDEN_LAYER_ID, handlePointerLeave);

        // Click anywhere: select the first ridden segment under the point, or
        // deselect (close the popover) when the click misses every ridden road.
        const handleMapClick = (ev: MapMouseEvent) => {
          const select = onSegmentSelectRef.current;
          if (!select) return;
          const hits = map.queryRenderedFeatures(ev.point, {
            layers: [ROAD_MAP_RIDDEN_LAYER_ID],
          });
          for (const feature of hits) {
            const id = feature.id;
            if (typeof id === "string" && indexedRiddenRef.current.has(id)) {
              select(id);
              return;
            }
          }
          select(null);
        };

        map.on("click", handleMapClick);

        setReady(true);
        // `dimColor` / `showCoverage` are read when the layers are added on map
        // load; stable per mount (the effects handle later changes), but listed
        // so the linter is satisfied.
      },
      [dimColor, showCoverage],
    );

    // Apply `feature-state.ridden = true` for every segment in the current
    // (period-filtered) ridden set. `removeFeatureState` clears the whole
    // source-layer in one call — much cheaper than diffing the previous
    // set, and feature-state is cumulative so re-setting on every change
    // is safe.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready) return;
      map.removeFeatureState({ source: SOURCE_ID, sourceLayer: QUALITY_LAYER });
      for (const seg of ridden) {
        map.setFeatureState(
          { source: SOURCE_ID, sourceLayer: QUALITY_LAYER, id: seg.id },
          { ridden: true },
        );
      }
    }, [ready, ridden]);

    // Keep the ride-route source in sync with the fetched tracks.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready) return;
      setRideRouteSourceData(map, rideTracks);
    }, [ready, rideTracks]);

    // Routes layer visibility (the default "my rides" view).
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready) return;
      setRideRouteLayersVisible(map, showRoutes);
    }, [ready, showRoutes]);

    // Coverage overlay visibility (the ridden-segment exploration view). Hiding
    // it also drops its hit-testing, so segment clicks only fire in that view.
    // The dim base stays on in both views to give the routes road context.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready || !map.getLayer(ROAD_MAP_RIDDEN_LAYER_ID)) return;
      map.setLayoutProperty(
        ROAD_MAP_RIDDEN_LAYER_ID,
        "visibility",
        showCoverage ? "visible" : "none",
      );
    }, [ready, showCoverage]);

    return (
      <MapCanvas
        ref={canvasRef}
        center={{ lng: initialCenter.lng, lat: initialCenter.lat }}
        zoom={initialCenter.zoom}
        showQuality={false}
        showSurface={false}
        {...(forceColorScheme !== undefined ? { forceColorScheme } : {})}
        onReady={handleReady}
      />
    );
  },
);
