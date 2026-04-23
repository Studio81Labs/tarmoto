"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { Layers3, Route, Square, X } from "lucide-react";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawBbox,
} from "@/components/map/RegionDrawControl";
import type { Trip } from "@/lib/types";
import {
  buildTripPlannerRouteCollection,
  buildTripPlannerWaypointCollection,
  getTripPlannerBounds,
} from "@/lib/trip-planner-map";

const ROUTE_SOURCE = "trip-planner-route";
const WAYPOINT_SOURCE = "trip-planner-waypoints";
const ROUTE_LINE = "trip-planner-route-line";
const WAYPOINT_CIRCLE = "trip-planner-waypoint-circle";
const WAYPOINT_LABEL = "trip-planner-waypoint-label";

export function TripPlannerMap({ trip }: { trip: Trip | null }) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  const fittedBoundsKeyRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showQuality, setShowQuality] = useState(true);
  const [showSurface, setShowSurface] = useState(false);
  const [drawMode, setDrawMode] = useState<"idle" | "drawing">("idle");
  const [drawnRegion, setDrawnRegion] = useState<RegionDrawBbox | null>(null);

  const routeCollection = useMemo(
    () => buildTripPlannerRouteCollection(trip),
    [trip],
  );
  const waypointCollection = useMemo(
    () => buildTripPlannerWaypointCollection(trip),
    [trip],
  );
  const tripBounds = useMemo(() => getTripPlannerBounds(trip), [trip]);
  const tripBoundsKey = useMemo(
    () => (tripBounds ? tripBounds.join(",") : null),
    [tripBounds],
  );
  const waypointCount = waypointCollection.features.length;

  useEffect(() => {
    if (!tripBoundsKey) {
      fittedBoundsKeyRef.current = null;
      return;
    }
    if (tripBoundsKey !== fittedBoundsKeyRef.current) {
      fittedBoundsKeyRef.current = null;
    }
  }, [tripBoundsKey]);

  const handleReady = (map: MapLibreMap) => {
    ensurePlannerLayers(map);
    drawRef.current?.destroy();
    drawRef.current = createRegionDrawControl(map, {
      onRegionDrawn: (bbox) => setDrawnRegion(bbox),
      onModeChange: setDrawMode,
    });
    setReady(true);
  };

  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    syncGeoJsonSource(map, ROUTE_SOURCE, routeCollection);
    syncGeoJsonSource(map, WAYPOINT_SOURCE, waypointCollection);
  }, [ready, routeCollection, waypointCollection]);

  useEffect(() => {
    if (!ready) return;
    drawRef.current?.setDrawn(drawnRegion);
  }, [drawnRegion, ready]);

  useEffect(() => {
    const map = handleRef.current?.map;
    if (
      !map ||
      !ready ||
      !tripBounds ||
      !tripBoundsKey ||
      fittedBoundsKeyRef.current === tripBoundsKey
    ) {
      return;
    }
    fittedBoundsKeyRef.current = tripBoundsKey;
    map.fitBounds(
      [
        [tripBounds[0], tripBounds[1]],
        [tripBounds[2], tripBounds[3]],
      ],
      {
        padding: 72,
        duration: 0,
        maxZoom: 11,
      },
    );
  }, [ready, tripBounds, tripBoundsKey]);

  useEffect(() => {
    return () => {
      drawRef.current?.destroy();
      drawRef.current = null;
    };
  }, []);

  return (
    <MapCanvas
      ref={handleRef}
      center={{ lng: 14.5, lat: 50.1 }}
      zoom={7}
      showQuality={showQuality}
      showSurface={showSurface}
      onReady={handleReady}
    >
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={showQuality}
            aria-label={`Road quality overlay ${showQuality ? "on" : "off"}`}
            onClick={() => setShowQuality((value) => !value)}
            className={toggleClassName(showQuality)}
          >
            <Layers3 size={14} />
            Road quality
          </button>
          <button
            type="button"
            aria-pressed={showSurface}
            aria-label={`Surface overlay ${showSurface ? "on" : "off"}`}
            onClick={() => setShowSurface((value) => !value)}
            className={toggleClassName(showSurface)}
          >
            <Layers3 size={14} />
            Surface
          </button>
        </div>

        {drawMode === "idle" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.start()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 transition hover:bg-slate-800"
          >
            <Square size={14} />
            Draw region
          </button>
        ) : (
          <button
            type="button"
            onClick={() => drawRef.current?.cancel()}
            className="flex items-center gap-1.5 rounded-lg border border-tarmoto-cyan bg-tarmoto-cyan/20 px-3 py-2 text-sm text-tarmoto-cyan transition hover:bg-tarmoto-cyan/30"
          >
            <X size={14} />
            Cancel drawing
          </button>
        )}

        {drawnRegion && drawMode === "idle" ? (
          <button
            type="button"
            onClick={() => {
              drawRef.current?.clearDrawn();
              setDrawnRegion(null);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            <X size={12} />
            Clear region
          </button>
        ) : null}
      </div>

      <div className="absolute right-3 top-3 z-10 w-72 rounded-2xl border border-slate-800 bg-slate-950/90 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Route size={16} className="text-tarmoto-cyan" />
          Planner map
        </div>
        <p className="mt-2 text-sm text-slate-300">
          {trip
            ? `${trip.days.length} day${trip.days.length === 1 ? "" : "s"} · ${waypointCount} waypoint${waypointCount === 1 ? "" : "s"}`
            : "Load the demo trip or import GPX/KML to see your route on the map."}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Until route generation lands, the planner previews each day as a
          direct line between its ordered waypoints.
        </p>
      </div>
    </MapCanvas>
  );
}

function toggleClassName(active: boolean): string {
  return `flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition ${
    active
      ? "border-tarmoto-cyan bg-tarmoto-cyan/15 text-tarmoto-cyan"
      : "border-slate-700 bg-slate-900/90 text-slate-300 hover:bg-slate-800"
  }`;
}

function ensurePlannerLayers(map: MapLibreMap): void {
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: "geojson",
      data: buildTripPlannerRouteCollection(null),
    });
  }
  if (!map.getLayer(ROUTE_LINE)) {
    map.addLayer({
      id: ROUTE_LINE,
      type: "line",
      source: ROUTE_SOURCE,
      paint: {
        "line-color": "#F8FAFC",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2, 10, 4, 14, 6],
        "line-opacity": 0.9,
      },
    });
  }

  if (!map.getSource(WAYPOINT_SOURCE)) {
    map.addSource(WAYPOINT_SOURCE, {
      type: "geojson",
      data: buildTripPlannerWaypointCollection(null),
    });
  }
  if (!map.getLayer(WAYPOINT_CIRCLE)) {
    map.addLayer({
      id: WAYPOINT_CIRCLE,
      type: "circle",
      source: WAYPOINT_SOURCE,
      paint: {
        "circle-radius": [
          "match",
          ["get", "waypointType"],
          "start",
          7,
          "end",
          7,
          5.5,
        ],
        "circle-color": [
          "match",
          ["get", "waypointType"],
          "start",
          "#22C55E",
          "end",
          "#F97316",
          "#0ED3CF",
        ],
        "circle-stroke-color": "#020617",
        "circle-stroke-width": 2,
      },
    });
  }
  if (!map.getLayer(WAYPOINT_LABEL)) {
    map.addLayer({
      id: WAYPOINT_LABEL,
      type: "symbol",
      source: WAYPOINT_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-offset": [0, 1.25],
        "text-size": 11,
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#E2E8F0",
        "text-halo-color": "#020617",
        "text-halo-width": 1,
      },
    });
  }
}

function syncGeoJsonSource(
  map: MapLibreMap,
  sourceId: string,
  data: GeoJSON.FeatureCollection,
): void {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }

  map.addSource(sourceId, {
    type: "geojson",
    data,
  });
}
