"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { type Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";
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
  type SanitizedRiddenSegment,
} from "@/lib/road-map-layer";
import {
  ensureRideRouteLayers,
  setRideRouteLayersVisible,
  setRideRouteSourceData,
  RIDE_ROUTE_LAYER,
  RIDE_ROUTE_SOURCE,
  RIDE_ROUTE_COLOR,
  type RideTrack,
} from "@/components/map/RideRouteLayer";
import {
  pickNearestLineFeature,
  readSegmentId,
  SEGMENT_HIT_PADDING_PX,
} from "@/lib/map-segment-hit";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

const SOURCE_ID = "tarmoto-roads";
const QUALITY_LAYER = "quality";
const NO_TRACKS: readonly RideTrack[] = [];
// Wider, opaque overlay of the clicked ride's line so it reads as "selected"
// while its popover is open. A rideId no real ride uses hides it.
const RIDE_ROUTE_HIGHLIGHT_LAYER = "road-map-ride-route-highlight";
const NO_RIDE_MATCH = "__none__";

export interface PersonalRoadMapHandle {
  flyTo: (coords: { lat: number; lng: number; zoom?: number }) => void;
  /**
   * Current map camera centre, or `null` before the map is ready. Reflects
   * manual panning (which never touches the page's `center` state), so the
   * share snapshot can frame on whatever the rider is actually looking at.
   */
  getCenter: () => { lat: number; lng: number } | null;
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
  ridden: readonly SanitizedRiddenSegment[];
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
   * Coverage view: called when the rider clicks any road (ridden or not) with
   * its segment id, or empty map with `null`. Drives the segment detail drawer.
   * Omit on the read-only share page.
   */
  onSegmentSelect?: (segmentId: string | null) => void;
  /**
   * Routes view: called with a ride id when the rider clicks one of their route
   * lines. Drives the ride popover.
   */
  onRouteSelect?: (rideId: string) => void;
  /**
   * Segment whose detail drawer is open — MapCanvas paints its highlight glow
   * over this feature on the shared road source.
   */
  selectedSegmentId?: string | null;
  /** Ride whose popover is open — its route line is drawn wider/opaque. */
  selectedRideId?: string | null;
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
      showCoverage: showCoverageProp = false,
      forceColorScheme,
      dimColor,
      onSegmentSelect,
      onRouteSelect,
      selectedSegmentId,
      selectedRideId,
    },
    ref,
  ) {
    // Operator kill switch. This map builds its OWN layers from the `quality`
    // source rather than using MapCanvas's, so the gate there does not reach it:
    // a `force_off` would leave the ridden-coverage overlay drawing quality
    // geometry and its click handler serving segment detail.
    //
    // Only the COVERAGE view is gated. The rider's own finished routes are their
    // data, not road-quality data, and killing the quality overlay must not hide
    // the rides they recorded.
    const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
      "road_quality_overlay",
    );
    const showCoverage = showCoverageProp && qualityOverlayEnabled;
    const canvasRef = useRef<MapCanvasHandle>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const [ready, setReady] = useState(false);

    // Read the latest callback from a ref so the click handler (bound once on
    // map load) doesn't need re-binding when the prop identity changes.
    const onSegmentSelectRef = useRef(onSegmentSelect);
    useEffect(() => {
      onSegmentSelectRef.current = onSegmentSelect;
    }, [onSegmentSelect]);
    const onRouteSelectRef = useRef(onRouteSelect);
    useEffect(() => {
      onRouteSelectRef.current = onRouteSelect;
    }, [onRouteSelect]);
    // The click handler binds once on map load; read the live view mode from a
    // ref so a toggle doesn't need a rebind.
    const viewRef = useRef({ showRoutes, showCoverage });
    useEffect(() => {
      viewRef.current = { showRoutes, showCoverage };
    }, [showRoutes, showCoverage]);
    // The layers are added in a `load` callback that can fire after the switch
    // resolves, so its initial visibility has to come from a ref — assigned
    // during RENDER, not in an effect. An effect runs after paint, which leaves
    // a window where the callback reads a stale `true` and brings the dim layer
    // up visible, starting the very tile requests the kill exists to stop.
    // Matches how `MapCanvas` does it.
    const qualityOverlayEnabledRef = useRef(qualityOverlayEnabled);
    qualityOverlayEnabledRef.current = qualityOverlayEnabled;

    // A flyTo requested before the map is ready (e.g. a cached geolocation
    // resolving during mount) is queued and replayed on ready — otherwise it'd
    // no-op and the map would stay at the initial fallback centre.
    const pendingFlyToRef = useRef<{
      lat: number;
      lng: number;
      zoom?: number;
    } | null>(null);
    const flyToTarget = useCallback(
      (
        map: MapLibreMap,
        target: { lat: number; lng: number; zoom?: number },
      ) => {
        map.flyTo({
          center: [target.lng, target.lat],
          zoom: target.zoom ?? Math.max(map.getZoom(), 9),
          essential: true,
        });
      },
      [],
    );
    useImperativeHandle(ref, () => ({
      flyTo: (target) => {
        const map = mapRef.current;
        if (!map) {
          pendingFlyToRef.current = target;
          return;
        }
        flyToTarget(map, target);
      },
      getCenter: () => {
        const map = mapRef.current;
        if (!map) return null;
        const c = map.getCenter();
        return { lat: c.lat, lng: c.lng };
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
            layout: {
              "line-cap": "round",
              "line-join": "round",
              visibility: qualityOverlayEnabledRef.current ? "visible" : "none",
            },
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

        // Selected-ride highlight: a wider, opaque overlay on the same source,
        // filtered to the open ride by the effect below.
        if (!map.getLayer(RIDE_ROUTE_HIGHLIGHT_LAYER)) {
          map.addLayer({
            id: RIDE_ROUTE_HIGHLIGHT_LAYER,
            type: "line",
            source: RIDE_ROUTE_SOURCE,
            filter: ["==", ["get", "rideId"], NO_RIDE_MATCH],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": RIDE_ROUTE_COLOR,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                8,
                6,
                12,
                9,
                16,
                12,
              ] as ExpressionSpecification,
              "line-opacity": 1,
            },
          });
        }

        // Hit-testing binds to the cyan layer, which paints every quality
        // feature (unridden ones at opacity 0 via feature-state) so MapLibre
        // still hit-tests their geometry; the `meta` lookup distinguishes
        // ridden targets from transparent ones.
        //
        // Hover: only a *ridden* segment shows the pointer cursor — clicking
        // it opens the detail popover the page renders in the map corner.
        const setPointer = () => {
          map.getCanvas().style.cursor = "pointer";
        };
        const clearPointer = () => {
          map.getCanvas().style.cursor = "";
        };
        // Coverage view: any road is clickable, so the whole dim base is a
        // hover target. Routes view: only the ride lines are.
        const onRoadHover = () => {
          if (viewRef.current.showCoverage) setPointer();
        };
        const onRouteHover = () => {
          if (viewRef.current.showRoutes) setPointer();
        };
        map.on("mousemove", ROAD_MAP_DIM_LAYER_ID, onRoadHover);
        map.on("mouseleave", ROAD_MAP_DIM_LAYER_ID, clearPointer);
        map.on("mousemove", RIDE_ROUTE_LAYER, onRouteHover);
        map.on("mouseleave", RIDE_ROUTE_LAYER, clearPointer);

        const handleMapClick = (ev: MapMouseEvent) => {
          const { showRoutes: routesOn, showCoverage: coverageOn } =
            viewRef.current;

          // Routes view: a click on one of the ride lines opens its popover.
          if (routesOn && map.getLayer(RIDE_ROUTE_LAYER)) {
            const routeHits = map.queryRenderedFeatures(ev.point, {
              layers: [RIDE_ROUTE_LAYER],
            });
            const rideId = routeHits[0]?.properties?.rideId;
            if (typeof rideId === "string") {
              onRouteSelectRef.current?.(rideId);
              return;
            }
          }

          // Coverage view: select the nearest road under a padded box — any
          // road, ridden or not (matching the explorer), so the whole network
          // is browsable — or deselect on a miss. The dim base layer paints
          // every segment, so it's the hit target regardless of ridden state.
          if (coverageOn) {
            const select = onSegmentSelectRef.current;
            if (!select) return;
            const feature = pickNearestLineFeature(
              map,
              ev.point,
              [ROAD_MAP_DIM_LAYER_ID],
              SEGMENT_HIT_PADDING_PX,
            );
            select(readSegmentId(feature) ?? null);
          }
        };

        map.on("click", handleMapClick);

        setReady(true);

        // Replay a fly-to that arrived before the map was ready (queued above).
        if (pendingFlyToRef.current) {
          const target = pendingFlyToRef.current;
          pendingFlyToRef.current = null;
          flyToTarget(map, target);
        }
        // `dimColor` / `showCoverage` are read when the layers are added on map
        // load; stable per mount (the effects handle later changes), but listed
        // so the linter is satisfied.
      },
      [dimColor, showCoverage, flyToTarget],
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

    // Highlight the open ride's line (routes view only).
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready || !map.getLayer(RIDE_ROUTE_HIGHLIGHT_LAYER)) return;
      map.setLayoutProperty(
        RIDE_ROUTE_HIGHLIGHT_LAYER,
        "visibility",
        showRoutes ? "visible" : "none",
      );
      map.setFilter(RIDE_ROUTE_HIGHLIGHT_LAYER, [
        "==",
        ["get", "rideId"],
        showRoutes && selectedRideId ? selectedRideId : NO_RIDE_MATCH,
      ]);
    }, [ready, showRoutes, selectedRideId]);

    // Coverage overlay visibility (the ridden-segment exploration view). Hiding
    // it also drops its hit-testing, so segment clicks only fire in that view.
    //
    // The dim base normally stays on in BOTH views, to give the rider's routes
    // some road context. An operator kill is the exception: it is drawn from the
    // same `quality` tile source, so leaving it up would keep requesting the
    // tiles the switch exists to stop, and would still be painting road-quality
    // geometry after the overlay was killed. The rider's own route lines come
    // from a different source and stay.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready || !map.getLayer(ROAD_MAP_RIDDEN_LAYER_ID)) return;
      map.setLayoutProperty(
        ROAD_MAP_RIDDEN_LAYER_ID,
        "visibility",
        showCoverage ? "visible" : "none",
      );
      if (map.getLayer(ROAD_MAP_DIM_LAYER_ID)) {
        map.setLayoutProperty(
          ROAD_MAP_DIM_LAYER_ID,
          "visibility",
          qualityOverlayEnabled ? "visible" : "none",
        );
      }
    }, [ready, showCoverage, qualityOverlayEnabled]);

    return (
      <MapCanvas
        ref={canvasRef}
        center={{ lng: initialCenter.lng, lat: initialCenter.lat }}
        zoom={initialCenter.zoom}
        showQuality={false}
        showSurface={false}
        selectedSegmentId={selectedSegmentId ?? null}
        {...(forceColorScheme !== undefined ? { forceColorScheme } : {})}
        onReady={handleReady}
      />
    );
  },
);
