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
import { Layers3 } from "lucide-react";
import {
  MapCanvas,
  SURFACE_COLORS,
  TARMOTO_QUALITY_LAYER,
  type MapCanvasHandle,
} from "@/components/map/MapCanvas";
import {
  ensureAerialBasemap,
  setAerialBasemapVisible,
} from "@/components/map/AerialBasemap";
import { RoadPreviewPopover } from "@/components/planner/RoadPreviewPopover";
import {
  QUALITY_BAND_COLORS,
  QUALITY_BAND_LABELS_SHORT,
} from "@/lib/planner/quality-bands";
import { rerouteAroundSegmentInTrip } from "@/lib/planner/reroute";
import type { RouteSegment } from "@/lib/planner/types";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawBbox,
  type RegionDrawMode,
} from "@/components/map/RegionDrawControl";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import {
  buildPlannerClosureLineCollection,
  buildPlannerClosureMarkerCollection,
  buildPlannerPassMarkerCollection,
} from "@/lib/trip-planner-overlays";
import {
  buildPlannerQualityRouteCollection,
  buildTripPlannerSegmentHighlightCollection,
  buildTripPlannerWaypointCollection,
  findPlannerQualitySegment,
  getTripPlannerBounds,
  plannerRouteLineColor,
  plannerSegmentBounds,
  type PlannerLineColorMode,
} from "@/lib/trip-planner-map";
import { useTripStore, dayFinishWaypoint } from "@/stores/trip";
import {
  buildPlacementMenu,
  type PlacementActionId,
} from "@/lib/planner-context-menu";
import {
  snapWaypointToRoadFeatures,
  type RoadSnapFeature,
} from "@/lib/trip-planner-snap";
import { fetchFunZonesInBbox } from "@/lib/discover";
import { plannerApi } from "@/lib/planner/api";
import {
  FUN_ZONES_FILL,
  installFunZoneLayer,
  setFunZoneSelection,
  updateFunZoneLayerData,
} from "@/components/map/FunZoneLayer";
import type { Trip } from "@/lib/types";
import type { TripSuggestion } from "@/lib/api";
import type { CollaboratorCursor } from "@/hooks/useTripCollabSession";
import { roundCoordinate } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";
export interface DayBreakMarker {
  lng: number;
  lat: number;
  label: string;
  pinned: boolean;
}

/** Imperative handle exposed on the TripPlannerMap ref (Task 11). */
export interface TripPlannerMapHandle {
  /** Fit the viewport to the current route bounds. No-op when no bounds. */
  fitRoute: () => void;
  /**
   * Fly to a quality segment's bounds (panel → map). No-op when the
   * segment id doesn't resolve against the current trip geometry.
   */
  flyToSegment: (segmentId: string) => void;
  /**
   * Begin drawing a Fun-Zone region. Driven by the BUILD-column
   * checkbox card — the map no longer renders its own Draw region
   * button (rider feedback).
   */
  startRegionDraw: () => void;
  /** Cancel an in-progress region draw (leaves a drawn region alone). */
  cancelRegionDraw: () => void;
}

const ROUTE_SOURCE = "trip-planner-route";
const WAYPOINT_SOURCE = "trip-planner-waypoints";
const ROUTE_CASING_LINE = "trip-planner-route-casing";
const ROUTE_LINE = "trip-planner-route-line";
const ROUTE_HIT_LINE = "trip-planner-route-hit";
const WAYPOINT_PIN = "trip-planner-waypoint-pin";
const WAYPOINT_LABEL = "trip-planner-waypoint-label";

/**
 * Right-click tolerance around a waypoint pin, in screen px. Symbol-layer
 * events only fire on rendered icon pixels, so without padding a near-miss
 * falls through to the placement menu — infuriating on a small target.
 */
const PIN_HIT_PADDING_PX = 8;

function queryWaypointPinsAt(
  map: MapLibreMap,
  point: { x: number; y: number },
) {
  if (!map.getLayer(WAYPOINT_PIN)) return [];
  return map.queryRenderedFeatures(
    [
      [point.x - PIN_HIT_PADDING_PX, point.y - PIN_HIT_PADDING_PX],
      [point.x + PIN_HIT_PADDING_PX, point.y + PIN_HIT_PADDING_PX],
    ],
    { layers: [WAYPOINT_PIN] },
  );
}
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
const DAY_BREAK_SOURCE = "trip-planner-day-breaks";
const DAY_BREAK_CIRCLE_LAYER = "trip-planner-day-break-circle";
const DAY_BREAK_LABEL_LAYER = "trip-planner-day-break-label";
const SEGMENT_HIGHLIGHT_SOURCE = "trip-planner-segment-highlight";
const SEGMENT_HIGHLIGHT_GLOW_LAYER = "trip-planner-segment-highlight-glow";
const SEGMENT_HIGHLIGHT_LINE_LAYER = "trip-planner-segment-highlight-line";
const FUN_ZONE_FETCH_DEBOUNCE_MS = 300;
interface TripPlannerMapProps {
  trip: Trip | null;
  month: number;
  drawnRegion?: RegionDrawBbox | null;
  onDrawnRegionChange?: (bbox: RegionDrawBbox | null) => void;
  /**
   * Mirrors the region-draw state machine to the parent so the BUILD
   * column's checkbox card can reflect drawing/idle without owning it.
   */
  onDrawModeChange?: (mode: RegionDrawMode) => void;
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
  /**
   * Called from a waypoint pin's context menu "Remove point" action.
   * Undefined hides the action (read-only maps).
   */
  onRemoveWaypoint?: (waypointId: string) => void;
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
   * Day-break markers from the splitter — one per day boundary. Rendered
   * as pinned dots with the overnight-town label.
   */
  dayBreaks?: DayBreakMarker[];
  /**
   * Called when a rider drops a day-break marker at a new location —
   * the page pins that break and re-splits around it (addendum §6).
   * Undefined keeps break markers static.
   */
  onMoveDayBreak?: (
    boundary: number,
    location: { lng: number; lat: number },
  ) => void;
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
    onDrawModeChange,
    closuresData,
    passesData,
    onAddWaypoint,
    onMoveWaypoint,
    onRemoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    dayBreaks,
    onMoveDayBreak,
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
        onDrawModeChange={onDrawModeChange}
        closuresData={closuresData}
        passesData={passesData}
        onAddWaypoint={onAddWaypoint}
        onMoveWaypoint={onMoveWaypoint}
        onRemoveWaypoint={onRemoveWaypoint}
        selectedDayNumber={selectedDayNumber}
        focusSelectedDay={focusSelectedDay}
        collaboratorCursors={collaboratorCursors}
        suggestions={suggestions}
        dayBreaks={dayBreaks}
        onMoveDayBreak={onMoveDayBreak}
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
      onDrawModeChange={onDrawModeChange}
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      onRemoveWaypoint={onRemoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      dayBreaks={dayBreaks}
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
    drawnRegion?: RegionDrawBbox | null | undefined;
    onDrawnRegionChange?: ((bbox: RegionDrawBbox | null) => void) | undefined;
    onDrawModeChange?: ((mode: RegionDrawMode) => void) | undefined;
    onAddWaypoint?:
      | ((location: { lng: number; lat: number }) => void)
      | undefined;
    onMoveWaypoint?:
      | ((
          dayNumber: number,
          waypointId: string,
          location: { lng: number; lat: number },
        ) => void)
      | undefined;
    onRemoveWaypoint?: ((waypointId: string) => void) | undefined;
    selectedDayNumber?: number | undefined;
    focusSelectedDay?: boolean | undefined;
    collaboratorCursors?: Map<string, CollaboratorCursor> | undefined;
    suggestions?: TripSuggestion[] | undefined;
    dayBreaks?: DayBreakMarker[] | undefined;
    onMoveDayBreak?:
      | ((boundary: number, location: { lng: number; lat: number }) => void)
      | undefined;
    onCursorMove?: ((lat: number, lng: number) => void) | undefined;
    fitRouteToken?: number | undefined;
  }
>(function FetchedTripPlannerMap(
  {
    trip,
    month,
    drawnRegion,
    onDrawnRegionChange,
    onDrawModeChange,
    onAddWaypoint,
    onMoveWaypoint,
    onRemoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    dayBreaks,
    onMoveDayBreak,
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
      onDrawModeChange={onDrawModeChange}
      closuresData={closuresData}
      passesData={passesData}
      onAddWaypoint={onAddWaypoint}
      onMoveWaypoint={onMoveWaypoint}
      onRemoveWaypoint={onRemoveWaypoint}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      suggestions={suggestions}
      dayBreaks={dayBreaks}
      onMoveDayBreak={onMoveDayBreak}
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
    drawnRegion?: RegionDrawBbox | null | undefined;
    onDrawnRegionChange?: ((bbox: RegionDrawBbox | null) => void) | undefined;
    onDrawModeChange?: ((mode: RegionDrawMode) => void) | undefined;
    closuresData: ClosuresQueryResult;
    passesData: PassesQueryResult;
    onAddWaypoint?:
      | ((location: { lng: number; lat: number }) => void)
      | undefined;
    onMoveWaypoint?:
      | ((
          dayNumber: number,
          waypointId: string,
          location: { lng: number; lat: number },
        ) => void)
      | undefined;
    onRemoveWaypoint?: ((waypointId: string) => void) | undefined;
    selectedDayNumber?: number | undefined;
    focusSelectedDay?: boolean | undefined;
    collaboratorCursors?: Map<string, CollaboratorCursor> | undefined;
    suggestions?: TripSuggestion[] | undefined;
    dayBreaks?: DayBreakMarker[] | undefined;
    onMoveDayBreak?:
      | ((boundary: number, location: { lng: number; lat: number }) => void)
      | undefined;
    onCursorMove?: ((lat: number, lng: number) => void) | undefined;
    fitRouteToken?: number | undefined;
  }
>(function TripPlannerMapContent(
  {
    trip,
    month: _month,
    drawnRegion: controlledDrawnRegion,
    onDrawnRegionChange,
    onDrawModeChange,
    closuresData,
    passesData,
    onAddWaypoint,
    onMoveWaypoint,
    onRemoveWaypoint,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    suggestions,
    dayBreaks,
    onMoveDayBreak,
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
  // Two INDEPENDENT map toggles (design): how the route line is colored,
  // and which basemap sits under it.
  const [lineColorMode, setLineColorMode] =
    useState<PlannerLineColorMode>("quality");
  const [basemap, setBasemap] = useState<"map" | "aerial">("map");
  const [drawMode, setDrawMode] = useState<RegionDrawMode>("idle");
  const [drawnRegion, setDrawnRegion] = useState<RegionDrawBbox | null>(
    controlledDrawnRegion ?? null,
  );
  const [selectedFunZoneId, setSelectedFunZoneId] = useState<string | null>(
    null,
  );
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  // Sidebar publishes the focused segment id so the map can paint the
  // matching slice of the route in a contrasting color (issue #473).
  const focusedSegmentId = useTripStore((s) => s.focusedSegmentId);
  // Plan & inspect selection — shared with the panel so a route click here
  // and a flagged-card click there open the same Road Preview.
  const selectedPlannerSegmentId = useTripStore(
    (s) => s.selectedPlannerSegmentId,
  );
  const selectPlannerSegment = useTripStore((s) => s.selectPlannerSegment);
  const insertWaypointBefore = useTripStore((s) => s.insertWaypointBefore);

  // ── Context-menu waypoint placement (Task 10) ────────────────────────────
  // Task 9 store actions for context-menu placement.
  const placeWaypoint = useTripStore((s) => s.placeWaypoint);
  // Derive hasStart / hasEnd from the SELECTED planner day (placement targets
  // the selected day via the store), not day 0 — otherwise the menu on Day 2
  // would offer Day 1's actions and the rider could never set Day 2's start.
  const activeTrip = useTripStore((s) => s.activeTrip);
  const selectedDayWaypoints =
    (selectedDayNumber != null
      ? activeTrip?.days.find((d) => d.dayNumber === selectedDayNumber)
      : activeTrip?.days[0]
    )?.waypoints ?? [];
  const hasStart = selectedDayWaypoints.some((w) => w.type === "start");
  // A terminal accommodation (generated overnight) counts as the day's finish,
  // so the menu offers "Add via" (inserted before it) instead of the no-end
  // actions — otherwise a via would land after the overnight and un-terminate it.
  const hasEnd = !!dayFinishWaypoint(selectedDayWaypoints);

  // Context menu state: screen position + the snapped geo coord the menu acts on.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    coords: { lng: number; lat: number };
  } | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  // Right-clicking a waypoint pin opens ITS menu instead of placement:
  // point info (role, coordinates, resolved place name) + Remove.
  const [waypointMenu, setWaypointMenu] = useState<{
    waypointId: string;
    name: string;
    role: string;
    lng: number;
    lat: number;
    x: number;
    y: number;
    address: string | null;
  } | null>(null);
  const closeWaypointMenu = useCallback(() => setWaypointMenu(null), []);

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
      buildPlannerQualityRouteCollection(
        trip,
        selectedDayNumber,
        focusSelectedDay,
      ),
    [trip, selectedDayNumber, focusSelectedDay],
  );
  // Resolve the selected quality segment against current geometry — a stale
  // id (after a reroute or undo) simply resolves to null and closes the card.
  const previewSegment = useMemo(
    () => findPlannerQualitySegment(trip, selectedPlannerSegmentId),
    [trip, selectedPlannerSegmentId],
  );
  const waypointCollection = useMemo(
    () =>
      buildTripPlannerWaypointCollection(
        trip,
        selectedDayNumber,
        focusSelectedDay,
      ),
    [trip, selectedDayNumber, focusSelectedDay],
  );
  // Latest waypoint collection for the drag preview below — the drag
  // effect must not re-run per render, so it reads through a ref.
  const waypointCollectionRef = useRef(waypointCollection);
  useEffect(() => {
    waypointCollectionRef.current = waypointCollection;
  }, [waypointCollection]);
  const tripBounds = useMemo(() => getTripPlannerBounds(trip), [trip]);
  const { closures } = closuresData;
  const { passes } = passesData;
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
  const dayBreakCollection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: (dayBreaks ?? []).map((breakMarker, index) => ({
        type: "Feature" as const,
        properties: {
          label: breakMarker.label,
          pinned: breakMarker.pinned,
          boundary: index + 1,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [breakMarker.lng, breakMarker.lat],
        },
      })),
    }),
    [dayBreaks],
  );
  const segmentHighlightCollection = useMemo(() => {
    // Plan & inspect selection wins: its derived geometry is exact, no
    // distance-slicing needed. Fall back to the legacy sidebar focus
    // (day.segments id space) when no quality segment is selected.
    if (previewSegment) {
      return {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            properties: {
              segmentId: previewSegment.id,
              dayNumber: previewSegment.dayNumber,
              orderInDay: 0,
            },
            geometry: previewSegment.geometry,
          },
        ],
      };
    }
    return buildTripPlannerSegmentHighlightCollection(trip, focusedSegmentId);
  }, [trip, focusedSegmentId, previewSegment]);
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
    closeWaypointMenu();
  }, [closeContextMenu, closeWaypointMenu]);
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
    // ── Route-section click → Road Preview Card (any segment, not just
    // flagged ones). Waypoints render on top and are the drag targets, so a
    // click that also hits a waypoint is theirs, not ours.
    map.on("mouseenter", ROUTE_HIT_LINE, () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", ROUTE_HIT_LINE, () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "";
    });
    map.on("click", ROUTE_HIT_LINE, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const overWaypoint =
        map.getLayer(WAYPOINT_PIN) &&
        map.queryRenderedFeatures(event.point, {
          layers: [WAYPOINT_PIN],
        }).length > 0;
      if (overWaypoint) return;
      const segmentId = event.features?.[0]?.properties?.segmentId as
        | string
        | undefined;
      if (!segmentId) return;
      useTripStore.getState().selectPlannerSegment(segmentId);
    });
    drawRef.current?.destroy();
    drawRef.current = createRegionDrawControl(map, {
      onRegionDrawn: (bbox) => updateDrawnRegion(bbox),
      onRegionCleared: () => updateDrawnRegion(null),
      onModeChange: (mode) => {
        setDrawMode(mode);
        onDrawModeChange?.(mode);
      },
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
    syncGeoJsonSource(map, DAY_BREAK_SOURCE, dayBreakCollection);
    syncGeoJsonSource(
      map,
      SEGMENT_HIGHLIGHT_SOURCE,
      segmentHighlightCollection,
    );
  }, [
    closureLineCollection,
    closureMarkerCollection,
    cursorCollection,
    dayBreakCollection,
    passMarkerCollection,
    ready,
    routeCollection,
    segmentHighlightCollection,
    suggestionCollection,
    waypointCollection,
  ]);
  // ── Day-break marker dragging (addendum §6) ──
  // A compact grab-drop gesture: mousedown on a break marker arms it,
  // the release location is handed to the page, which pins the break at
  // that along-route km and re-splits. The marker "jumps" to the pinned
  // break when the new DayPlans land — no mid-drag ghost needed.
  const onMoveDayBreakRef = useRef(onMoveDayBreak);
  useEffect(() => {
    onMoveDayBreakRef.current = onMoveDayBreak;
  }, [onMoveDayBreak]);
  const breakDragEnabled = onMoveDayBreak != null;
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !breakDragEnabled) return;
    let activeBoundary: number | null = null;
    const begin = (event: MapLayerMouseEvent) => {
      const boundary = event.features?.[0]?.properties?.boundary as
        | number
        | undefined;
      if (typeof boundary !== "number") return;
      event.preventDefault();
      activeBoundary = boundary;
      swallowNextClickRef.current = true;
      map.getCanvas().style.cursor = "grabbing";
    };
    const finish = (event: MapMouseEvent) => {
      if (activeBoundary === null) return;
      const boundary = activeBoundary;
      activeBoundary = null;
      map.getCanvas().style.cursor = "";
      onMoveDayBreakRef.current?.(boundary, {
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    };
    const enter = () => {
      if (activeBoundary === null) map.getCanvas().style.cursor = "grab";
    };
    const leave = () => {
      if (activeBoundary === null) map.getCanvas().style.cursor = "";
    };
    map.on("mousedown", DAY_BREAK_CIRCLE_LAYER, begin);
    map.on("mouseup", finish);
    map.on("mouseenter", DAY_BREAK_CIRCLE_LAYER, enter);
    map.on("mouseleave", DAY_BREAK_CIRCLE_LAYER, leave);
    return () => {
      map.off("mousedown", DAY_BREAK_CIRCLE_LAYER, begin);
      map.off("mouseup", finish);
      map.off("mouseenter", DAY_BREAK_CIRCLE_LAYER, enter);
      map.off("mouseleave", DAY_BREAK_CIRCLE_LAYER, leave);
    };
  }, [ready, breakDragEnabled]);
  // Line-coloring toggle — recolors the route line in place.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !map.getLayer(ROUTE_LINE)) return;
    map.setPaintProperty(
      ROUTE_LINE,
      "line-color",
      plannerRouteLineColor(lineColorMode, SURFACE_COLORS),
    );
  }, [lineColorMode, ready]);
  // Basemap toggle — swaps the imagery UNDER the route line; the quality
  // line and every planner overlay stay drawn on top.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setAerialBasemapVisible(map, basemap === "aerial");
  }, [basemap, ready]);
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
      setSelectedFunZoneId(null);
      updateFunZoneLayerData(map, []);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const zones = await fetchFunZonesInBbox(drawnRegion, {
          signal: controller.signal,
        });
        if (cancelled) return;
        const rankedZones = [...zones].sort(
          (a, b) => b.composite_score - a.composite_score,
        );
        updateFunZoneLayerData(map, rankedZones);
        setSelectedFunZoneId((current) =>
          current && rankedZones.some((zone) => zone.id === current)
            ? current
            : null,
        );
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        console.warn("[planner] fun zones fetch failed", err);
        updateFunZoneLayerData(map, []);
      }
    }, FUN_ZONE_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [drawnRegion, ready]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setFunZoneSelection(map, selectedFunZoneId);
  }, [ready, selectedFunZoneId]);
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
  // ── Waypoint pin context menu: info + remove (rider feedback) ──
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !editable) return;
    const onPinContextMenu = (event: MapMouseEvent) => {
      // Map-level handler with a padded hit test (not a layer-bound event):
      // the pin icon is a small target and a right-click a few px off must
      // still open the pin menu, not the placement menu.
      const feature = queryWaypointPinsAt(map, event.point)[0];
      if (!feature) return;
      event.preventDefault();
      const props = feature.properties as
        | { waypointId?: string; label?: string; waypointType?: string }
        | undefined;
      if (!props?.waypointId) return;
      const [lng, lat] =
        feature.geometry.type === "Point"
          ? (feature.geometry.coordinates as [number, number])
          : [event.lngLat.lng, event.lngLat.lat];
      const waypointId = props.waypointId;
      setContextMenu(null);
      setWaypointMenu({
        waypointId,
        name: props.label ?? t("Waypoint"),
        role:
          props.waypointType === "end"
            ? "finish"
            : (props.waypointType ?? "via"),
        lng,
        lat,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
        address: null,
      });
      // Resolve the place name lazily; keep the menu snappy meanwhile.
      void plannerApi
        .reverseGeocode(lat, lng)
        .then((address) => {
          setWaypointMenu((menu) =>
            menu && menu.waypointId === waypointId
              ? { ...menu, address }
              : menu,
          );
        })
        .catch(() => {
          // Address is informational — coordinates already show.
        });
    };
    map.on("contextmenu", onPinContextMenu);
    return () => {
      map.off("contextmenu", onPinContextMenu);
    };
  }, [ready, editable]);
  // ── Context-menu placement: right-click (desktop) + long-press (touch) ──
  useEffect(() => {
    const map = handleRef.current?.map;
    // Only install placement listeners on an editable (planner) map — never on
    // the read-only trip-detail map, which shares the same store.
    if (!map || !ready || drawMode !== "idle" || !editable) return;

    // Desktop: contextmenu event (right-click).
    const onContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      // A right-click ON (or near — same padded hit test as the pin menu)
      // a waypoint pin belongs to the pin's own menu, never the placement
      // menu.
      if (queryWaypointPinsAt(map, event.point).length > 0) {
        return;
      }
      // Rider feedback: waypoints MUST be placeable inside a drawn region
      // (that's exactly where a drafted route lives). Region move/resize
      // are left-drag gestures, so a right-click never conflicts with
      // them — the old hitTest guard blocked the whole rectangle. The
      // effect installing this handler already bails while drawing.
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
    // Rider feedback: the pin must STAY UNDER THE POINTER while
    // dragging, not jump on drop — preview the position by patching the
    // waypoint source locally. React state stays untouched until the
    // drop commits (or the source re-syncs from state on cancel).
    const previewDragPosition = (lngLat: { lng: number; lat: number }) => {
      if (!active?.moved) return;
      const collection = waypointCollectionRef.current;
      syncGeoJsonSource(map, WAYPOINT_SOURCE, {
        ...collection,
        features: collection.features.map((feature) =>
          feature.properties?.waypointId === active?.waypointId &&
          feature.geometry.type === "Point"
            ? {
                ...feature,
                geometry: {
                  ...feature.geometry,
                  coordinates: [lngLat.lng, lngLat.lat],
                },
              }
            : feature,
        ),
      });
    };
    const restoreDragPreview = () => {
      syncGeoJsonSource(map, WAYPOINT_SOURCE, waypointCollectionRef.current);
    };
    const handleMouseMove = (event: MapMouseEvent) => {
      if (!active) return;
      event.preventDefault();
      setCursor("grabbing");
      noteIfPastTolerance(event.point);
      previewDragPosition(event.lngLat);
    };
    const handleTouchMove = (event: MapTouchEvent) => {
      if (!active) return;
      event.preventDefault();
      noteIfPastTolerance(event.point);
      previewDragPosition(event.lngLat);
    };
    const cancelDrag = () => {
      // Used when the gesture ends without a usable pointer position
      // (e.g. `touchcancel`, or a `touchend` with no `changedTouches`):
      // clear in-flight state so the cursor and listeners reset, but
      // do not commit a move to a fallback location.
      if (!active) return;
      active = null;
      setCursor("");
      restoreDragPreview();
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
      restoreDragPreview();
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
      // Primary button only — a right-click on a pin belongs to its
      // context menu, and arming a drag here would swallow that gesture.
      const original = (event as MapMouseEvent).originalEvent as
        | MouseEvent
        | undefined;
      if (original && "button" in original && original.button !== 0) return;
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

    map.on("mouseenter", WAYPOINT_PIN, handleEnter);
    map.on("mouseleave", WAYPOINT_PIN, handleLeave);
    map.on("mousedown", WAYPOINT_PIN, beginDrag);
    map.on("touchstart", WAYPOINT_PIN, beginDrag);
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
      map.off("mouseenter", WAYPOINT_PIN, handleEnter);
      map.off("mouseleave", WAYPOINT_PIN, handleLeave);
      map.off("mousedown", WAYPOINT_PIN, beginDrag);
      map.off("touchstart", WAYPOINT_PIN, beginDrag);
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
        // Animated like the geolocate fly-to (rider feedback) — both the
        // toolbar Fit route and the fit-on-route-build glide instead of
        // snapping.
        duration: 1200,
        essential: true,
        maxZoom: 11,
      },
    );
  }, [tripBounds]);
  const flyToSegment = useCallback((segmentId: string) => {
    const map = handleRef.current?.map;
    const segment = findPlannerQualitySegment(
      useTripStore.getState().activeTrip,
      segmentId,
    );
    const bounds = segment ? plannerSegmentBounds(segment) : null;
    if (!map || !bounds) return;
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 120, maxZoom: 12 },
    );
  }, []);
  // "Reroute around this" (v1): nudge the route by inserting a via offset
  // from the flagged segment; live routing recomputes through it.
  const handleReroute = useCallback(
    (segment: RouteSegment) => {
      rerouteAroundSegmentInTrip(
        useTripStore.getState().activeTrip,
        segment,
        insertWaypointBefore,
      );
      selectPlannerSegment(null);
    },
    [insertWaypointBefore, selectPlannerSegment],
  );

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
      flyToSegment,
      startRegionDraw: () => drawRef.current?.start(),
      cancelRegionDraw: () => drawRef.current?.cancel(),
    }),
    [fitMapToTrip, flyToSegment],
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
      // The all-roads tile overlay follows the line-coloring mode so the
      // route and its surroundings speak the same color vocabulary; it is
      // hidden entirely over aerial imagery.
      showQuality={basemap === "map" && lineColorMode === "quality"}
      showSurface={basemap === "map" && lineColorMode === "surface"}
      onReady={handleReady}
      // v2 planner renders on a cream basemap (grey roads) regardless of the
      // viewer's scheme, matching the design.
      forceColorScheme="light"
    >
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-2">
        {/* Basemap toggle — swaps the map UNDER the line (independent of coloring). */}
        <div
          role="group"
          aria-label="Basemap"
          className="inline-flex self-start rounded-[10px] border border-line-strong bg-cream/80 p-[3px] shadow-[0_4px_12px_rgba(14,14,16,0.10)] backdrop-blur-sm"
        >
          {(
            [
              ["map", "Map"],
              ["aerial", "Aerial"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={basemap === id}
              onClick={() => setBasemap(id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                basemap === id
                  ? "bg-ink text-cream"
                  : "text-fg-dim hover:text-ink"
              }`}
            >
              {t(label === "Map" ? "Map " : "Aerial ")}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Line-coloring toggle — recolors the route line. */}
          <button
            type="button"
            aria-pressed={lineColorMode === "quality"}
            aria-label="Color the route line by road quality"
            onClick={() => setLineColorMode("quality")}
            className={toggleClassName(lineColorMode === "quality")}
          >
            <Layers3 size={14} />
            {t("Road quality ")}
          </button>
          <button
            type="button"
            aria-pressed={lineColorMode === "surface"}
            aria-label="Color the route line by surface"
            onClick={() => setLineColorMode("surface")}
            className={toggleClassName(lineColorMode === "surface")}
          >
            <Layers3 size={14} />
            {t("Surface ")}
          </button>
        </div>

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

      {/* ── Route legend for the active line-coloring mode ── */}
      {routeCollection.features.length > 0 ? (
        <div className="absolute bottom-8 left-3 z-10 flex gap-3.5 rounded-[10px] border border-line-strong bg-cream/90 px-3 py-2 shadow-[0_4px_12px_rgba(14,14,16,0.12)] backdrop-blur-sm">
          {lineColorMode === "quality"
            ? (
                Object.entries(QUALITY_BAND_COLORS) as [
                  keyof typeof QUALITY_BAND_COLORS,
                  string,
                ][]
              ).map(([band, color]) => (
                <span key={band} className="flex items-center gap-1.5">
                  <span
                    className="h-1 w-3.5 rounded-sm"
                    style={{ background: color }}
                  />
                  <span className="text-[11px] font-semibold text-fg-dim">
                    {QUALITY_BAND_LABELS_SHORT[band]}
                  </span>
                </span>
              ))
            : Object.entries(SURFACE_COLORS).map(([surface, color]) => (
                <span key={surface} className="flex items-center gap-1.5">
                  <span
                    className="h-1 w-3.5 rounded-sm"
                    style={{ background: color }}
                  />
                  <span className="text-[11px] font-semibold capitalize text-fg-dim">
                    {surface}
                  </span>
                </span>
              ))}
        </div>
      ) : null}
      {/* ── Road Preview Card — opened by clicking any route section ── */}
      {previewSegment ? (
        <RoadPreviewPopover
          segment={previewSegment}
          onClose={() => selectPlannerSegment(null)}
          {...(editable ? { onReroute: handleReroute } : {})}
        />
      ) : null}
      {/* ── Context menu overlay (Task 10) ── */}
      {waypointMenu ? (
        <div
          role="dialog"
          aria-label={t("Waypoint details")}
          className="fixed z-30 w-60 overflow-hidden rounded-xl border border-line bg-cream shadow-[0_6px_20px_rgba(14,14,16,0.16)]"
          style={{ left: waypointMenu.x, top: waypointMenu.y }}
        >
          <div className="px-3.5 pb-2.5 pt-3">
            <p className="font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {waypointMenu.role}
            </p>
            <p className="mt-0.5 truncate text-[13px] font-bold text-ink">
              {waypointMenu.name}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-snug text-fg-dim">
              {waypointMenu.address ?? t("Looking up the place… ")}
            </p>
            <p className="mt-1 font-mono text-[10px] tracking-[0.3px] text-fg-mute">
              {waypointMenu.lat.toFixed(5)}, {waypointMenu.lng.toFixed(5)}
            </p>
          </div>
          {onRemoveWaypoint ? (
            <button
              type="button"
              onClick={() => {
                onRemoveWaypoint(waypointMenu.waypointId);
                closeWaypointMenu();
              }}
              className="w-full border-t border-line px-3.5 py-2.5 text-left text-[12.5px] font-bold text-quality-q1 transition hover:bg-paper"
            >
              {t("Remove point")}
            </button>
          ) : null}
        </div>
      ) : null}
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

function toggleClassName(active: boolean): string {
  return active
    ? `${PILL_BASE} border-accent bg-cream text-accent`
    : CREAM_PILL;
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
const WAYPOINT_PIN_IMAGE_PREFIX = "tarmoto-waypoint-pin-";

/**
 * Canvas-drawn teardrop pins per waypoint role (2× for crisp rendering).
 * jsdom has no 2D context — tests simply get no images, and the symbol
 * layer renders nothing there.
 */
function installWaypointPinImages(map: MapLibreMap): void {
  const roles: Array<[string, string, string]> = [
    ["start", "#1F8A5B", "#FFFFFF"],
    ["via", "#1FA6B8", "#FFFFFF"],
    ["end", "#FF6A1A", "#0E0E10"],
  ];
  for (const [role, fill, ring] of roles) {
    const imageId = `${WAYPOINT_PIN_IMAGE_PREFIX}${role}`;
    if (map.hasImage?.(imageId)) continue;
    const width = 60;
    const height = 80;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    const cx = width / 2;
    const headR = 20;
    const headCy = headR + 4;
    // Teardrop: circle head + tapered tip down to the anchor point.
    ctx.beginPath();
    ctx.arc(cx, headCy, headR, Math.PI * 0.75, Math.PI * 0.25);
    ctx.lineTo(cx, height - 4);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = ring;
    ctx.stroke();
    // Inner dot for the classic pin look.
    ctx.beginPath();
    ctx.arc(cx, headCy, 7, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    const image = ctx.getImageData(0, 0, width, height);
    map.addImage(imageId, image, { pixelRatio: 2 });
  }
}

function ensurePlannerLayers(map: MapLibreMap): void {
  // Aerial basemap raster sits under every planner layer AND under the
  // tarmoto tile overlays (the lowest custom layer MapCanvas installs).
  ensureAerialBasemap(map, TARMOTO_QUALITY_LAYER);
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: "geojson",
      data: buildPlannerQualityRouteCollection(null),
    });
  }
  // Cream casing under the colored segments so the quality line reads
  // against both the cream basemap and aerial imagery (design frames).
  if (!map.getLayer(ROUTE_CASING_LINE)) {
    map.addLayer({
      id: ROUTE_CASING_LINE,
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#F5EFE6",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          ["case", ["get", "selected"], 6, 3.5],
          10,
          ["case", ["get", "selected"], 9, 6],
          14,
          ["case", ["get", "selected"], 12, 8],
        ],
        "line-opacity": ["case", ["get", "selected"], 0.85, 0.4],
      },
    });
  }
  if (!map.getLayer(ROUTE_LINE)) {
    map.addLayer({
      id: ROUTE_LINE,
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        // Quality-segmented coloring by default; the [Road quality|Surface]
        // toggle swaps this expression via setPaintProperty.
        "line-color": plannerRouteLineColor("quality", SURFACE_COLORS),
        // Selected day is rendered wider and fully opaque; non-selected days are
        // thinner and dimmed so the focused day is always visually dominant.
        // MapLibre allows only ONE zoom-based subexpression and it must be the
        // outermost, so the zoom interpolation stays at the top and the
        // selected/dimmed width is a data-driven `case` in each stop value. A
        // `case` wrapping two zoom interpolations throws ("Only one zoom-based
        // step or interpolate subexpression may be used") and aborts the whole
        // layer setup, so the route line never renders.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          ["case", ["get", "selected"], 3, 1.5],
          10,
          ["case", ["get", "selected"], 5, 3],
          14,
          ["case", ["get", "selected"], 7, 4],
        ],
        "line-opacity": ["case", ["get", "selected"], 1, 0.45],
      },
    });
  }
  // Invisible wide hit line so ANY route section is comfortably clickable
  // (opens the Road Preview Card) without fattening the visible line.
  if (!map.getLayer(ROUTE_HIT_LINE)) {
    map.addLayer({
      id: ROUTE_HIT_LINE,
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#000000",
        "line-opacity": 0,
        "line-width": 22,
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
  installWaypointPinImages(map);
  if (!map.getLayer(WAYPOINT_PIN)) {
    map.addLayer({
      id: WAYPOINT_PIN,
      type: "symbol",
      source: WAYPOINT_SOURCE,
      layout: {
        // Teardrop pins (rider feedback) in the spine's role colors:
        // start green, vias/stops teal, finish coral — panel and map
        // always agree on what "finish" looks like.
        "icon-image": [
          "match",
          ["get", "waypointType"],
          "start",
          `${WAYPOINT_PIN_IMAGE_PREFIX}start`,
          "end",
          `${WAYPOINT_PIN_IMAGE_PREFIX}end`,
          `${WAYPOINT_PIN_IMAGE_PREFIX}via`,
        ],
        // The image is authored at 2× (pixelRatio 2 → 30×40 logical px);
        // full size reads clearly and gives right-clicks a real target.
        "icon-size": 1,
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
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
        // Single hosted font, not a stack: OpenFreeMap's glyph server only
        // serves single-face fontstacks, so MapLibre's default stack (and
        // any comma-joined list) 404s on every label range and falls back
        // to noisy local glyph rendering.
        "text-font": ["Noto Sans Regular"],
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
  // Day-break markers (splitter boundaries): a pin-style dot + town label.
  if (!map.getSource(DAY_BREAK_SOURCE)) {
    map.addSource(DAY_BREAK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(DAY_BREAK_CIRCLE_LAYER)) {
    map.addLayer({
      id: DAY_BREAK_CIRCLE_LAYER,
      type: "circle",
      source: DAY_BREAK_SOURCE,
      paint: {
        "circle-radius": 8,
        // Pinned (manual) breaks render accent; computed ones ink.
        "circle-color": ["case", ["get", "pinned"], "#FF6A1A", "#0E0E10"],
        "circle-stroke-color": "#F5EFE6",
        "circle-stroke-width": 2.5,
      },
    });
  }
  if (!map.getLayer(DAY_BREAK_LABEL_LAYER)) {
    map.addLayer({
      id: DAY_BREAK_LABEL_LAYER,
      type: "symbol",
      source: DAY_BREAK_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-offset": [0, 1.3],
        "text-size": 11,
        "text-anchor": "top",
        "text-font": ["Noto Sans Regular"],
      },
      paint: {
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
        // See WAYPOINT_LABEL: single hosted font avoids glyph 404 spam.
        "text-font": ["Noto Sans Regular"],
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
