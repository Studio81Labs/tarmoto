"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
} from "maplibre-gl";
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
  type RegionDrawMode,
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
  buildTripPlannerSegmentHighlightCollection,
  buildTripPlannerWaypointCollection,
  getTripPlannerBounds,
} from "@/lib/trip-planner-map";
import { useTripStore } from "@/stores/trip";
import {
  snapWaypointToRoadFeatures,
  type RoadSnapFeature,
} from "@/lib/trip-planner-snap";
import type { Trip } from "@/lib/types";
import type { TripSuggestion } from "@/lib/api";
import type { CollaboratorCursor } from "@/hooks/useTripCollabSession";
import { formatDistance, roundCoordinate } from "@/lib/utils";
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
const CURSOR_SOURCE = "trip-planner-collab-cursors";
const CURSOR_LAYER = "trip-planner-collab-cursors";
const CURSOR_LABEL_LAYER = "trip-planner-collab-cursor-labels";
const SUGGESTION_SOURCE = "trip-planner-suggestions";
const SUGGESTION_LAYER = "trip-planner-suggestion-marker";
const SEGMENT_HIGHLIGHT_SOURCE = "trip-planner-segment-highlight";
const SEGMENT_HIGHLIGHT_GLOW_LAYER = "trip-planner-segment-highlight-glow";
const SEGMENT_HIGHLIGHT_LINE_LAYER = "trip-planner-segment-highlight-line";
interface TripPlannerMapProps {
  trip: Trip | null;
  month: number;
  closuresData?: ClosuresQueryResult;
  passesData?: PassesQueryResult;
  onAddWaypoint?: (location: { lng: number; lat: number }) => void;
  /**
   * Called when a rider finishes dragging an existing waypoint marker.
   * `dayNumber` identifies which trip day owns the waypoint (1-indexed).
   * Pass undefined to keep waypoints non-draggable.
   */
  onMoveWaypoint?: (
    dayNumber: number,
    waypointId: string,
    location: { lng: number; lat: number },
  ) => void;
  selectedDayNumber?: number;
  /** Live cursors from other collaborators keyed by user id. */
  collaboratorCursors?: Map<string, CollaboratorCursor>;
  /**
   * Suggestions to render as markers on the map. Accepted + rejected
   * are filtered out at build time so only `status === 'open'` markers
   * show — resolved proposals no longer need a map affordance.
   */
  suggestions?: TripSuggestion[];
  /**
   * Called on DOM-throttled map mousemove with the pointer's geographic
   * position so the planner page can broadcast a `trip:cursor` event.
   * Pass undefined to disable cursor sharing.
   */
  onCursorMove?: (lat: number, lng: number) => void;
}
export function TripPlannerMap({
  trip,
  month,
  closuresData,
  passesData,
  onAddWaypoint,
  onMoveWaypoint,
  selectedDayNumber,
  collaboratorCursors,
  suggestions,
  onCursorMove,
}: TripPlannerMapProps) {
  if (closuresData && passesData) {
    return (
      <TripPlannerMapContent
        trip={trip}
        month={month}
        closuresData={closuresData}
        passesData={passesData}
        onAddWaypoint={onAddWaypoint}
        onMoveWaypoint={onMoveWaypoint}
        selectedDayNumber={selectedDayNumber}
        collaboratorCursors={collaboratorCursors}
        suggestions={suggestions}
        onCursorMove={onCursorMove}
      />
    );
  }
  return (
    <FetchedTripPlannerMap
      trip={trip}
      month={month}
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      onCursorMove={onCursorMove}
    />
  );
}
function FetchedTripPlannerMap({
  trip,
  month,
  onAddWaypoint,
  onMoveWaypoint,
  selectedDayNumber,
  collaboratorCursors,
  suggestions,
  onCursorMove,
}: {
  trip: Trip | null;
  month: number;
  onAddWaypoint?: (location: { lng: number; lat: number }) => void;
  onMoveWaypoint?: (
    dayNumber: number,
    waypointId: string,
    location: { lng: number; lat: number },
  ) => void;
  selectedDayNumber?: number;
  collaboratorCursors?: Map<string, CollaboratorCursor>;
  suggestions?: TripSuggestion[];
  onCursorMove?: (lat: number, lng: number) => void;
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
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      onCursorMove={onCursorMove}
    />
  );
}
function TripPlannerMapContent({
  trip,
  month,
  closuresData,
  passesData,
  onAddWaypoint,
  onMoveWaypoint,
  selectedDayNumber,
  collaboratorCursors,
  suggestions,
  onCursorMove,
}: {
  trip: Trip | null;
  month: number;
  closuresData: ClosuresQueryResult;
  passesData: PassesQueryResult;
  onAddWaypoint?: (location: { lng: number; lat: number }) => void;
  onMoveWaypoint?: (
    dayNumber: number,
    waypointId: string,
    location: { lng: number; lat: number },
  ) => void;
  selectedDayNumber?: number;
  collaboratorCursors?: Map<string, CollaboratorCursor>;
  suggestions?: TripSuggestion[];
  onCursorMove?: (lat: number, lng: number) => void;
}) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  const fittedBoundsKeyRef = useRef<string | null>(null);
  // Set true on `mousedown`/`touchstart` over a waypoint so the synthetic
  // `click` MapLibre fires for tap-without-drag (the pointer never moved
  // beyond `clickTolerance`) is swallowed by `handleMapClick` instead of
  // appending a duplicate waypoint at the same spot.
  const swallowNextClickRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [showQuality, setShowQuality] = useState(true);
  const [showSurface, setShowSurface] = useState(false);
  const [drawMode, setDrawMode] = useState<RegionDrawMode>("idle");
  const [drawnRegion, setDrawnRegion] = useState<RegionDrawBbox | null>(null);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  // Sidebar publishes the focused segment id so the map can paint the
  // matching slice of the route in a contrasting color (issue #473).
  const focusedSegmentId = useTripStore((s) => s.focusedSegmentId);
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
  const cursorCollection = useMemo(
    () => buildCursorCollection(collaboratorCursors),
    [collaboratorCursors],
  );
  const suggestionCollection = useMemo(
    () => buildSuggestionCollection(suggestions),
    [suggestions],
  );
  const segmentHighlightCollection = useMemo(
    () => buildTripPlannerSegmentHighlightCollection(trip, focusedSegmentId),
    [trip, focusedSegmentId],
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
  const routeErrorsBlock =
    routeErrors.length > 0 ? (
      <div className="mt-2 space-y-1">
        {routeErrors.map((message) => (
          <p key={message} className="text-xs text-rose-300">
            {message}
          </p>
        ))}
      </div>
    ) : null;
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
  const handleMapClick = useCallback(
    (event: {
      point: {
        x: number;
        y: number;
      };
      lngLat: {
        lng: number;
        lat: number;
      };
    }) => {
      if (!onAddWaypoint || drawMode !== "idle") return;
      // A tap-without-drag on a waypoint still fires a synthetic `click`
      // even after we `preventDefault()` on `mousedown`; without this
      // gate the planner would append a brand-new waypoint at the
      // existing one's position on every short tap.
      if (swallowNextClickRef.current) {
        swallowNextClickRef.current = false;
        return;
      }
      const map = handleRef.current?.map;
      if (!map) return;
      // Skip waypoint adds when the click landed on the drawn region or
      // its edit handles — those clicks belong to the region tool.
      if (drawRef.current?.hitTest(event.point)) return;
      onAddWaypoint(
        snapPointerToRoad(map, event.point, event.lngLat) ?? {
          lng: roundCoordinate(event.lngLat.lng),
          lat: roundCoordinate(event.lngLat.lat),
        },
      );
    },
    [drawMode, onAddWaypoint],
  );
  const handleReady = (map: MapLibreMap) => {
    ensurePlannerLayers(map);
    drawRef.current?.destroy();
    drawRef.current = createRegionDrawControl(map, {
      onRegionDrawn: (bbox) => setDrawnRegion(bbox),
      onRegionCleared: () => setDrawnRegion(null),
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
    syncGeoJsonSource(map, CURSOR_SOURCE, cursorCollection);
    syncGeoJsonSource(map, SUGGESTION_SOURCE, suggestionCollection);
    syncGeoJsonSource(
      map,
      SEGMENT_HIGHLIGHT_SOURCE,
      segmentHighlightCollection,
    );
  }, [
    closureLineCollection,
    closureMarkerCollection,
    cursorCollection,
    passMarkerCollection,
    ready,
    routeCollection,
    segmentHighlightCollection,
    suggestionCollection,
    waypointCollection,
  ]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !onCursorMove) return;
    // Coalesce fast-fire mousemoves into at most one callback per paint
    // via requestAnimationFrame. The hook-side throttle (150 ms) is a
    // second gate for the socket emit itself, but without this
    // DOM-layer throttle a 120 Hz mouse would trigger React callbacks
    // at the same rate, defeating the point.
    let rafId: number | null = null;
    let pending: {
      lat: number;
      lng: number;
    } | null = null;
    const flush = () => {
      rafId = null;
      if (!pending) return;
      const { lat, lng } = pending;
      pending = null;
      onCursorMove(lat, lng);
    };
    const handler = (event: {
      lngLat: {
        lng: number;
        lat: number;
      };
    }) => {
      pending = { lat: event.lngLat.lat, lng: event.lngLat.lng };
      if (rafId === null) rafId = window.requestAnimationFrame(flush);
    };
    map.on("mousemove", handler);
    return () => {
      map.off("mousemove", handler);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [onCursorMove, ready]);
  useEffect(() => {
    if (!ready) return;
    drawRef.current?.setDrawn(drawnRegion);
  }, [drawnRegion, ready]);
  useEffect(() => {
    if (!drawnRegion || drawMode === "drawing") return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      // Don't steal Delete from text inputs or contenteditable surfaces
      // — riders may be editing trip names while a region is drawn.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      drawRef.current?.clearDrawn();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [drawMode, drawnRegion]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !onAddWaypoint) return;
    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
  }, [handleMapClick, onAddWaypoint, ready]);
  // ── Waypoint dragging (#471) ──
  // MapLibre treats every gesture on the canvas as a pan unless we
  // intercept the pointer-down on the waypoint layer with
  // `e.preventDefault()`. Without that intercept, "drag a waypoint"
  // landed as a map pan and the marker stayed put.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !onMoveWaypoint || drawMode !== "idle") return;

    const canvas = map.getCanvas();
    let active: { dayNumber: number; waypointId: string } | null = null;

    const setCursor = (cursor: string) => {
      canvas.style.cursor = cursor;
    };

    const handleEnter = () => {
      if (!active) setCursor("move");
    };
    const handleLeave = () => {
      if (!active) setCursor("");
    };
    const handleMouseMove = (event: MapMouseEvent) => {
      if (!active) return;
      event.preventDefault();
      setCursor("grabbing");
    };
    const handleTouchMove = (event: MapTouchEvent) => {
      if (!active) return;
      event.preventDefault();
    };
    const finishDrag = (
      lngLat: { lng: number; lat: number },
      point?: {
        x: number;
        y: number;
      },
    ) => {
      if (!active) return;
      const snapped = point ? snapPointerToRoad(map, point, lngLat) : null;
      const target = snapped ?? {
        lng: roundCoordinate(lngLat.lng),
        lat: roundCoordinate(lngLat.lat),
      };
      onMoveWaypoint(active.dayNumber, active.waypointId, target);
      active = null;
      setCursor("");
      // The `move`/`touchmove` listeners are kept registered: their
      // `if (!active) return` guard makes them no-ops between drags,
      // and a no-op drop (same coords) does not re-render so this
      // effect does not re-run — detaching them here would silently
      // strip preventDefault from every subsequent drag.
    };
    const handleMouseUp = (event: MapMouseEvent) => {
      finishDrag(event.lngLat, event.point);
    };
    const handleTouchEnd = (event: MapTouchEvent) => {
      finishDrag(event.lngLat, event.point);
    };
    const beginDrag = (event: MapMouseEvent | MapTouchEvent) => {
      const features = (event as MapMouseEvent & { features?: unknown[] })
        .features as
        | Array<{
            properties?: { dayNumber?: number; waypointId?: string };
          }>
        | undefined;
      const feature = features?.[0];
      const props = feature?.properties;
      if (
        !props ||
        typeof props.waypointId !== "string" ||
        typeof props.dayNumber !== "number"
      ) {
        return;
      }
      event.preventDefault();
      active = { dayNumber: props.dayNumber, waypointId: props.waypointId };
      // Even with `preventDefault()` here, MapLibre still fires a `click`
      // when the pointer never moves beyond `clickTolerance` (see its
      // `map_events.test`). Flag the upcoming click so `handleMapClick`
      // ignores it instead of treating the drop as a fresh map click.
      swallowNextClickRef.current = true;
      setCursor("grabbing");
    };

    map.on("mouseenter", WAYPOINT_CIRCLE, handleEnter);
    map.on("mouseleave", WAYPOINT_CIRCLE, handleLeave);
    map.on("mousedown", WAYPOINT_CIRCLE, beginDrag);
    map.on("touchstart", WAYPOINT_CIRCLE, beginDrag);
    map.on("mousemove", handleMouseMove);
    map.on("touchmove", handleTouchMove);
    map.on("mouseup", handleMouseUp);
    map.on("touchend", handleTouchEnd);

    return () => {
      map.off("mouseenter", WAYPOINT_CIRCLE, handleEnter);
      map.off("mouseleave", WAYPOINT_CIRCLE, handleLeave);
      map.off("mousedown", WAYPOINT_CIRCLE, beginDrag);
      map.off("touchstart", WAYPOINT_CIRCLE, beginDrag);
      map.off("mousemove", handleMouseMove);
      map.off("touchmove", handleTouchMove);
      map.off("mouseup", handleMouseUp);
      map.off("touchend", handleTouchEnd);
      setCursor("");
    };
  }, [drawMode, onMoveWaypoint, ready]);
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
            {t("Road quality ")}
          </button>
          <button
            type="button"
            aria-pressed={showSurface}
            aria-label={`Surface overlay ${showSurface ? "on" : "off"}`}
            onClick={() => setShowSurface((value) => !value)}
            className={toggleClassName(showSurface)}
          >
            <Layers3 size={14} />
            {t("Surface ")}
          </button>
        </div>

        {drawMode === "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.cancel()}
            className="flex items-center gap-1.5 rounded-lg border border-tarmoto-cyan bg-tarmoto-cyan/20 px-3 py-2 text-sm text-tarmoto-cyan transition hover:bg-tarmoto-cyan/30"
          >
            <X size={14} />
            {t("Cancel drawing ")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => drawRef.current?.start()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 transition hover:bg-slate-800"
          >
            <Square size={14} />
            {drawnRegion ? t("Redraw region ") : t("Draw region ")}
          </button>
        )}

        {drawnRegion && drawMode !== "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.clearDrawn()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            <X size={12} />
            {t("Clear region ")}
          </button>
        ) : null}

        <div className="rounded-lg border border-slate-700 bg-slate-950/85 px-3 py-2 text-xs text-slate-300 shadow-sm">
          {drawMode === "drawing" ? (
            <>
              {t(
                "Click and drag on the map to outline a region. Release to finish. ",
              )}
            </>
          ) : drawnRegion ? (
            <>
              {t(
                "Drag the region to move it, drag a handle to resize, or press Delete to remove. ",
              )}
            </>
          ) : (
            <>
              {t("Click the map to add waypoints ")}
              {selectedDayNumber ? ` for Day ${selectedDayNumber}` : ""}
              {t(". We snap to nearby roads when visible. ")}
            </>
          )}
        </div>
      </div>

      <div className="absolute right-3 top-3 z-10 w-72 rounded-2xl border border-slate-800 bg-slate-950/90 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Route size={16} className="text-tarmoto-cyan" />
          {t("Planner map ")}
        </div>
        <p className="mt-2 text-sm text-slate-300">
          {trip
            ? `${trip.days.length} day${trip.days.length === 1 ? "" : "s"} · ${waypointCount} waypoint${waypointCount === 1 ? "" : "s"}`
            : "Load the demo trip or import GPX/KML to see your route on the map."}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          {t(
            "Until route generation lands, the planner previews each day as a direct line between its ordered waypoints. ",
          )}
        </p>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/80 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <AlertTriangle size={14} className="text-amber-300" />
            {t("Conditions for ")}
            {activeMonthLabel}
          </div>

          {conditionsLoading ? (
            <p className="mt-2 text-xs text-slate-500">
              {t("Loading passes and closures\u2026 ")}
            </p>
          ) : (
            <>
              {routeWarningParts.length > 0 ? (
                <p className="mt-2 text-xs text-amber-200">
                  {t("Route warnings: ")}
                  {routeWarningParts.join(" · ")}.
                </p>
              ) : routeErrors.length > 0 ? (
                routeErrorsBlock
              ) : (
                <p className="mt-2 text-xs text-emerald-300">
                  {t("No route closures or pass warnings for this month. ")}
                </p>
              )}

              {routeWarningParts.length > 0 ? routeErrorsBlock : null}

              {highlightedClosures.length > 0 ? (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <AlertTriangle size={12} />
                    {t("Closures ")}
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
                              {t("Detour approx. {distance}", {
                                distance: formatDistance(detourKm, unitSystem),
                              })}
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
                    {t("Passes ")}
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
                          {t("{status} · {elevation} m", {
                            status: statusLabel(pass.status),
                            elevation: pass.elevation_m.toLocaleString(),
                          })}
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

function snapPointerToRoad(
  map: MapLibreMap,
  point: { x: number; y: number },
  lngLat: { lng: number; lat: number },
): { lng: number; lat: number } | null {
  const features: RoadSnapFeature[] = map
    .queryRenderedFeatures(
      [
        [point.x - 12, point.y - 12],
        [point.x + 12, point.y + 12],
      ],
      {
        layers: ["tarmoto-quality", "tarmoto-surface"],
      },
    )
    .map((feature) => ({
      geometry:
        feature.geometry.type === "LineString" ||
        feature.geometry.type === "MultiLineString"
          ? feature.geometry
          : null,
      properties: {
        quality_score: feature.properties?.quality_score,
      },
    }));
  return snapWaypointToRoadFeatures(
    { lng: lngLat.lng, lat: lngLat.lat },
    features,
  );
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
  // Highlight for the segment the rider clicked in the sidebar (issue #473).
  // Sources/layers are added before the waypoint markers so the markers stay
  // visible and tappable on top of the highlighted line.
  if (!map.getSource(SEGMENT_HIGHLIGHT_SOURCE)) {
    map.addSource(SEGMENT_HIGHLIGHT_SOURCE, {
      type: "geojson",
      data: buildTripPlannerSegmentHighlightCollection(null, null),
    });
  }
  if (!map.getLayer(SEGMENT_HIGHLIGHT_GLOW_LAYER)) {
    map.addLayer({
      id: SEGMENT_HIGHLIGHT_GLOW_LAYER,
      type: "line",
      source: SEGMENT_HIGHLIGHT_SOURCE,
      paint: {
        "line-color": "#0ED3CF",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          8,
          10,
          14,
          14,
          22,
        ],
        "line-opacity": 0.35,
        "line-blur": 3,
      },
    });
  }
  if (!map.getLayer(SEGMENT_HIGHLIGHT_LINE_LAYER)) {
    map.addLayer({
      id: SEGMENT_HIGHLIGHT_LINE_LAYER,
      type: "line",
      source: SEGMENT_HIGHLIGHT_SOURCE,
      paint: {
        "line-color": "#0ED3CF",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 10, 5, 14, 7],
        "line-opacity": 1,
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
  // ── Collaboration overlays (US-35) ──
  if (!map.getSource(SUGGESTION_SOURCE)) {
    map.addSource(SUGGESTION_SOURCE, {
      type: "geojson",
      data: buildSuggestionCollection(undefined),
    });
  }
  if (!map.getLayer(SUGGESTION_LAYER)) {
    map.addLayer({
      id: SUGGESTION_LAYER,
      type: "circle",
      source: SUGGESTION_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#C084FC",
        "circle-stroke-color": "#1E1B4B",
        "circle-stroke-width": 2,
      },
    });
  }
  if (!map.getSource(CURSOR_SOURCE)) {
    map.addSource(CURSOR_SOURCE, {
      type: "geojson",
      data: buildCursorCollection(undefined),
    });
  }
  if (!map.getLayer(CURSOR_LAYER)) {
    map.addLayer({
      id: CURSOR_LAYER,
      type: "circle",
      source: CURSOR_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#F472B6",
        "circle-stroke-color": "#1E1B4B",
        "circle-stroke-width": 2,
      },
    });
  }
  if (!map.getLayer(CURSOR_LABEL_LAYER)) {
    map.addLayer({
      id: CURSOR_LABEL_LAYER,
      type: "symbol",
      source: CURSOR_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-offset": [0, 1.1],
        "text-size": 10,
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#F9A8D4",
        "text-halo-color": "#020617",
        "text-halo-width": 1,
      },
    });
  }
}
function buildCursorCollection(
  cursors: Map<string, CollaboratorCursor> | undefined,
): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  {
    userId: string;
    label: string;
  }
> {
  const features: Array<
    GeoJSON.Feature<
      GeoJSON.Point,
      {
        userId: string;
        label: string;
      }
    >
  > = [];
  if (cursors) {
    for (const cursor of cursors.values()) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [cursor.lng, cursor.lat] },
        properties: {
          userId: cursor.userId,
          // Abbreviate so the label is readable but unique enough to
          // tell collaborators apart at a glance.
          label: cursor.userId.slice(0, 6),
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
function buildSuggestionCollection(
  suggestions: TripSuggestion[] | undefined,
): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  {
    suggestionId: string;
    title: string;
  }
> {
  const features: Array<
    GeoJSON.Feature<
      GeoJSON.Point,
      {
        suggestionId: string;
        title: string;
      }
    >
  > = [];
  if (suggestions) {
    for (const s of suggestions) {
      if (s.status !== "open") continue;
      if (s.lat == null || s.lng == null) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { suggestionId: s.id, title: s.title },
      });
    }
  }
  return { type: "FeatureCollection", features };
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
