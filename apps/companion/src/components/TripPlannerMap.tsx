"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  AlertTriangle,
  Layers3,
  Mountain,
  Route,
  Square,
  X,
} from "lucide-react";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawBbox,
} from "@/components/map/RegionDrawControl";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import {
  buildTripClosureRoutes,
  detourLengthKm,
  formatClosureWindow,
} from "@/lib/closures-summary";
import { monthLabel } from "@/lib/passes-summary";
import {
  buildPlannerClosureLineCollection,
  buildPlannerClosureMarkerCollection,
  buildPlannerPassMarkerCollection,
} from "@/lib/trip-planner-overlays";
import {
  buildTripPlannerRouteCollection,
  buildTripPlannerWaypointCollection,
  getTripPlannerBounds,
} from "@/lib/trip-planner-map";
import type { Trip } from "@/lib/types";
import { formatDistance } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";

const ROUTE_SOURCE = "trip-planner-route";
const WAYPOINT_SOURCE = "trip-planner-waypoints";
const ROUTE_LINE = "trip-planner-route-line";
const WAYPOINT_CIRCLE = "trip-planner-waypoint-circle";
const WAYPOINT_LABEL = "trip-planner-waypoint-label";
const CLOSURE_LINE_SOURCE = "trip-planner-closure-lines";
const CLOSURE_MARKER_SOURCE = "trip-planner-closure-markers";
const PASS_MARKER_SOURCE = "trip-planner-pass-markers";
const CLOSURE_LINE_LAYER = "trip-planner-closure-lines";
const CLOSURE_MARKER_LAYER = "trip-planner-closure-markers";
const PASS_MARKER_LAYER = "trip-planner-pass-markers";

interface TripPlannerMapProps {
  trip: Trip | null;
  month: number;
  closuresData?: ClosuresQueryResult;
  passesData?: PassesQueryResult;
}

export function TripPlannerMap({
  trip,
  month,
  closuresData,
  passesData,
}: TripPlannerMapProps) {
  if (closuresData && passesData) {
    return (
      <TripPlannerMapContent
        trip={trip}
        month={month}
        closuresData={closuresData}
        passesData={passesData}
      />
    );
  }

  return <FetchedTripPlannerMap trip={trip} month={month} />;
}

function FetchedTripPlannerMap({
  trip,
  month,
}: {
  trip: Trip | null;
  month: number;
}) {
  const closureRoutes = useMemo(() => buildTripClosureRoutes(trip), [trip]);
  const closuresData = useClosures(month, closureRoutes);
  const passesData = usePasses(month, closureRoutes);

  return (
    <TripPlannerMapContent
      trip={trip}
      month={month}
      closuresData={closuresData}
      passesData={passesData}
    />
  );
}

function TripPlannerMapContent({
  trip,
  month,
  closuresData,
  passesData,
}: {
  trip: Trip | null;
  month: number;
  closuresData: ClosuresQueryResult;
  passesData: PassesQueryResult;
}) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  const fittedBoundsKeyRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showQuality, setShowQuality] = useState(true);
  const [showSurface, setShowSurface] = useState(false);
  const [drawMode, setDrawMode] = useState<"idle" | "drawing">("idle");
  const [drawnRegion, setDrawnRegion] = useState<RegionDrawBbox | null>(null);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);

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
  const {
    closures,
    routeClosures,
    routeCounts,
    loading: closuresLoading,
    routeLoading: routeClosuresLoading,
    routeError: closuresRouteError,
  } = closuresData;
  const {
    passes,
    routePasses,
    routeClosedCount,
    routeUnknownCount,
    loading: passesLoading,
    routeLoading: routePassesLoading,
    routeError: passesRouteError,
  } = passesData;
  const closureLineCollection = useMemo(
    () => buildPlannerClosureLineCollection(closures),
    [closures],
  );
  const closureMarkerCollection = useMemo(
    () => buildPlannerClosureMarkerCollection(closures),
    [closures],
  );
  const passMarkerCollection = useMemo(
    () => buildPlannerPassMarkerCollection(passes),
    [passes],
  );
  const highlightedClosures =
    routeClosures.length > 0 ? routeClosures : closures;
  const highlightedPasses =
    routePasses.length > 0
      ? routePasses.filter((pass) => pass.status !== "open")
      : passes;
  const activeMonthLabel = monthLabel(month);
  const conditionsLoading =
    closuresLoading ||
    routeClosuresLoading ||
    passesLoading ||
    routePassesLoading;
  const routeWarningParts: string[] = [];
  const routeErrors = dedupeMessages([closuresRouteError, passesRouteError]);

  if (routeCounts.total > 0) {
    routeWarningParts.push(
      `${routeCounts.total} route ${routeCounts.total === 1 ? "closure" : "closures"}`,
    );
  }
  if (routeClosedCount > 0) {
    routeWarningParts.push(
      `${routeClosedCount} closed ${routeClosedCount === 1 ? "pass" : "passes"}`,
    );
  }
  if (routeUnknownCount > 0) {
    routeWarningParts.push(
      `${routeUnknownCount} unknown ${routeUnknownCount === 1 ? "pass" : "passes"}`,
    );
  }

  useEffect(() => {
    if (!tripBoundsKey) {
      fittedBoundsKeyRef.current = null;
      return;
    }
    if (tripBoundsKey !== fittedBoundsKeyRef.current) {
      fittedBoundsKeyRef.current = null;
    }
  }, [tripBoundsKey]);

  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);

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
    syncGeoJsonSource(map, CLOSURE_LINE_SOURCE, closureLineCollection);
    syncGeoJsonSource(map, CLOSURE_MARKER_SOURCE, closureMarkerCollection);
    syncGeoJsonSource(map, PASS_MARKER_SOURCE, passMarkerCollection);
  }, [
    closureLineCollection,
    closureMarkerCollection,
    passMarkerCollection,
    ready,
    routeCollection,
    waypointCollection,
  ]);

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

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/80 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <AlertTriangle size={14} className="text-amber-300" />
            Conditions for {activeMonthLabel}
          </div>

          {conditionsLoading ? (
            <p className="mt-2 text-xs text-slate-500">
              Loading passes and closures…
            </p>
          ) : (
            <>
              {routeWarningParts.length > 0 ? (
                <p className="mt-2 text-xs text-amber-200">
                  Route warnings: {routeWarningParts.join(" · ")}.
                </p>
              ) : routeErrors.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {routeErrors.map((message) => (
                    <p key={message} className="text-xs text-rose-300">
                      {message}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-emerald-300">
                  No route closures or pass warnings for this month.
                </p>
              )}

              {routeWarningParts.length > 0 && routeErrors.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {routeErrors.map((message) => (
                    <p key={message} className="text-xs text-rose-300">
                      {message}
                    </p>
                  ))}
                </div>
              ) : null}

              {highlightedClosures.length > 0 ? (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <AlertTriangle size={12} />
                    Closures
                  </div>
                  <ul className="mt-2 space-y-2">
                    {highlightedClosures.slice(0, 2).map((closure) => {
                      const detourKm =
                        closure.reason === "roadworks"
                          ? detourLengthKm(closure)
                          : null;

                      return (
                        <li
                          key={closure.id}
                          className="rounded-lg border border-slate-800 bg-slate-950/70 p-2"
                        >
                          <p className="text-xs font-medium text-slate-100">
                            {closure.title}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            {reasonLabel(closure.reason)}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {formatClosureWindow(closure)}
                          </p>
                          {detourKm != null ? (
                            <p className="mt-1 text-[11px] text-cyan-300">
                              Detour approx.{" "}
                              {formatDistance(detourKm, unitSystem)}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {highlightedPasses.length > 0 ? (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <Mountain size={12} />
                    Passes
                  </div>
                  <ul className="mt-2 space-y-2">
                    {highlightedPasses.slice(0, 2).map((pass) => (
                      <li
                        key={pass.id}
                        className="rounded-lg border border-slate-800 bg-slate-950/70 p-2"
                      >
                        <p className="text-xs font-medium text-slate-100">
                          {pass.name}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-400">
                          {statusLabel(pass.status)} ·{" "}
                          {pass.elevation_m.toLocaleString()} m
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
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

function dedupeMessages(messages: Array<string | null>): string[] {
  return [
    ...new Set(
      messages.filter((message): message is string => message !== null),
    ),
  ];
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

  if (!map.getSource(CLOSURE_LINE_SOURCE)) {
    map.addSource(CLOSURE_LINE_SOURCE, {
      type: "geojson",
      data: buildPlannerClosureLineCollection([]),
    });
  }
  if (!map.getLayer(CLOSURE_LINE_LAYER)) {
    map.addLayer({
      id: CLOSURE_LINE_LAYER,
      type: "line",
      source: CLOSURE_LINE_SOURCE,
      paint: {
        "line-color": [
          "match",
          ["get", "severity"],
          "full",
          "#FB7185",
          "partial",
          "#FBBF24",
          "#38BDF8",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 11, 4, 14, 6],
        "line-opacity": 0.85,
      },
    });
  }

  if (!map.getSource(CLOSURE_MARKER_SOURCE)) {
    map.addSource(CLOSURE_MARKER_SOURCE, {
      type: "geojson",
      data: buildPlannerClosureMarkerCollection([]),
    });
  }
  if (!map.getLayer(CLOSURE_MARKER_LAYER)) {
    map.addLayer({
      id: CLOSURE_MARKER_LAYER,
      type: "circle",
      source: CLOSURE_MARKER_SOURCE,
      paint: {
        "circle-color": [
          "match",
          ["get", "severity"],
          "full",
          "#FB7185",
          "partial",
          "#FBBF24",
          "#38BDF8",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          7,
          5,
          12,
          7,
          15,
          9,
        ],
        "circle-stroke-color": "#020617",
        "circle-stroke-width": 2,
      },
    });
  }

  if (!map.getSource(PASS_MARKER_SOURCE)) {
    map.addSource(PASS_MARKER_SOURCE, {
      type: "geojson",
      data: buildPlannerPassMarkerCollection([]),
    });
  }
  if (!map.getLayer(PASS_MARKER_LAYER)) {
    map.addLayer({
      id: PASS_MARKER_LAYER,
      type: "circle",
      source: PASS_MARKER_SOURCE,
      paint: {
        "circle-color": [
          "match",
          ["get", "status"],
          "open",
          "#4ADE80",
          "closed",
          "#FB7185",
          "#94A3B8",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          7,
          4,
          12,
          6,
          15,
          8,
        ],
        "circle-stroke-color": "#020617",
        "circle-stroke-width": 2,
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

function reasonLabel(
  reason: "closure" | "roadworks" | "seasonal" | "weather" | "event" | "other",
): string {
  switch (reason) {
    case "roadworks":
      return "Roadworks";
    case "seasonal":
      return "Seasonal";
    case "weather":
      return "Weather";
    case "event":
      return "Event";
    case "other":
      return "Other";
    case "closure":
    default:
      return "Closure";
  }
}

function statusLabel(status: "open" | "closed" | "unknown"): string {
  switch (status) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "unknown":
    default:
      return "Unknown";
  }
}
