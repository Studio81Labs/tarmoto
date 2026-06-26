"use client";
import { t } from "@/i18n";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
  MapTouchEvent,
} from "maplibre-gl";
import {
  AlertTriangle,
  Layers3,
  Maximize2,
  Mountain,
  Route,
  Sparkles,
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
  buildPlacementMenu,
  type PlacementActionId,
} from "@/lib/planner-context-menu";
import {
  snapWaypointToRoadFeatures,
  type RoadSnapFeature,
} from "@/lib/trip-planner-snap";
import {
  fetchFunZoneDetail,
  fetchFunZonesInBbox,
  type FunZoneDetail,
  type FunZoneListItem,
} from "@/lib/discover";
import {
  FUN_ZONES_FILL,
  installFunZoneLayer,
  setFunZoneSelection,
  updateFunZoneLayerData,
} from "@/components/map/FunZoneLayer";
import type { Trip } from "@/lib/types";
import type { TripSuggestion } from "@/lib/api";
import type { CollaboratorCursor } from "@/hooks/useTripCollabSession";
import { formatDistance, roundCoordinate } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";
/** Imperative handle exposed on the TripPlannerMap ref (Task 11). */
export interface TripPlannerMapHandle {
  /** Fit the viewport to the current route bounds. No-op when no bounds. */
  fitRoute: () => void;
}

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
const FUN_ZONE_FETCH_DEBOUNCE_MS = 300;
interface TripPlannerMapProps {
  trip: Trip | null;
  month: number;
  drawnRegion?: RegionDrawBbox | null;
  onDrawnRegionChange?: (bbox: RegionDrawBbox | null) => void;
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
  /**
   * When true, only the selected day's route is rendered on the map.
   * When false (default), all days are shown color-coded.
   */
  focusSelectedDay?: boolean;
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
  /**
   * Bump to trigger a one-shot refit to the current route bounds,
   * independent of the per-`trip.id` auto-fit. The auto-fit fires
   * once per trip so waypoint edits don't rip the viewport
   * (#559) — but page-level flows that change route geometry while
   * the trip id stays the same (selecting a different generated
   * option, replacing an imported route, etc.) need to re-frame
   * the new geometry. Increment this token after each such action.
   */
  fitRouteToken?: number;
}
export const TripPlannerMap = forwardRef<
  TripPlannerMapHandle,
  TripPlannerMapProps
>(function TripPlannerMap(
  {
    trip,
    month,
    drawnRegion,
    onDrawnRegionChange,
    closuresData,
    passesData,
    onAddWaypoint,
    onMoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    onCursorMove,
    fitRouteToken,
  },
  ref,
) {
  if (closuresData && passesData) {
    return (
      <TripPlannerMapContent
        ref={ref}
        trip={trip}
        month={month}
        drawnRegion={drawnRegion}
        onDrawnRegionChange={onDrawnRegionChange}
        closuresData={closuresData}
        passesData={passesData}
        onAddWaypoint={onAddWaypoint}
        onMoveWaypoint={onMoveWaypoint}
        selectedDayNumber={selectedDayNumber}
        focusSelectedDay={focusSelectedDay}
        collaboratorCursors={collaboratorCursors}
        suggestions={suggestions}
        onCursorMove={onCursorMove}
        fitRouteToken={fitRouteToken}
      />
    );
  }
  return (
    <FetchedTripPlannerMap
      ref={ref}
      trip={trip}
      month={month}
      drawnRegion={drawnRegion}
      onDrawnRegionChange={onDrawnRegionChange}
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      onCursorMove={onCursorMove}
      fitRouteToken={fitRouteToken}
    />
  );
});
const FetchedTripPlannerMap = forwardRef<
  TripPlannerMapHandle,
  {
    trip: Trip | null;
    month: number;
    drawnRegion?: RegionDrawBbox | null;
    onDrawnRegionChange?: (bbox: RegionDrawBbox | null) => void;
    onAddWaypoint?: (location: { lng: number; lat: number }) => void;
    onMoveWaypoint?: (
      dayNumber: number,
      waypointId: string,
      location: { lng: number; lat: number },
    ) => void;
    selectedDayNumber?: number;
    focusSelectedDay?: boolean;
    collaboratorCursors?: Map<string, CollaboratorCursor>;
    suggestions?: TripSuggestion[];
    onCursorMove?: (lat: number, lng: number) => void;
    fitRouteToken?: number;
  }
>(function FetchedTripPlannerMap(
  {
    trip,
    month,
    drawnRegion,
    onDrawnRegionChange,
    onAddWaypoint,
    onMoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    onCursorMove,
    fitRouteToken,
  },
  ref,
) {
  const closureRoutes = useMemo(() => buildTripClosureRoutes(trip), [trip]);
  const closuresData = useClosures(month, closureRoutes);
  const passesData = usePasses(month, closureRoutes);
  return (
    <TripPlannerMapContent
      ref={ref}
      trip={trip}
      month={month}
      drawnRegion={drawnRegion}
      onDrawnRegionChange={onDrawnRegionChange}
      closuresData={closuresData}
      passesData={passesData}
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      onCursorMove={onCursorMove}
      fitRouteToken={fitRouteToken}
    />
  );
});
const TripPlannerMapContent = forwardRef<
  TripPlannerMapHandle,
  {
    trip: Trip | null;
    month: number;
    drawnRegion?: RegionDrawBbox | null;
    onDrawnRegionChange?: (bbox: RegionDrawBbox | null) => void;
    closuresData: ClosuresQueryResult;
    passesData: PassesQueryResult;
    onAddWaypoint?: (location: { lng: number; lat: number }) => void;
    onMoveWaypoint?: (
      dayNumber: number,
      waypointId: string,
      location: { lng: number; lat: number },
    ) => void;
    selectedDayNumber?: number;
    focusSelectedDay?: boolean;
    collaboratorCursors?: Map<string, CollaboratorCursor>;
    suggestions?: TripSuggestion[];
    onCursorMove?: (lat: number, lng: number) => void;
    fitRouteToken?: number;
  }
>(function TripPlannerMapContent(
  {
    trip,
    month,
    drawnRegion: controlledDrawnRegion,
    onDrawnRegionChange,
    closuresData,
    passesData,
    onAddWaypoint,
    onMoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    onCursorMove,
    fitRouteToken,
  },
  ref,
) {
  // The map is "editable" only when the parent wires up waypoint editing (the
  // planner passes onMoveWaypoint; the read-only trip-detail page does not).
  // Gate the placement context menu on this so a right-click/long-press on the
  // detail map can't open the menu and mutate the global trip store. A boolean
  // keeps the placement effect's deps stable despite inline-callback identity.
  const editable = onMoveWaypoint != null;
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  // Tracks the trip whose bounds we've already auto-fit. Keyed on
  // `trip.id` (not `tripBoundsKey`) so adding/moving/removing
  // waypoints — which all change the geometry but keep the trip id
  // stable — doesn't re-rip the viewport. The auto-fit fires once
  // when the user opens a trip; further "show me the whole route"
  // intent is served by the explicit Fit-to-route button below.
  const fittedTripIdRef = useRef<string | null>(null);
  // Tracks trips we first saw WITHOUT a framable route — i.e. drafts the
  // user is building from scratch (placing the first point creates a brand
  // new `trip.id`). We must never auto-fit these, or the initial point would
  // rip the rider's zoom back out. Only a trip first seen WITH a real route
  // (an existing trip loaded via `?tripId=`) gets the one-shot frame.
  const builtTripIdRef = useRef<string | null>(null);
  // Set true on `mousedown`/`touchstart` over a waypoint so the synthetic
  // `click` MapLibre fires for tap-without-drag (the pointer never moved
  // beyond `clickTolerance`) is swallowed by `handleMapClick` instead of
  // appending a duplicate waypoint at the same spot.
  const swallowNextClickRef = useRef(false);
  // Bounce `onMoveWaypoint` through a ref so a fresh callback identity
  // on every parent render (the planner page passes an inline arrow,
  // and live collab cursor/suggestion updates re-render mid-drag) does
  // not retrigger the drag effect and discard the in-flight `active`
  // state — that bug would silently drop the rider's drop.
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  useEffect(() => {
    onMoveWaypointRef.current = onMoveWaypoint;
  }, [onMoveWaypoint]);
  const dragEnabled = onMoveWaypoint != null;
  const [ready, setReady] = useState(false);
  const [showQuality, setShowQuality] = useState(true);
  const [showSurface, setShowSurface] = useState(false);
  const [drawMode, setDrawMode] = useState<RegionDrawMode>("idle");
  const [drawnRegion, setDrawnRegion] = useState<RegionDrawBbox | null>(
    controlledDrawnRegion ?? null,
  );
  const [funZones, setFunZones] = useState<FunZoneListItem[]>([]);
  const [funZonesLoading, setFunZonesLoading] = useState(false);
  const [funZonesError, setFunZonesError] = useState<string | null>(null);
  const [funZonesRetryNonce, setFunZonesRetryNonce] = useState(0);
  const [selectedFunZoneId, setSelectedFunZoneId] = useState<string | null>(
    null,
  );
  const [selectedFunZoneDetail, setSelectedFunZoneDetail] =
    useState<FunZoneDetail | null>(null);
  const [selectedFunZoneLoading, setSelectedFunZoneLoading] = useState(false);
  const [selectedFunZoneError, setSelectedFunZoneError] = useState<
    string | null
  >(null);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  // Sidebar publishes the focused segment id so the map can paint the
  // matching slice of the route in a contrasting color (issue #473).
  const focusedSegmentId = useTripStore((s) => s.focusedSegmentId);

  // ── Context-menu waypoint placement (Task 10) ────────────────────────────
  // Task 9 store actions for context-menu placement.
  const placeWaypoint = useTripStore((s) => s.placeWaypoint);
  // Derive hasStart / hasEnd from the active planner day (day 0).
  const activeTrip = useTripStore((s) => s.activeTrip);
  const activeDayWaypoints = activeTrip?.days[0]?.waypoints ?? [];
  const hasStart = activeDayWaypoints.some((w) => w.type === "start");
  const hasEnd = activeDayWaypoints.some((w) => w.type === "end");

  // Context menu state: screen position + the snapped geo coord the menu acts on.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    coords: { lng: number; lat: number };
  } | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenuAction = useCallback(
    (actionId: PlacementActionId) => {
      if (!contextMenu) return;
      // Seed a brand-new draft with the planner controls the rider configured
      // (mirrored into the store by the planner page) instead of store defaults.
      placeWaypoint(
        contextMenu.coords,
        actionId,
        useTripStore.getState().draftPlannerParameters ?? undefined,
      );
      closeContextMenu();
    },
    [contextMenu, placeWaypoint, closeContextMenu],
  );
  // ─────────────────────────────────────────────────────────────────────────
  const routeCollection = useMemo(
    () =>
      buildTripPlannerRouteCollection(
        trip,
        selectedDayNumber,
        focusSelectedDay,
      ),
    [trip, selectedDayNumber, focusSelectedDay],
  );
  const waypointCollection = useMemo(
    () => buildTripPlannerWaypointCollection(trip),
    [trip],
  );
  const tripBounds = useMemo(() => getTripPlannerBounds(trip), [trip]);
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
  const selectedFunZone =
    funZones.find((zone) => zone.id === selectedFunZoneId) ?? null;
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
    // Drop the "already fitted" marker when the trip is closed so
    // the next opened trip gets its initial fit. We intentionally
    // do NOT clear it on `tripBoundsKey` change — that's the bug
    // #559 reported: clicking the map to add a waypoint advances
    // the bounds key, which used to reset this ref and trigger an
    // immediate refit, ripping the user's zoom/pan away.
    if (!trip) {
      fittedTripIdRef.current = null;
      builtTripIdRef.current = null;
    }
  }, [trip]);
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  // Left-click no longer drops a waypoint — it only closes the context
  // menu (if open) and clears the waypoint-tap swallow flag.
  const handleMapClick = useCallback(() => {
    if (swallowNextClickRef.current) {
      swallowNextClickRef.current = false;
      return;
    }
    closeContextMenu();
  }, [closeContextMenu]);
  const updateDrawnRegion = useCallback(
    (bbox: RegionDrawBbox | null) => {
      setDrawnRegion(bbox);
      onDrawnRegionChange?.(bbox);
    },
    [onDrawnRegionChange],
  );
  const handleReady = (map: MapLibreMap) => {
    ensurePlannerLayers(map);
    installFunZoneLayer(map);
    drawRef.current?.destroy();
    drawRef.current = createRegionDrawControl(map, {
      onRegionDrawn: (bbox) => updateDrawnRegion(bbox),
      onRegionCleared: () => updateDrawnRegion(null),
      onModeChange: setDrawMode,
    });
    const pointerOn = () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "pointer";
    };
    const pointerOff = () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "";
    };
    map.on("mouseenter", FUN_ZONES_FILL, pointerOn);
    map.on("mouseleave", FUN_ZONES_FILL, pointerOff);
    map.on("click", FUN_ZONES_FILL, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const id = event.features?.[0]?.properties?.id as string | undefined;
      if (!id) return;
      // Layer clicks also reach the map-level click listener, which adds
      // waypoints. Mark this click as consumed so selecting a Fun Zone never
      // mutates the trip route.
      swallowNextClickRef.current = true;
      setSelectedFunZoneId(id);
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
    if (controlledDrawnRegion === undefined) return;
    setDrawnRegion(controlledDrawnRegion);
  }, [controlledDrawnRegion]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    if (!drawnRegion) {
      setFunZones([]);
      setFunZonesLoading(false);
      setFunZonesError(null);
      setSelectedFunZoneId(null);
      setSelectedFunZoneDetail(null);
      updateFunZoneLayerData(map, []);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setFunZonesLoading(true);
    setFunZonesError(null);
    const timer = window.setTimeout(async () => {
      try {
        const zones = await fetchFunZonesInBbox(drawnRegion, {
          signal: controller.signal,
        });
        if (cancelled) return;
        const rankedZones = [...zones].sort(
          (a, b) => b.composite_score - a.composite_score,
        );
        setFunZones(rankedZones);
        updateFunZoneLayerData(map, rankedZones);
        setSelectedFunZoneId((current) =>
          current && rankedZones.some((zone) => zone.id === current)
            ? current
            : null,
        );
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        console.warn("[planner] fun zones fetch failed", err);
        setFunZones([]);
        updateFunZoneLayerData(map, []);
        setFunZonesError("Couldn't load Fun Zones.");
      } finally {
        if (!cancelled) setFunZonesLoading(false);
      }
    }, FUN_ZONE_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [drawnRegion, funZonesRetryNonce, ready]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setFunZoneSelection(map, selectedFunZoneId);
  }, [ready, selectedFunZoneId]);
  useEffect(() => {
    if (!selectedFunZoneId) {
      setSelectedFunZoneDetail(null);
      setSelectedFunZoneError(null);
      setSelectedFunZoneLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setSelectedFunZoneLoading(true);
    setSelectedFunZoneError(null);
    fetchFunZoneDetail(selectedFunZoneId, { signal: controller.signal })
      .then((detail) => {
        if (cancelled) return;
        setSelectedFunZoneDetail(detail);
        if (!detail) setSelectedFunZoneError("Fun Zone details unavailable.");
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        console.warn("[planner] fun zone detail fetch failed", err);
        if (!cancelled) setSelectedFunZoneError("Couldn't load top roads.");
      })
      .finally(() => {
        if (!cancelled) setSelectedFunZoneLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedFunZoneId]);
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
  // Click closes the context menu and clears the swallow flag (no longer adds waypoints).
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
  }, [handleMapClick, ready]);
  // ── Context-menu placement: right-click (desktop) + long-press (touch) ──
  useEffect(() => {
    const map = handleRef.current?.map;
    // Only install placement listeners on an editable (planner) map — never on
    // the read-only trip-detail map, which shares the same store.
    if (!map || !ready || drawMode !== "idle" || !editable) return;

    // Desktop: contextmenu event (right-click).
    const onContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      // Don't open over the region-draw tool.
      if (drawRef.current?.hitTest(event.point)) return;
      const snapped = snapPointerToRoad(map, event.point, event.lngLat) ?? {
        lng: roundCoordinate(event.lngLat.lng),
        lat: roundCoordinate(event.lngLat.lat),
      };
      // Position the menu with viewport coordinates (the DOM event's
      // clientX/Y) and `position: fixed` so it lands under the cursor
      // regardless of where the map container sits on the page. `event.point`
      // is canvas-relative, which only matches when the overlay's positioned
      // ancestor is the canvas origin — it isn't here, so it drifted.
      setContextMenu({
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
        coords: snapped,
      });
    };

    // Touch: long-press (~500 ms) cancelled by move.
    const LONG_PRESS_MS = 500;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let touchMoved = false;

    const onTouchStart = (event: MapTouchEvent) => {
      touchMoved = false;
      const touch = event.originalEvent.touches[0];
      if (!touch) return;
      const savedPoint = { x: event.point.x, y: event.point.y };
      const savedLngLat = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      // Viewport coords for the menu position (see onContextMenu); savedPoint
      // (canvas-relative) is still used for hit-testing and road snapping.
      const savedClient = { x: touch.clientX, y: touch.clientY };
      longPressTimer = setTimeout(() => {
        if (touchMoved) return;
        if (drawRef.current?.hitTest(savedPoint)) return;
        const snapped = snapPointerToRoad(map, savedPoint, savedLngLat) ?? {
          lng: roundCoordinate(savedLngLat.lng),
          lat: roundCoordinate(savedLngLat.lat),
        };
        setContextMenu({
          x: savedClient.x,
          y: savedClient.y,
          coords: snapped,
        });
      }, LONG_PRESS_MS);
    };

    const cancelLongPress = () => {
      touchMoved = true;
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    map.on("contextmenu", onContextMenu);
    map.on("touchstart", onTouchStart);
    map.on("touchmove", cancelLongPress);
    map.on("touchend", cancelLongPress);

    return () => {
      map.off("contextmenu", onContextMenu);
      map.off("touchstart", onTouchStart);
      map.off("touchmove", cancelLongPress);
      map.off("touchend", cancelLongPress);
      if (longPressTimer !== null) clearTimeout(longPressTimer);
    };
  }, [drawMode, ready, editable]);
  // ── Waypoint dragging (#471) ──
  // MapLibre treats every gesture on the canvas as a pan unless we
  // intercept the pointer-down on the waypoint layer with
  // `e.preventDefault()`. Without that intercept, "drag a waypoint"
  // landed as a map pan and the marker stayed put.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !dragEnabled || drawMode !== "idle") return;

    const canvas = map.getCanvas();
    // Match MapLibre's `clickTolerance` exactly: it suppresses the
    // synthetic post-pointer `click` once total movement is `> 3 px`,
    // so we must clear the swallow flag (and mark the drag committed)
    // at the same boundary. A higher value left a gap where MapLibre
    // suppressed the click but we still treated the gesture as a tap,
    // swallowing the rider's next legitimate map click. MapCanvas
    // constructs the map without overriding `clickTolerance`, so the
    // default of 3 is in effect — keep this in sync if that changes.
    const CLICK_TOLERANCE_PX = 3;
    let active: {
      dayNumber: number;
      waypointId: string;
      startX: number;
      startY: number;
      moved: boolean;
    } | null = null;

    const setCursor = (cursor: string) => {
      canvas.style.cursor = cursor;
    };

    // Returns true once the gesture has travelled past the click
    // tolerance (sticky — once moved, stays moved). Used both to disarm
    // the swallow flag and to decide whether `finishDrag` should commit.
    const noteIfPastTolerance = (point: { x: number; y: number }): boolean => {
      if (!active) return false;
      if (active.moved) return true;
      const dx = point.x - active.startX;
      const dy = point.y - active.startY;
      if (dx * dx + dy * dy > CLICK_TOLERANCE_PX * CLICK_TOLERANCE_PX) {
        active.moved = true;
        // Pointer travelled far enough that MapLibre will not emit a
        // synthetic `click` for this gesture, so disarm the swallow
        // flag — leaving it true would silently eat the rider's next
        // legitimate map click.
        swallowNextClickRef.current = false;
        return true;
      }
      return false;
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
      noteIfPastTolerance(event.point);
    };
    const handleTouchMove = (event: MapTouchEvent) => {
      if (!active) return;
      event.preventDefault();
      noteIfPastTolerance(event.point);
    };
    const cancelDrag = () => {
      // Used when the gesture ends without a usable pointer position
      // (e.g. `touchcancel`, or a `touchend` with no `changedTouches`):
      // clear in-flight state so the cursor and listeners reset, but
      // do not commit a move to a fallback location.
      if (!active) return;
      active = null;
      setCursor("");
      // A cancelled touch never produces the synthetic post-pointer
      // `click` that would normally clear this flag — without this,
      // the rider's next legitimate map click would be silently
      // swallowed by `handleMapClick`.
      swallowNextClickRef.current = false;
    };
    const finishDrag = (
      lngLat: { lng: number; lat: number },
      point?: {
        x: number;
        y: number;
      },
    ) => {
      if (!active) return;
      // Last chance to detect a real drag — touch backends sometimes
      // fire only `touchstart` + `touchend` without an interim move.
      if (point) noteIfPastTolerance(point);
      const drag = active;
      active = null;
      setCursor("");
      // Tap-without-drag: the layer hit can land anywhere inside the
      // marker circle, so committing the mouseup `lngLat` would
      // silently shift the waypoint by a few pixels. Bail out and let
      // `swallowNextClickRef` swallow the synthetic click so the tap is
      // a true no-op.
      if (!drag.moved) return;
      const snapped = point ? snapPointerToRoad(map, point, lngLat) : null;
      const target = snapped ?? {
        lng: roundCoordinate(lngLat.lng),
        lat: roundCoordinate(lngLat.lat),
      };
      onMoveWaypointRef.current?.(drag.dayNumber, drag.waypointId, target);
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
      active = {
        dayNumber: props.dayNumber,
        waypointId: props.waypointId,
        startX: event.point.x,
        startY: event.point.y,
        moved: false,
      };
      // Even with `preventDefault()` here, MapLibre still fires a `click`
      // when the pointer never moves beyond `clickTolerance` (see its
      // `map_events.test`). Flag the upcoming click so `handleMapClick`
      // ignores it instead of treating the drop as a fresh map click.
      // The flag is cleared by `noteIfPastTolerance` as soon as the
      // gesture exceeds clickTolerance, so a real drag does not swallow
      // the rider's next legitimate map click.
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

    // ── Window-level fallbacks ──
    // `map.on("mouseup", …)` only fires when the release lands on the
    // canvas. If the rider drags out past the map edge and lets go in
    // the surrounding chrome, the map handler never runs — so `active`
    // would stay set, the cursor would stick on "grabbing", and the
    // drop would be lost. Mirror the up handlers at the window level
    // so a release anywhere still finishes the gesture; both `active`
    // and `swallowNextClickRef` already guard against double-firing
    // when the release is over the canvas.
    const finishFromClient = (clientX: number, clientY: number) => {
      if (!active) return;
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      const lngLat = map.unproject([point.x, point.y]);
      finishDrag({ lng: lngLat.lng, lat: lngLat.lat }, point);
    };
    const onWindowMouseUp = (event: MouseEvent) => {
      finishFromClient(event.clientX, event.clientY);
    };
    const onWindowTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) {
        cancelDrag();
        return;
      }
      finishFromClient(touch.clientX, touch.clientY);
    };
    const onWindowTouchCancel = () => {
      cancelDrag();
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    window.addEventListener("touchend", onWindowTouchEnd);
    window.addEventListener("touchcancel", onWindowTouchCancel);

    return () => {
      map.off("mouseenter", WAYPOINT_CIRCLE, handleEnter);
      map.off("mouseleave", WAYPOINT_CIRCLE, handleLeave);
      map.off("mousedown", WAYPOINT_CIRCLE, beginDrag);
      map.off("touchstart", WAYPOINT_CIRCLE, beginDrag);
      map.off("mousemove", handleMouseMove);
      map.off("touchmove", handleTouchMove);
      map.off("mouseup", handleMouseUp);
      map.off("touchend", handleTouchEnd);
      window.removeEventListener("mouseup", onWindowMouseUp);
      window.removeEventListener("touchend", onWindowTouchEnd);
      window.removeEventListener("touchcancel", onWindowTouchCancel);
      setCursor("");
    };
  }, [drawMode, dragEnabled, ready]);
  const fitMapToTrip = useCallback(() => {
    const map = handleRef.current?.map;
    if (!map || !tripBounds) return;
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
  }, [tripBounds]);

  useEffect(() => {
    // One-shot auto-fit per trip, but ONLY for a trip we first see with a
    // real (multi-point) route — i.e. an existing trip loaded into the
    // planner. A trip first seen empty or as a single point is a draft the
    // rider is building; we record it and never auto-fit, so placing the
    // first waypoint (which mints a new `trip.id`) doesn't rip their zoom
    // back out. Either way the explicit Fit-to-route button reframes on demand.
    const map = handleRef.current?.map;
    if (!map || !ready || !trip) return;
    if (fittedTripIdRef.current === trip.id) return;
    if (builtTripIdRef.current === trip.id) return;
    // Framable = the bounds span an area (>1 distinct point). A loaded trip
    // arrives fully hydrated (geometry present at first sight), so its bounds
    // already have area; a fresh draft's first point has none.
    const framable =
      !!tripBounds &&
      (tripBounds[2] - tripBounds[0] > 0 || tripBounds[3] - tripBounds[1] > 0);
    if (!framable) {
      builtTripIdRef.current = trip.id;
      return;
    }
    fittedTripIdRef.current = trip.id;
    fitMapToTrip();
  }, [ready, trip, tripBounds, fitMapToTrip]);

  // Imperative refit triggered by the parent — page-level flows
  // that swap route geometry without changing `trip.id` (selecting
  // a different generated option, replacing an imported route)
  // bump `fitRouteToken` to re-frame the new bounds. Skipped on
  // initial mount (the per-trip-id auto-fit above handles that).
  const lastFitTokenRef = useRef<number | undefined>(fitRouteToken);
  useEffect(() => {
    if (fitRouteToken === undefined) return;
    if (lastFitTokenRef.current === fitRouteToken) return;
    lastFitTokenRef.current = fitRouteToken;
    if (!ready || !tripBounds) return;
    fitMapToTrip();
  }, [fitRouteToken, ready, tripBounds, fitMapToTrip]);
  // Expose fitRoute() so Task 11 can wire a "Fit route" button to an explicit
  // refit without depending on `fitRouteToken` or re-rendering the page.
  useImperativeHandle(
    ref,
    () => ({
      fitRoute: fitMapToTrip,
    }),
    [fitMapToTrip],
  );
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
      // v2 planner renders on a cream basemap (grey roads) regardless of the
      // viewer's scheme, matching the design.
      forceColorScheme="light"
    >
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-2">
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
          <button
            type="button"
            aria-label="Fit map to the whole route"
            onClick={fitMapToTrip}
            disabled={!ready || !tripBounds}
            // `ready` reflects the maplibre load, which only happens in the
            // browser, so this control's disabled state is inherently
            // client-only. On a real load it's `false` on both SSR and the
            // first client render; the attribute only diverges when Fast
            // Refresh preserves a loaded map across an HMR re-render.
            suppressHydrationWarning
            className={`${CREAM_PILL} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <Maximize2 size={14} />
            {t("Fit to route ")}
          </button>
        </div>

        {drawMode === "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.cancel()}
            className={`${PILL_BASE} self-start border-accent bg-cream text-accent hover:bg-paper`}
          >
            <X size={14} />
            {t("Cancel drawing ")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => drawRef.current?.start()}
            disabled={!ready}
            // Client-only disabled state — see the "Fit to route" note above.
            suppressHydrationWarning
            className={`${INK_PILL} self-start disabled:cursor-wait disabled:opacity-60`}
          >
            <Square size={14} />
            {drawnRegion ? t("Redraw region ") : t("Draw region ")}
          </button>
        )}

        {drawnRegion && drawMode !== "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.clearDrawn()}
            className={`${CREAM_PILL} self-start`}
          >
            <X size={12} />
            {t("Clear region ")}
          </button>
        ) : null}

        <div className="max-w-[320px] self-start rounded-[10px] bg-ink px-3 py-2 text-xs leading-relaxed text-cream/90 shadow-[0_4px_12px_rgba(14,14,16,0.16)]">
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

      <div className="absolute right-3 top-3 z-10 w-72 rounded-[14px] bg-ink p-4 text-cream shadow-[0_14px_36px_rgba(14,14,16,0.28)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-cream">
          <Route size={16} className="text-accent" />
          {t("Planner map ")}
        </div>
        <p className="mt-2 text-sm text-cream/90">
          {trip
            ? `${trip.days.length} day${trip.days.length === 1 ? "" : "s"} · ${waypointCount} waypoint${waypointCount === 1 ? "" : "s"}`
            : "Load the demo trip or import GPX/KML to see your route on the map."}
        </p>
        <p className="mt-2 text-xs text-cream/55">
          {t(
            "Generated routes use backend road geometry from the start waypoint and planner parameters. ",
          )}
        </p>

        <div className="mt-4 rounded-xl border border-cream/[0.12] bg-cream/[0.07] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-cream">
              <Sparkles size={14} className="text-accent" />
              {t("Fun Zones")}
            </div>
            {drawnRegion ? (
              <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                {t("Drawn")}
              </span>
            ) : null}
          </div>

          {!drawnRegion ? (
            <p className="mt-2 text-xs text-cream/55">
              {t("Draw a region to discover Fun Zones.")}
            </p>
          ) : funZonesLoading && funZones.length === 0 ? (
            <p className="mt-2 text-xs text-cream/55">
              {t("Loading Fun Zones…")}
            </p>
          ) : funZonesError ? (
            <div className="mt-2">
              <p className="text-xs text-rose-300">{funZonesError}</p>
              <button
                type="button"
                onClick={() => setFunZonesRetryNonce((value) => value + 1)}
                className="mt-2 text-xs font-medium text-accent hover:underline"
              >
                {t("Retry")}
              </button>
            </div>
          ) : funZones.length === 0 ? (
            <p className="mt-2 text-xs text-cream/55">
              {t("No Fun Zones in this region yet. Try a larger area.")}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {funZones.slice(0, 3).map((zone, index) => {
                const active = zone.id === selectedFunZoneId;
                return (
                  <button
                    key={zone.id}
                    type="button"
                    onClick={() => setSelectedFunZoneId(zone.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-cream/[0.12] bg-cream/[0.05] hover:border-cream/25"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-cream">
                          {index + 1}. {zone.name ?? fallbackZoneName(zone)}
                        </p>
                        <p className="mt-1 text-[11px] text-cream/60">
                          {zone.road_count}
                          {t(" roads")}
                          {zone.total_curve_km != null
                            ? ` · ${Math.round(zone.total_curve_km)} km curves`
                            : ""}
                        </p>
                        {zone.best_season ? (
                          <p className="mt-1 text-[11px] text-cream/55">
                            {zone.best_season}
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs font-semibold text-accent">
                        {zone.composite_score.toFixed(1)}
                        {t(" score")}
                      </span>
                    </div>
                  </button>
                );
              })}
              {funZones.length > 3 ? (
                <p className="text-[11px] text-cream/55">
                  {t("+ {count} more in this region", {
                    count: funZones.length - 3,
                  })}
                </p>
              ) : null}
            </div>
          )}

          {selectedFunZone ? (
            <div className="mt-3 border-t border-cream/[0.12] pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-cream/90">
                  {selectedFunZone.name ?? fallbackZoneName(selectedFunZone)}
                </p>
                <button
                  type="button"
                  onClick={() => setSelectedFunZoneId(null)}
                  className="text-[11px] text-cream/55 hover:text-cream/80"
                >
                  {t("Clear")}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-cream/55">
                {selectedFunZone.composite_score.toFixed(1)}
                {t(" score")}
                {selectedFunZone.avg_quality != null
                  ? ` · ${selectedFunZone.avg_quality.toFixed(1)} avg quality`
                  : ""}
              </p>
              {selectedFunZoneLoading ? (
                <p className="mt-2 text-[11px] text-cream/55">
                  {t("Loading top roads…")}
                </p>
              ) : selectedFunZoneError ? (
                <p className="mt-2 text-[11px] text-rose-300">
                  {selectedFunZoneError}
                </p>
              ) : selectedFunZoneDetail?.top_roads.length ? (
                <div className="mt-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-cream/55">
                    {t("Top roads")}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {selectedFunZoneDetail.top_roads
                      .slice(0, 3)
                      .map((road: FunZoneDetail["top_roads"][number]) => (
                        <li
                          key={road.id}
                          className="flex items-center justify-between gap-2 text-[11px] text-cream/60"
                        >
                          <span className="truncate">
                            {road.road_name ??
                              road.road_number ??
                              t("Unnamed road")}
                          </span>
                          <span className="shrink-0 text-cream/55">
                            {(road.length_m / 1000).toFixed(1)}
                            {t(" km")}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-4 rounded-xl border border-cream/[0.12] bg-cream/[0.07] p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-cream">
            <AlertTriangle size={14} className="text-amber-300" />
            {t("Conditions for ")}
            {activeMonthLabel}
          </div>

          {conditionsLoading ? (
            <p className="mt-2 text-xs text-cream/55">
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
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cream/60">
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
                          className="rounded-lg border border-cream/[0.12] bg-cream/[0.05] p-2"
                        >
                          <p className="text-xs font-medium text-cream">
                            {closure.title}
                          </p>
                          <p className="mt-1 text-[11px] text-cream/60">
                            {reasonLabel(closure.reason)}
                          </p>
                          <p className="mt-1 text-[11px] text-cream/55">
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
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cream/60">
                    <Mountain size={12} />
                    {t("Passes ")}
                  </div>
                  <ul className="mt-2 space-y-2">
                    {highlightedPasses.slice(0, 2).map((pass) => (
                      <li
                        key={pass.id}
                        className="rounded-lg border border-cream/[0.12] bg-cream/[0.05] p-2"
                      >
                        <p className="text-xs font-medium text-cream">
                          {pass.name}
                        </p>
                        <p className="mt-1 text-[11px] text-cream/60">
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
      {/* ── Context menu overlay (Task 10) ── */}
      {contextMenu ? (
        <div
          role="menu"
          aria-label={t("Place waypoint")}
          className="fixed z-30 min-w-[160px] overflow-hidden rounded-xl border border-line bg-cream shadow-[0_6px_20px_rgba(14,14,16,0.16)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ul className="py-1">
            {buildPlacementMenu({ hasStart, hasEnd }).map((action) => (
              <li key={action.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-paper"
                  onClick={() => handleContextMenuAction(action.id)}
                >
                  {t(action.label)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </MapCanvas>
  );
});
// v2 map-overlay pills. The design floats cream/translucent pills over the
// cream basemap (with a soft shadow + blur), reserving solid ink for the
// primary "Draw region" action.
const PILL_BASE =
  "flex items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12.5px] font-bold shadow-[0_4px_12px_rgba(14,14,16,0.1)] backdrop-blur-[6px] transition";
const CREAM_PILL = `${PILL_BASE} border-line-strong bg-cream/80 text-fg-dim hover:bg-cream hover:text-ink`;
const INK_PILL = `${PILL_BASE} border-ink bg-ink text-cream hover:bg-ink/90`;

function toggleClassName(active: boolean): string {
  return active
    ? `${PILL_BASE} border-accent bg-cream text-accent`
    : CREAM_PILL;
}
function fallbackZoneName(zone: FunZoneListItem): string {
  const points = zone.boundary as unknown as Array<{
    lat: number;
    lng: number;
  }>;
  if (points.length === 0) return t("Unnamed Fun Zone");
  const lat =
    points.reduce((sum: number, point) => sum + point.lat, 0) / points.length;
  const lng =
    points.reduce((sum: number, point) => sum + point.lng, 0) / points.length;
  return t("Zone near {lat}, {lng}", {
    lat: lat.toFixed(2),
    lng: lng.toFixed(2),
  });
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
        // Each day's route carries its own stable color from DAY_COLORS.
        "line-color": ["get", "color"],
        // Selected day is rendered wider and fully opaque; non-selected days are
        // thinner and dimmed so the focused day is always visually dominant.
        "line-width": [
          "case",
          ["get", "selected"],
          ["interpolate", ["linear"], ["zoom"], 6, 3, 10, 5, 14, 7],
          ["interpolate", ["linear"], ["zoom"], 6, 1.5, 10, 3, 14, 4],
        ],
        "line-opacity": ["case", ["get", "selected"], 1, 0.45],
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
        // Accent glow for the clicked segment (was cyan on the old dark map).
        "line-color": "#FF6A1A",
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
        "line-color": "#FF6A1A",
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
        // Ink label with a cream halo for legibility on the cream basemap
        // (was light text + dark halo for the old dark map).
        "text-color": "#0E0E10",
        "text-halo-color": "#F5EFE6",
        "text-halo-width": 1.4,
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
