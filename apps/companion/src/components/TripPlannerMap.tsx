"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import type { Translate } from "@/i18n";
import { useFormat } from "@/format/FormatProvider";
import { translateKnownLabel, WAYPOINT_ROLE_LABELS } from "@/i18n/domainLabels";
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
import { Layers3, Siren, TriangleAlert } from "lucide-react";
import {
  MapCanvas,
  SURFACE_COLORS,
  TARMOTO_QUALITY_LAYER,
  TARMOTO_ROAD_HIT_LAYER,
  TARMOTO_SURFACE_LAYER,
  type MapCanvasHandle,
} from "@/components/map/MapCanvas";
import {
  pickNearestLineFeature,
  readSegmentId,
  SEGMENT_HIT_PADDING_PX,
} from "@/lib/map-segment-hit";
import {
  ensureAerialBasemap,
  firstSymbolLayerId,
  setAerialBasemapVisible,
} from "@/components/map/AerialBasemap";
import { RoadPreviewPopover } from "@/components/planner/RoadPreviewPopover";
import { MapToolbar } from "@/components/planner/MapToolbar";
import {
  MapPointPopover,
  type PoiPopoverActions,
} from "@/components/map/MapPointPopover";
import {
  basemapPlaceCategoryDisplay,
  getBasemapPoiLayerIds,
  readBasemapPlace,
  topBasemapPlaceAt,
  type BasemapPlace,
} from "@/lib/basemap-poi";
import {
  ensureConditionLayers,
  setConditionLayersVisible,
  CLOSURE_LINE_SOURCE,
  CLOSURE_MARKER_SOURCE,
  PASS_MARKER_SOURCE,
  CLOSURE_MARKER_LAYER,
  PASS_MARKER_LAYER,
} from "@/components/map/ConditionMarkerLayer";
import {
  ensureHazardLayers,
  expandHazardCluster,
  setHazardLayersVisible,
  HAZARD_BG,
  HAZARD_CLUSTERS,
  type HazardProps,
} from "@/components/map/HazardPinLayer";
import { useViewportHazards } from "@/hooks/useViewportHazards";
import { FSQ_ATTRIBUTION, OSM_ATTRIBUTION } from "@/components/map/attribution";
import {
  QUALITY_BAND_COLORS,
  QUALITY_BAND_LABELS_SHORT,
} from "@/lib/planner/quality-bands";
import { MapLegend } from "@/components/map/MapLegend";
import {
  insertionAnchorForPoint,
  nearestDayIndexToPoint,
  rerouteAroundSegmentInTrip,
} from "@/lib/planner/reroute";
import type { GeoResult, Poi, PoiCategory } from "@/lib/planner/types";
import type { RouteSegment } from "@/lib/planner/types";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawBbox,
  type RegionDrawMode,
} from "@/components/map/RegionDrawControl";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { useRoadQualityZoomCap, useSystemSwitch } from "@/hooks";
import { resolveQualityLayerMaxZoom } from "@/lib/map-entitlements";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import {
  buildTripClosureRoutes,
  type PlannerClosure,
} from "@/lib/closures-summary";
import type { MountainPass as MountainPassSummary } from "@/lib/passes-summary";
import { rerouteAroundConditionInTrip } from "@/lib/planner/reroute";
import {
  buildPlannerClosureLineCollection,
  buildPlannerClosureMarkerCollection,
  buildPlannerPassMarkerCollection,
} from "@/lib/trip-planner-overlays";
import {
  buildPlannerQualityRouteCollection,
  buildPlannerRouteOverviewCollection,
  buildTripPlannerSegmentHighlightCollection,
  buildTripPlannerWaypointCollection,
  findPlannerQualitySegment,
  getTripPlannerBounds,
  getTripPlannerDayBounds,
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
import type { Trip, Waypoint } from "@/lib/types";
import type {
  CollaboratorCursor,
  CollaboratorProfile,
} from "@/hooks/useTripCollabSession";
import { Marker } from "maplibre-gl";
import { createRoot, type Root } from "react-dom/client";
import { UserAvatar } from "@/components/UserAvatar";
import { roundCoordinate } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
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
   * Fit the viewport to one day's route bounds (day-card selection).
   * No-op when the day has no framable geometry.
   */
  fitDay: (dayNumber: number) => void;
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
  /**
   * Fly to a POI and open its pin popover (revision 5 §D) — the STOPS
   * rows reuse the exact map-pin interaction instead of a list-only
   * path.
   */
  openPoiPopover: (poi: Poi) => void;
  /**
   * Fly to a condition marker and open its popover (revision 7) — the
   * CONDITIONS tab's on-route cards reuse the marker interaction.
   */
  openConditionPopover: (ref: { kind: "closure" | "pass"; id: string }) => void;
}

// The planner colours the route line in 4 coarse quality bands — the legend
// uses the same colours + short labels the line is painted with.
const PLANNER_QUALITY_LEGEND = (
  Object.keys(QUALITY_BAND_COLORS) as (keyof typeof QUALITY_BAND_COLORS)[]
).map((band) => ({
  label: QUALITY_BAND_LABELS_SHORT[band],
  color: QUALITY_BAND_COLORS[band],
}));

const ROUTE_SOURCE = "trip-planner-route";
const ROUTE_OVERVIEW_SOURCE = "trip-planner-route-overview";
const WAYPOINT_SOURCE = "trip-planner-waypoints";
const ROUTE_CASING_LINE = "trip-planner-route-casing";
const ROUTE_OVERVIEW_LINE = "trip-planner-route-overview-line";
const ROUTE_LINE = "trip-planner-route-line";
const ROUTE_HIT_LINE = "trip-planner-route-hit";
const WAYPOINT_PIN = "trip-planner-waypoint-pin";

/**
 * Right-click tolerance around a waypoint pin, in screen px. Symbol-layer
 * events only fire on rendered icon pixels, so without padding a near-miss
 * falls through to the placement menu — infuriating on a small target.
 */
const PIN_HIT_PADDING_PX = 8;

const POI_SOURCE = "trip-planner-pois";
const POI_CLUSTER_LAYER = "trip-planner-poi-clusters";
const POI_CLUSTER_COUNT_LAYER = "trip-planner-poi-cluster-count";
const POI_PIN_LAYER = "trip-planner-poi-pins";
/** Viewport/filter refetch debounce for the category POI layer (§C). */
const POI_FETCH_DEBOUNCE_MS = 400;
/**
 * Ambient condition markers reveal at planning zoom (revision 7) — at
 * country zoom they'd be noise; the closure lines still hint presence.
 */
/**
 * Route line colour when no data layer is active (quality/surface toggled
 * off): plain ink so the route reads as geometry, not as a measurement.
 */
const NEUTRAL_ROUTE_LINE_COLOR = "#0E0E10";
const ROUTE_OVERVIEW_LINE_COLOR = "#FF6A1A";
const DETAILED_ROUTE_MIN_ZOOM = 10;
const POI_PIN_IMAGE_PREFIX = "tarmoto-poi-pin-";

/**
 * Lucide 24x24 icon geometry per category (same glyphs as the toolbar
 * chips) — rasterized into accent-circle pin images so riders can tell
 * WHAT a pin is before clicking it.
 */
const POI_PIN_ICON_CHILDREN: Record<PoiCategory, string> = {
  fuel: '<path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5"/><path d="M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"/><path d="M2 21h13"/><path d="M3 9h11"/>',
  food: '<path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/>',
  cafe: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  viewpoint:
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  campground:
    '<path d="M3.5 21 14 3"/><path d="M20.5 21 10 3"/><path d="M15.5 21 12 15l-3.5 6"/><path d="M2 21h20"/>',
  biker_hotel:
    '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  mountain_pass:
    '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/>',
  // Design frame glyph — S-bends, not the lucide route icon.
  twisty_highlight:
    '<path d="M5 20c3 0 3-5 6-5s3 5 6 5M5 9c3 0 3-5 6-5s3 5 6 5"/>',
};

/**
 * Waypoint stop-type per POI category for "Add as stop" (revision 4 §C)
 * — only categories with a stop semantic map; the rest stay via-only.
 */
const STOP_TYPE_BY_CATEGORY: Partial<Record<PoiCategory, Waypoint["type"]>> = {
  fuel: "fuel",
  food: "rest",
  cafe: "rest",
  viewpoint: "photo",
  campground: "accommodation",
  biker_hotel: "accommodation",
};

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
  /**
   * Fired when the Road Preview popover's "Reroute around this" kicks
   * off a reroute — the page arms an animated fit for the new line.
   */
  onRerouteRequested?: () => void;
  selectedDayNumber?: number;
  /**
   * When true, only the selected day's route is rendered on the map.
   * When false (default), all days are shown color-coded.
   */
  focusSelectedDay?: boolean;
  /** Live cursors from other collaborators keyed by user id. */
  collaboratorCursors?: Map<string, CollaboratorCursor>;
  /** Roster keyed by user id — renders each cursor as that rider's avatar. */
  collaboratorProfiles?: Map<string, CollaboratorProfile>;
  /**
   * Suggestions to render as markers on the map. Accepted + rejected
   * are filtered out at build time so only `status === 'open'` markers
   * show — resolved proposals no longer need a map affordance.
   */
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
  /**
   * Shows the map-top address search + POI category bar on a read-only
   * map (trip preview). Search only flies to the picked result — it
   * never opens the placement menu — and POI pins open an info-only
   * popover without the add/set route actions. Editable maps render
   * the toolbar regardless of this flag.
   */
  searchAndPois?: boolean;
  /**
   * Road segment whose detail drawer is open, so the shared map canvas can
   * paint it with the selected-segment highlight (parity with /explore).
   */
  selectedRoadSegmentId?: string | null;
  /**
   * Open the shared road-segment detail drawer (quality history + reviews)
   * for a `road_segments` UUID. Fired when a rider taps an off-route mapped
   * segment on the tile overlay, or the Road Preview popover's "Full segment
   * info" action. Undefined leaves those affordances inert.
   */
  onOpenSegmentDetail?: (roadSegmentId: string) => void;
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
    onRerouteRequested,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    collaboratorProfiles,
    dayBreaks,
    onMoveDayBreak,
    onCursorMove,
    fitRouteToken,
    searchAndPois,
    selectedRoadSegmentId,
    onOpenSegmentDetail,
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
        onRerouteRequested={onRerouteRequested}
        selectedDayNumber={selectedDayNumber}
        focusSelectedDay={focusSelectedDay}
        collaboratorCursors={collaboratorCursors}
        collaboratorProfiles={collaboratorProfiles}
        dayBreaks={dayBreaks}
        onMoveDayBreak={onMoveDayBreak}
        onCursorMove={onCursorMove}
        fitRouteToken={fitRouteToken}
        searchAndPois={searchAndPois}
        selectedRoadSegmentId={selectedRoadSegmentId}
        onOpenSegmentDetail={onOpenSegmentDetail}
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
      onRerouteRequested={onRerouteRequested}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      dayBreaks={dayBreaks}
      onCursorMove={onCursorMove}
      fitRouteToken={fitRouteToken}
      searchAndPois={searchAndPois}
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
    onRerouteRequested?: (() => void) | undefined;
    selectedDayNumber?: number | undefined;
    focusSelectedDay?: boolean | undefined;
    collaboratorCursors?: Map<string, CollaboratorCursor> | undefined;
    collaboratorProfiles?: Map<string, CollaboratorProfile> | undefined;
    dayBreaks?: DayBreakMarker[] | undefined;
    onMoveDayBreak?:
      | ((boundary: number, location: { lng: number; lat: number }) => void)
      | undefined;
    onCursorMove?: ((lat: number, lng: number) => void) | undefined;
    fitRouteToken?: number | undefined;
    searchAndPois?: boolean | undefined;
    selectedRoadSegmentId?: string | null | undefined;
    onOpenSegmentDetail?: ((roadSegmentId: string) => void) | undefined;
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
    onRerouteRequested,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    collaboratorProfiles,
    dayBreaks,
    onMoveDayBreak,
    onCursorMove,
    fitRouteToken,
    searchAndPois,
    selectedRoadSegmentId,
    onOpenSegmentDetail,
  },
  ref,
) {
  const t = useTranslation();
  const closureRoutes = useMemo(
    () => buildTripClosureRoutes(trip, t),
    [t, trip],
  );
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
      onRerouteRequested={onRerouteRequested}
      selectedDayNumber={selectedDayNumber}
      focusSelectedDay={focusSelectedDay}
      collaboratorCursors={collaboratorCursors}
      collaboratorProfiles={collaboratorProfiles}
      dayBreaks={dayBreaks}
      onMoveDayBreak={onMoveDayBreak}
      onCursorMove={onCursorMove}
      fitRouteToken={fitRouteToken}
      searchAndPois={searchAndPois}
      selectedRoadSegmentId={selectedRoadSegmentId}
      onOpenSegmentDetail={onOpenSegmentDetail}
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
    onRerouteRequested?: (() => void) | undefined;
    selectedDayNumber?: number | undefined;
    focusSelectedDay?: boolean | undefined;
    collaboratorCursors?: Map<string, CollaboratorCursor> | undefined;
    collaboratorProfiles?: Map<string, CollaboratorProfile> | undefined;
    dayBreaks?: DayBreakMarker[] | undefined;
    onMoveDayBreak?:
      | ((boundary: number, location: { lng: number; lat: number }) => void)
      | undefined;
    onCursorMove?: ((lat: number, lng: number) => void) | undefined;
    fitRouteToken?: number | undefined;
    searchAndPois?: boolean | undefined;
    selectedRoadSegmentId?: string | null | undefined;
    onOpenSegmentDetail?: ((roadSegmentId: string) => void) | undefined;
  }
>(function TripPlannerMapContent(
  {
    trip,
    month,
    drawnRegion: controlledDrawnRegion,
    onDrawnRegionChange,
    onDrawModeChange,
    closuresData,
    passesData,
    onAddWaypoint,
    onMoveWaypoint,
    onRemoveWaypoint,
    onRerouteRequested,
    selectedDayNumber,
    focusSelectedDay,
    collaboratorCursors,
    collaboratorProfiles,
    dayBreaks,
    onMoveDayBreak,
    onCursorMove,
    fitRouteToken,
    searchAndPois,
    selectedRoadSegmentId,
    onOpenSegmentDetail,
  },
  ref,
) {
  const t = useTranslation();
  const format = useFormat();
  // The map is "editable" only when the parent wires up waypoint editing (the
  // planner passes onMoveWaypoint; the read-only trip-detail page does not).
  // Gate the placement context menu on this so a right-click/long-press on the
  // detail map can't open the menu and mutate the global trip store. A boolean
  // keeps the placement effect's deps stable despite inline-callback identity.
  const editable = onMoveWaypoint != null;
  // Search + POI browsing is available on editable maps and on read-only maps
  // that opt in via `searchAndPois` (trip preview) — the toolbar and the POI
  // pin fetching key off this, while placement stays gated on `editable`.
  const poiBrowsing = editable || searchAndPois === true;
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  // One-way latch: once a Foursquare POI has appeared, keep the map-bar
  // Foursquare credit on for the session (#869) — the attribution control
  // shouldn't flicker off as the rider pans to an OSM-only area.
  const sawFsqRef = useRef(false);
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
  // ── Ambient conditions layer (revision 7): toggle + marker popover ──
  const [conditionsVisible, setConditionsVisible] = useState(true);
  // Ambient hazards (opt-in on the trip maps — off by default so route
  // planning isn't crowded). `hazardMenu` opens the shared point popover.
  const [hazardsVisibleChoice, setHazardsVisible] = useState(false);
  // The hook this map uses clears the GeoJSON source on a kill, but the map's
  // OWN state does not know: the Hazards button stays pressed, the legend stays,
  // and an open popover stays. Derive the effective value so all three follow.
  // The rider's choice is preserved, so it returns when the switch is lifted.
  const { enabled: hazardAlertsEnabled } =
    useFeatureKillSwitch("hazard_alerts");
  const hazardsVisible = hazardsVisibleChoice && hazardAlertsEnabled;
  const [hazardMenu, setHazardMenu] = useState<{
    hazard: HazardProps;
    lng: number;
    lat: number;
    x: number;
    y: number;
  } | null>(null);
  const closeHazardMenu = useCallback(() => setHazardMenu(null), []);
  // A basemap (OpenStreetMap) POI — the style's own parking/park/info icons.
  const [placeMenu, setPlaceMenu] = useState<{
    place: BasemapPlace;
    x: number;
    y: number;
  } | null>(null);
  const closePlaceMenu = useCallback(() => setPlaceMenu(null), []);
  const [conditionMenu, setConditionMenu] = useState<
    | {
        kind: "closure";
        closure: PlannerClosure;
        affectsRoute: boolean;
        lng: number;
        lat: number;
        x: number;
        y: number;
      }
    | {
        kind: "pass";
        pass: MountainPassSummary;
        affectsRoute: boolean;
        lng: number;
        lat: number;
        x: number;
        y: number;
      }
    | null
  >(null);
  const closeConditionMenu = useCallback(() => setConditionMenu(null), []);
  /** Latest condition arrays for ready-time click closures. */
  const conditionsRef = useRef<{
    closures: readonly PlannerClosure[];
    passes: readonly MountainPassSummary[];
    affectsClosureIds: ReadonlySet<string>;
    affectsPassIds: ReadonlySet<string>;
  }>({
    closures: [],
    passes: [],
    affectsClosureIds: new Set(),
    affectsPassIds: new Set(),
  });
  // ── Category POI layer (revision 4 §C) ──
  const activePoiCategories = useTripStore((s) => s.activePoiCategories);
  const planningMode = useTripStore((s) => s.planningMode);
  const [poiViewportToken, setPoiViewportToken] = useState(0);
  // Hazards can be toggled on read-only maps that never opt into POI browsing,
  // so they need their own viewport token — the POI one only bumps while
  // `poiBrowsing`, which would leave hazards stale after pan/zoom.
  const [hazardViewportToken, setHazardViewportToken] = useState(0);
  const [poiMenu, setPoiMenu] = useState<{
    poi: Poi;
    x: number;
    y: number;
    /** Set when the popover was opened from an already-placed waypoint. */
    placedWaypointId?: string;
  } | null>(null);
  const closePoiMenu = useCallback(() => setPoiMenu(null), []);
  /** id → Poi for resolving pin clicks back to the fetched objects. */
  const poisByIdRef = useRef(new Map<string, Poi>());
  // POIs already placed as waypoints (their waypoint id is
  // poi-<poiId>-<timestamp>) render ONLY as their role-colored waypoint
  // circle — never a second POI pin stacked underneath (rider feedback).
  const usedPois = useMemo(() => {
    const ids = new Set<string>();
    const spots = new Set<string>();
    for (const day of trip?.days ?? []) {
      for (const waypoint of day.waypoints) {
        const match = /^poi-(.*)-\d+$/.exec(waypoint.id);
        if (match?.[1]) ids.add(match[1]);
        // Start/finish placed from a POI keep planner ids — match those
        // by exact coordinates instead.
        spots.add(`${waypoint.location.lng},${waypoint.location.lat}`);
      }
    }
    return { ids, spots };
  }, [trip]);
  // Bounce `onMoveWaypoint` through a ref so a fresh callback identity
  // on every parent render (the planner page passes an inline arrow,
  // and live collab cursor/suggestion updates re-render mid-drag) does
  // not retrigger the drag effect and discard the in-flight `active`
  // state — that bug would silently drop the rider's drop.
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  useEffect(() => {
    onMoveWaypointRef.current = onMoveWaypoint;
  }, [onMoveWaypoint]);
  // handleReady closes over props once, so route the drawer-opener through a
  // ref the ambient tile-overlay click reads live.
  const onOpenSegmentDetailRef = useRef(onOpenSegmentDetail);
  useEffect(() => {
    onOpenSegmentDetailRef.current = onOpenSegmentDetail;
  }, [onOpenSegmentDetail]);
  // The exclusive zoom above which the quality overlay is hidden. Waypoint
  // snapping keeps the UNCAPPED hit layer, but tap-for-DETAIL opens the
  // quality drawer (exact score, provenance, confidence, history), so it must
  // respect the resolved cap — a capped rider zoomed past it must not pull the
  // gated detail. Bounced through a ref for the once-captured click closure.
  const { limit: qualityZoomLimit, isResolved: qualityZoomResolved } =
    useRoadQualityZoomCap();
  const qualityMaxZoomRef = useRef(
    resolveQualityLayerMaxZoom(qualityZoomLimit, qualityZoomResolved),
  );
  qualityMaxZoomRef.current = resolveQualityLayerMaxZoom(
    qualityZoomLimit,
    qualityZoomResolved,
  );
  const dragEnabled = onMoveWaypoint != null;
  const [ready, setReady] = useState(false);
  // Two INDEPENDENT map toggles (design): how the route line is colored,
  // and which basemap sits under it.
  // null = no data layer on the route line (neutral ink) and no legend.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const [lineColorModeChoice, setLineColorMode] =
    useState<PlannerLineColorMode | null>("quality");
  // `quality` is the DEFAULT line colouring, so an operator kill has to reach
  // it or the killed feature stays painted across every routed trip. It
  // collapses to `null` (the neutral route colour that already exists for
  // "no colouring"), never to `surface` — that is a different overlay behind a
  // different switch, and silently moving the rider onto it would show them
  // data they did not ask for. The choice is kept, so restoring the switch
  // puts the quality colouring back.
  const lineColorMode =
    lineColorModeChoice === "quality" && !qualityOverlayEnabled
      ? null
      : lineColorModeChoice;
  const [basemap, setBasemap] = useState<"map" | "aerial">("map");
  // `sys_aerial_basemap` operator kill switch (ČÚZK WMTS outage): when off, hide
  // the toggle and force the base map to "map" even if `basemap` was left on
  // "aerial", so the raster never renders. Re-enabling restores the choice.
  const { enabled: aerialBasemapEnabled } =
    useSystemSwitch("sys_aerial_basemap");
  const effectiveBasemap = aerialBasemapEnabled ? basemap : "map";
  const [drawMode, setDrawMode] = useState<RegionDrawMode>("idle");
  // Ephemeral how-to hints (rider feedback): each hint lives exactly as
  // long as the action it describes is still pending, then it's gone.
  // Placement hint: only until THIS trip gets its first point — placing
  // one latches the hint off even if every point is removed again.
  const [pointPlacedForTrip, setPointPlacedForTrip] = useState(false);
  // Outline hint: only from entering draw mode until the drag begins.
  const [outlineStarted, setOutlineStarted] = useState(false);
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

  // Reroute around an ambient condition (revision 7) — the ONLY marker
  // reroute entry point; the tab cards call the same store path via the
  // page. The page arms an animated fit through onRerouteRequested.
  const handleConditionReroute = useCallback(
    (menu: NonNullable<typeof conditionMenu>) => {
      const target =
        menu.kind === "closure"
          ? {
              id: menu.closure.id,
              location: {
                lng: menu.closure.geometry[0]?.lng ?? menu.lng,
                lat: menu.closure.geometry[0]?.lat ?? menu.lat,
              },
              line: menu.closure.geometry,
            }
          : {
              id: menu.pass.id,
              location: { lng: menu.pass.lng, lat: menu.pass.lat },
            };
      const done = rerouteAroundConditionInTrip(
        useTripStore.getState().activeTrip,
        target,
        insertWaypointBefore,
      );
      if (done) onRerouteRequested?.();
      setConditionMenu(null);
    },
    [insertWaypointBefore, onRerouteRequested],
  );
  // Address search (revision 4 §D, revised by rider feedback): picking a
  // result never places anything — it flies the map to the address and
  // opens the SAME placement menu as a right-click there, so the rider
  // chooses start / via / finish deliberately. The menu is anchored to
  // the coordinate and keeps tracking it through the flight. On a
  // read-only map (trip preview) the search only finds and focuses —
  // there is nothing to place, so no menu opens.
  const handleSearchResult = useCallback(
    (result: GeoResult) => {
      const map = handleRef.current?.map;
      if (!map) return;
      setPoiMenu(null);
      setWaypointMenu(null);
      // The read-only preview never opens `contextMenu`, so the mutual-exclusion
      // effect wouldn't clear an open basemap place card — do it directly.
      setPlaceMenu(null);
      const coords = { lng: result.lng, lat: result.lat };
      if (editable) {
        const rect = map.getCanvas()?.getBoundingClientRect?.();
        const projected =
          typeof map.project === "function"
            ? map.project([coords.lng, coords.lat])
            : null;
        setContextMenu({
          x:
            rect && projected
              ? rect.left + projected.x + 10
              : (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
          y:
            rect && projected
              ? rect.top + projected.y + 10
              : (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
          coords,
        });
      }
      if (typeof map.flyTo === "function") {
        map.flyTo({
          center: [coords.lng, coords.lat],
          zoom: Math.max(map.getZoom?.() ?? 0, 11),
          duration: 1200,
          essential: true,
        });
      }
    },
    [editable],
  );
  // POI pin -> start/finish: the placement rule engine handles the role
  // juggling; the meta names the point and carries the glyph category.
  const handlePlacePoiEndpoint = useCallback(
    (poi: Poi, endpoint: "start" | "end") => {
      const store = useTripStore.getState();
      const action =
        endpoint === "start"
          ? hasStart
            ? "set-new-start"
            : "set-start"
          : hasEnd
            ? "set-new-end"
            : "set-end";
      const name = poi.name.trim();
      store.placeWaypoint(
        { lat: poi.lat, lng: poi.lng },
        action,
        store.draftPlannerParameters ?? undefined,
        {
          ...(name ? { name } : {}),
          poiCategory: poi.category,
        },
      );
      setPoiMenu(null);
    },
    [hasStart, hasEnd],
  );
  // POI pin -> waypoint (revision 4 §E): a plain ordered-list insert, so it
  // works with only start+finish placed (no computed route required) and
  // the result is a normal draggable/removable waypoint.
  const handleAddPoiWaypoint = useCallback(
    (poi: Poi, type: Waypoint["type"]) => {
      const store = useTripStore.getState();
      // The popover also opens from the route-wide STOPS list, whose
      // stops can sit on ANY day of a multi-day trip — insert into the
      // day whose route passes the POI, AT its along-route position (an
      // early-route stop appended before the finish would make the next
      // reroute backtrack through every later via). Pre-route (no
      // geometry anywhere) falls back to appending on the selected day.
      const owningDay = nearestDayIndexToPoint(trip, {
        lat: poi.lat,
        lng: poi.lng,
      });
      const dayIndex = owningDay >= 0 ? owningDay : store.selectedDayIndex;
      const day = trip?.days[dayIndex];
      const anchorId = day
        ? insertionAnchorForPoint(day, { lat: poi.lat, lng: poi.lng })
        : null;
      const name = poi.name.trim();
      store.insertWaypointBefore(dayIndex, anchorId, {
        id: `poi-${poi.id}-${Date.now()}`,
        ...(name ? { name } : {}),
        location: { lat: poi.lat, lng: poi.lng },
        type,
        poiCategory: poi.category,
      });
      setPoiMenu(null);
    },
    [trip],
  );
  // A basemap (OSM) place has no curated PoiCategory — otherwise these mirror
  // the POI placement handlers, inserting a plain named waypoint.
  const handleAddPlaceWaypoint = useCallback(
    (place: BasemapPlace, type: Waypoint["type"]) => {
      const store = useTripStore.getState();
      const owningDay = nearestDayIndexToPoint(trip, {
        lat: place.lat,
        lng: place.lng,
      });
      const dayIndex = owningDay >= 0 ? owningDay : store.selectedDayIndex;
      const day = trip?.days[dayIndex];
      const anchorId = day
        ? insertionAnchorForPoint(day, { lat: place.lat, lng: place.lng })
        : null;
      store.insertWaypointBefore(dayIndex, anchorId, {
        id: `place-${place.lng},${place.lat}-${Date.now()}`,
        // Unnamed POIs carry an empty name — fall back to the localized
        // category so the saved waypoint isn't blank and matches the card.
        name: place.name || basemapPlaceCategoryDisplay(place, t),
        ...(place.name ? { nameIsSource: true } : {}),
        location: { lat: place.lat, lng: place.lng },
        type,
      });
      setPlaceMenu(null);
    },
    [trip, t],
  );
  const handlePlacePlaceEndpoint = useCallback(
    (place: BasemapPlace, endpoint: "start" | "end") => {
      const store = useTripStore.getState();
      const action =
        endpoint === "start"
          ? hasStart
            ? "set-new-start"
            : "set-start"
          : hasEnd
            ? "set-new-end"
            : "set-end";
      store.placeWaypoint(
        { lat: place.lat, lng: place.lng },
        action,
        store.draftPlannerParameters ?? undefined,
        { name: place.name || basemapPlaceCategoryDisplay(place, t) },
      );
      setPlaceMenu(null);
    },
    [hasStart, hasEnd, t],
  );
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
  const routeOverviewCollection = useMemo(
    () =>
      buildPlannerRouteOverviewCollection(
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
        t,
      ),
    [trip, selectedDayNumber, focusSelectedDay, t],
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
  const affectsClosureIds = useMemo(
    () => new Set(closuresData.routeClosures.map((closure) => closure.id)),
    [closuresData.routeClosures],
  );
  const affectsPassIds = useMemo(
    () =>
      new Set(
        passesData.routePasses
          .filter((pass) => pass.status !== "open")
          .map((pass) => pass.id),
      ),
    [passesData.routePasses],
  );
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setConditionLayersVisible(map, conditionsVisible);
    if (!conditionsVisible) setConditionMenu(null);
  }, [conditionsVisible, ready]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setHazardLayersVisible(map, hazardsVisible);
    if (!hazardsVisible) setHazardMenu(null);
  }, [hazardsVisible, ready]);
  // Only one point popover at a time. The hazard click clears the other menus
  // when it opens; this is the reverse — close the hazard popover whenever any
  // other point menu opens. Those handlers set `swallowNextClickRef`, so the
  // map-level close-all is skipped and wouldn't otherwise clear it.
  useEffect(() => {
    if (poiMenu || waypointMenu || contextMenu || conditionMenu) {
      setHazardMenu(null);
    }
  }, [poiMenu, waypointMenu, contextMenu, conditionMenu]);
  // Likewise close the basemap-place popover when any other point menu opens
  // (the place click handler clears the others directly when it opens).
  useEffect(() => {
    if (poiMenu || waypointMenu || contextMenu || conditionMenu || hazardMenu) {
      setPlaceMenu(null);
    }
  }, [poiMenu, waypointMenu, contextMenu, conditionMenu, hazardMenu]);
  // REST-only viewport hazard feed (no websocket — ambient awareness only).
  useViewportHazards(handleRef, {
    enabled: hazardsVisible && ready,
    viewportToken: hazardViewportToken,
  });
  // Refetch hazards on pan/zoom whenever they're enabled — independent of the
  // POI-browsing gate so read-only preview maps stay fresh too.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !hazardsVisible) return;
    const onMoveEnd = () => setHazardViewportToken((token) => token + 1);
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [ready, hazardsVisible]);
  useEffect(() => {
    conditionsRef.current = {
      closures,
      passes,
      affectsClosureIds,
      affectsPassIds,
    };
  }, [closures, passes, affectsClosureIds, affectsPassIds]);
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
    closePoiMenu();
    closeConditionMenu();
    closeHazardMenu();
    closePlaceMenu();
  }, [
    closeContextMenu,
    closeWaypointMenu,
    closePoiMenu,
    closeConditionMenu,
    closeHazardMenu,
    closePlaceMenu,
  ]);
  const updateDrawnRegion = useCallback(
    (bbox: RegionDrawBbox | null) => {
      setDrawnRegion(bbox);
      onDrawnRegionChange?.(bbox);
    },
    [onDrawnRegionChange],
  );
  const handleReady = (map: MapLibreMap) => {
    ensurePlannerLayers(map, t);
    installFunZoneLayer(map);
    // Basemap (OpenStreetMap) POIs — the style's own icons, below all our
    // markers. Discovered from the live style so an env style override works.
    const basemapPoiLayers = getBasemapPoiLayerIds(map);
    // A NAMED basemap POI under the cursor (visible on both basemaps — the
    // aerial raster sits below the labels/POIs). Route + drawer yield to it.
    const overBasemapPlace = (event: MapLayerMouseEvent) =>
      topBasemapPlaceAt(map, event.point, basemapPoiLayers) != null;
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
      // A waypoint, hazard pin, or named basemap POI sitting on the route owns
      // the click — don't also select the segment / open Road Preview under it.
      const overOwnedPin = [WAYPOINT_PIN, HAZARD_BG, HAZARD_CLUSTERS]
        .filter((id) => map.getLayer(id))
        .some(
          (id) =>
            map.queryRenderedFeatures(event.point, { layers: [id] }).length > 0,
        );
      if (overOwnedPin || overBasemapPlace(event)) return;
      const segmentId = event.features?.[0]?.properties?.segmentId as
        | string
        | undefined;
      if (!segmentId) return;
      useTripStore.getState().selectPlannerSegment(segmentId);
    });
    // ── Off-route mapped-segment click → shared detail drawer. The route line,
    // waypoints, and POI pins own their own clicks (checked first), so this
    // only fires on the ambient quality/surface tile overlay away from the
    // route. Placement is right-click / long-press, so a plain left-click here
    // never competes with adding a waypoint.
    map.on("click", (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const openDrawer = onOpenSegmentDetailRef.current;
      if (!openDrawer) return;
      const blockingLayers = [
        ROUTE_HIT_LINE,
        WAYPOINT_PIN,
        POI_PIN_LAYER,
        // Hazard pins/clusters sit over the road layers and own their own
        // click — don't also open the segment drawer underneath.
        HAZARD_BG,
        HAZARD_CLUSTERS,
      ].filter((id) => map.getLayer(id));
      if (
        (blockingLayers.length > 0 &&
          map.queryRenderedFeatures(event.point, { layers: blockingLayers })
            .length > 0) ||
        overBasemapPlace(event)
      ) {
        return;
      }
      // The hit layer is UNCAPPED for waypoint snapping, but opening the detail
      // drawer (road-QUALITY intelligence) is entitlement-gated: a capped rider
      // zoomed past the resolved cap — where the overlay is hidden — must not
      // pull the exact quality score/provenance/history. Below the cap it opens
      // as before; past it, tap-for-detail is suppressed (snapping is a separate
      // handler and stays uncapped).
      if (map.getZoom() >= qualityMaxZoomRef.current) return;
      const overlayLayers = [
        TARMOTO_ROAD_HIT_LAYER,
        TARMOTO_SURFACE_LAYER,
      ].filter((id) => map.getLayer(id));
      if (overlayLayers.length === 0) return;
      const feature = pickNearestLineFeature(
        map,
        event.point,
        overlayLayers,
        SEGMENT_HIT_PADDING_PX,
      );
      const segmentId = readSegmentId(feature);
      if (segmentId) openDrawer(segmentId);
    });
    // Pointer cursor over the ambient mapped segments (like /explore), so the
    // off-route tap-for-detail affordance is discoverable. Only meaningful when
    // the drawer opener is wired.
    for (const overlay of [TARMOTO_ROAD_HIT_LAYER, TARMOTO_SURFACE_LAYER]) {
      map.on("mouseenter", overlay, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        if (!onOpenSegmentDetailRef.current) return;
        // No tap-for-detail affordance past the cap (see the click handler).
        if (map.getZoom() >= qualityMaxZoomRef.current) return;
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", overlay, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "";
      });
    }
    ensurePoiLayers(map);
    map.on("mouseenter", POI_PIN_LAYER, () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", POI_PIN_LAYER, () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "";
    });
    map.on("click", POI_PIN_LAYER, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const props = event.features?.[0]?.properties as
        | { poiId?: string }
        | undefined;
      const poi = props?.poiId ? poisByIdRef.current.get(props.poiId) : null;
      if (!poi) return;
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      setPoiMenu({
        poi,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
    });
    // A POI placed as a waypoint keeps its popover: clicking the role
    // circle reopens the POI card (info + remove) instead of doing
    // nothing. Non-POI waypoints keep their existing behavior.
    map.on("click", WAYPOINT_PIN, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const feature = event.features?.[0];
      const props = feature?.properties as
        | { waypointId?: string; poiCategory?: PoiCategory; label?: string }
        | undefined;
      if (!props?.waypointId) return;
      const [lng, lat] =
        feature?.geometry.type === "Point"
          ? (feature.geometry.coordinates as [number, number])
          : [event.lngLat.lng, event.lngLat.lat];
      if (!props.poiCategory) {
        // Plain waypoint: left-click opens the same point dialog as
        // right-click (rider feedback).
        swallowNextClickRef.current = true;
        openWaypointMenuFromFeature(
          props,
          lng,
          lat,
          event.originalEvent.clientX,
          event.originalEvent.clientY,
        );
        return;
      }
      // Waypoint ids from POIs are poi-<poiId>-<timestamp>; the source
      // mapping mirrors the resolver (§B).
      const poiId =
        /^poi-(.*)-\d+$/.exec(props.waypointId)?.[1] ?? props.waypointId;
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      // Prefer the original POI (still in the by-id lookup after placement)
      // so its `meta.mapsUrl` — and the Maps link that depends on it —
      // survives; the waypoint-pin properties carry no meta, so a placed
      // contactless POI would otherwise lose its only detail link. VIA
      // placements encode the poi id in the waypoint id; "Set as
      // start/finish" keeps the planner endpoint id, so fall back to
      // matching the placement coordinates (as `usedPois` does).
      const originalPoi =
        poisByIdRef.current.get(poiId) ??
        [...poisByIdRef.current.values()].find(
          (candidate) =>
            candidate.lng === lng &&
            candidate.lat === lat &&
            candidate.category === props.poiCategory,
        );
      setPoiMenu({
        poi: originalPoi ?? {
          id: poiId,
          category: props.poiCategory,
          source:
            props.poiCategory === "mountain_pass"
              ? "passes"
              : props.poiCategory === "twisty_highlight"
                ? "tarmoto"
                : "osm",
          name: props.label ?? t("Waypoint"),
          lat,
          lng,
        },
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
        placedWaypointId: props.waypointId,
      });
    });
    // Ambient condition markers (revision 7): click -> popover with the
    // condition's detail; the reroute action appears ONLY here (and on
    // the on-route tab cards that reuse this popover).
    map.on("click", CLOSURE_MARKER_LAYER, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const id = event.features?.[0]?.properties?.id as string | undefined;
      const closure = id
        ? conditionsRef.current.closures.find((c) => c.id === id)
        : undefined;
      if (!closure) return;
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      setPoiMenu(null);
      const anchor = closure.geometry[0];
      setConditionMenu({
        kind: "closure",
        closure,
        affectsRoute: conditionsRef.current.affectsClosureIds.has(closure.id),
        lng: anchor?.lng ?? event.lngLat.lng,
        lat: anchor?.lat ?? event.lngLat.lat,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
    });
    map.on("click", PASS_MARKER_LAYER, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const id = event.features?.[0]?.properties?.id as string | undefined;
      const pass = id
        ? conditionsRef.current.passes.find((p) => p.id === id)
        : undefined;
      if (!pass) return;
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      setPoiMenu(null);
      setConditionMenu({
        kind: "pass",
        pass,
        affectsRoute: conditionsRef.current.affectsPassIds.has(pass.id),
        lng: pass.lng,
        lat: pass.lat,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
    });
    for (const layer of [CLOSURE_MARKER_LAYER, PASS_MARKER_LAYER]) {
      map.on("mouseenter", layer, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "";
      });
    }
    // ── Ambient hazard pins (opt-in) → shared point popover ──
    ensureHazardLayers(map, { visible: false, beforeId: WAYPOINT_PIN });
    // Waypoints, condition markers, and day-break splitter dots all sit ABOVE
    // the hazard layer (hazards are inserted before WAYPOINT_PIN; day-breaks
    // are added on top). If a click also hit one of those, it owns the click —
    // the hazard pin/cluster must not clobber it or zoom the map. Day-breaks
    // arm on `mousedown`, so an overlapping hazard `click` would otherwise fire
    // alongside the splitter.
    const overHigherPriorityMarker = (event: MapLayerMouseEvent) => {
      const layers = [
        WAYPOINT_PIN,
        CLOSURE_MARKER_LAYER,
        PASS_MARKER_LAYER,
        DAY_BREAK_CIRCLE_LAYER,
      ].filter((id) => map.getLayer(id));
      return (
        layers.length > 0 &&
        map.queryRenderedFeatures(event.point, { layers }).length > 0
      );
    };
    const onHazardClick = (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      if (overHigherPriorityMarker(event)) return;
      const feature = event.features?.[0];
      const props = feature?.properties as HazardProps | null;
      if (
        !feature ||
        !props?.hazard_type ||
        feature.geometry.type !== "Point"
      ) {
        return;
      }
      const [lng, lat] = feature.geometry.coordinates as [number, number];
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      setPoiMenu(null);
      setConditionMenu(null);
      setHazardMenu({
        hazard: props,
        lng,
        lat,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
    };
    map.on("click", HAZARD_BG, onHazardClick);
    map.on("click", HAZARD_CLUSTERS, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      if (overHigherPriorityMarker(event)) return;
      const feature = event.features?.[0];
      if (feature) expandHazardCluster(map, feature);
    });
    // Hazards sit ABOVE the POI clusters (POI layers are added first, hazards
    // slot in before WAYPOINT_PIN). A visible hazard pin/cluster owns an
    // overlapping click — the POI cluster handler below must not also expand
    // and fly the camera underneath it.
    const overHazardMarker = (event: MapLayerMouseEvent) => {
      const layers = [HAZARD_BG, HAZARD_CLUSTERS].filter((id) =>
        map.getLayer(id),
      );
      return (
        layers.length > 0 &&
        map.queryRenderedFeatures(event.point, { layers }).length > 0
      );
    };
    for (const layer of [HAZARD_BG, HAZARD_CLUSTERS]) {
      map.on("mouseenter", layer, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "";
      });
    }
    // ── Basemap (OpenStreetMap) POIs → shared place popover (lowest priority) ──
    // Yields to every one of our markers under the cursor; wins over the route
    // line + off-route drawer (which now defer to `overBasemapPlace`). Only a
    // NAMED POI opens a card. Works on both basemaps — the aerial raster is
    // slotted below the labels/POIs so they stay visible + clickable.
    const onBasemapPoiClick = (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      const ownLayers = [
        WAYPOINT_PIN,
        CLOSURE_MARKER_LAYER,
        PASS_MARKER_LAYER,
        DAY_BREAK_CIRCLE_LAYER,
        HAZARD_BG,
        HAZARD_CLUSTERS,
        POI_PIN_LAYER,
        POI_CLUSTER_LAYER,
        FUN_ZONES_FILL,
      ].filter((id) => map.getLayer(id));
      if (
        ownLayers.length > 0 &&
        map.queryRenderedFeatures(event.point, { layers: ownLayers }).length > 0
      ) {
        return;
      }
      // Scan every hit (not just the first) for a NAMED place — an unnamed OSM
      // point can render above a named one in the same layer, and the route /
      // drawer guards already defer to `topBasemapPlaceAt`, so bailing on the
      // first unnamed hit would leave the click dead.
      let place: BasemapPlace | null = null;
      for (const feature of event.features ?? []) {
        place = readBasemapPlace(feature);
        if (place) break;
      }
      if (!place) return;
      swallowNextClickRef.current = true;
      setContextMenu(null);
      setWaypointMenu(null);
      setPoiMenu(null);
      setConditionMenu(null);
      setHazardMenu(null);
      setPlaceMenu({
        place,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
    };
    for (const id of basemapPoiLayers) {
      map.on("click", id, onBasemapPoiClick);
      map.on("mouseenter", id, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", id, () => {
        if (drawRef.current?.getMode() !== "idle") return;
        map.getCanvas().style.cursor = "";
      });
    }
    // Cluster click zooms toward the cluster's expansion level.
    map.on("click", POI_CLUSTER_LAYER, (event: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      if (overHazardMarker(event)) return;
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.cluster_id as number | undefined;
      const source = map.getSource(POI_SOURCE) as
        | (GeoJSONSource & {
            getClusterExpansionZoom?: (id: number) => Promise<number>;
          })
        | undefined;
      if (clusterId === undefined || !source?.getClusterExpansionZoom) return;
      swallowNextClickRef.current = true;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({
          center: event.lngLat,
          zoom,
          duration: 600,
        });
      });
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
    syncGeoJsonSource(map, ROUTE_OVERVIEW_SOURCE, routeOverviewCollection);
    syncGeoJsonSource(map, WAYPOINT_SOURCE, waypointCollection);
    syncGeoJsonSource(map, CLOSURE_LINE_SOURCE, closureLineCollection);
    syncGeoJsonSource(map, CLOSURE_MARKER_SOURCE, closureMarkerCollection);
    syncGeoJsonSource(map, PASS_MARKER_SOURCE, passMarkerCollection);
    syncGeoJsonSource(map, DAY_BREAK_SOURCE, dayBreakCollection);
    syncGeoJsonSource(
      map,
      SEGMENT_HIGHLIGHT_SOURCE,
      segmentHighlightCollection,
    );
  }, [
    closureLineCollection,
    closureMarkerCollection,
    dayBreakCollection,
    passMarkerCollection,
    ready,
    routeCollection,
    routeOverviewCollection,
    segmentHighlightCollection,
    waypointCollection,
  ]);
  // ── Collaborator cursor avatars (US-35) ──
  // Rendered as HTML markers (not a GeoJSON layer) so each cursor shows the
  // rider's avatar — photo or initials — via the shared `UserAvatar`. Markers
  // are keyed by user id; one that drops out of `collaboratorCursors` (TTL
  // sweep / disconnect) is removed.
  const cursorMarkersRef = useRef<Map<string, { marker: Marker; root: Root }>>(
    new Map(),
  );
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    const markers = cursorMarkersRef.current;
    const seen = new Set<string>();
    for (const cursor of collaboratorCursors?.values() ?? []) {
      seen.add(cursor.userId);
      const profile = collaboratorProfiles?.get(cursor.userId);
      const name = profile?.displayName ?? t("Rider");
      const avatarUrl = profile?.avatarUrl ?? null;
      let entry = markers.get(cursor.userId);
      if (!entry) {
        const el = document.createElement("div");
        // Non-interactive so a cursor avatar never intercepts map clicks/hover.
        el.style.pointerEvents = "none";
        const root = createRoot(el);
        const marker = new Marker({ element: el })
          .setLngLat([cursor.lng, cursor.lat])
          .addTo(map);
        entry = { marker, root };
        markers.set(cursor.userId, entry);
      } else {
        entry.marker.setLngLat([cursor.lng, cursor.lat]);
      }
      entry.root.render(
        <UserAvatar
          name={name}
          avatarUrl={avatarUrl}
          size={30}
          className="ring-2 ring-[#F5EFE6] shadow-[0_2px_6px_rgba(14,14,16,0.35)]"
        />,
      );
    }
    for (const [userId, entry] of markers) {
      if (!seen.has(userId)) {
        entry.root.unmount();
        entry.marker.remove();
        markers.delete(userId);
      }
    }
  }, [t, collaboratorCursors, collaboratorProfiles, ready]);
  useEffect(() => {
    const markers = cursorMarkersRef.current;
    return () => {
      for (const entry of markers.values()) {
        entry.root.unmount();
        entry.marker.remove();
      }
      markers.clear();
    };
  }, []);
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
    if (!map || !ready) return;
    if (map.getLayer(ROUTE_LINE)) {
      map.setPaintProperty(
        ROUTE_LINE,
        "line-color",
        lineColorMode
          ? plannerRouteLineColor(lineColorMode, SURFACE_COLORS)
          : NEUTRAL_ROUTE_LINE_COLOR,
      );
    }
    if (map.getLayer(ROUTE_OVERVIEW_LINE)) {
      map.setPaintProperty(
        ROUTE_OVERVIEW_LINE,
        "line-color",
        lineColorMode ? ROUTE_OVERVIEW_LINE_COLOR : NEUTRAL_ROUTE_LINE_COLOR,
      );
    }
  }, [lineColorMode, ready]);
  // Basemap toggle — swaps the imagery UNDER the route line; the quality
  // line and every planner overlay stay drawn on top.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setAerialBasemapVisible(map, effectiveBasemap === "aerial");
  }, [effectiveBasemap, ready]);
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
  const waypointCount = useMemo(
    () => trip?.days.reduce((sum, day) => sum + day.waypoints.length, 0) ?? 0,
    [trip],
  );
  const hintTripId = trip?.id ?? null;
  useEffect(() => {
    setPointPlacedForTrip(false);
  }, [hintTripId]);
  useEffect(() => {
    if (waypointCount > 0) setPointPlacedForTrip(true);
  }, [waypointCount]);
  useEffect(() => {
    if (drawMode !== "drawing") {
      setOutlineStarted(false);
      return;
    }
    const map = handleRef.current?.map;
    if (!map) return;
    const onOutlineBegin = () => setOutlineStarted(true);
    map.on("mousedown", onOutlineBegin);
    map.on("touchstart", onOutlineBegin);
    return () => {
      map.off("mousedown", onOutlineBegin);
      map.off("touchstart", onOutlineBegin);
    };
  }, [drawMode]);
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
  // ── Category POIs (revision 4 §C): refetch on viewport + filter change ──
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !poiBrowsing) return;
    const onMoveEnd = () => setPoiViewportToken((token) => token + 1);
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [ready, poiBrowsing]);
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !poiBrowsing) return;
    const categories = [...activePoiCategories];
    const applyPois = (fetched: Poi[]) => {
      const pois = fetched.filter(
        (poi) =>
          !usedPois.ids.has(poi.id) &&
          !usedPois.spots.has(`${poi.lng},${poi.lat}`),
      );
      // Keep the FULL fetched set in the by-id lookup — not the
      // placement-filtered `pois` — so a POI placed as a waypoint (dropped
      // from the pin layer) can still be resolved with its `meta.mapsUrl`
      // when its waypoint popover reopens.
      const nextPoiLookup = new Map(fetched.map((poi) => [poi.id, poi]));
      // A placed POI can fall out of a later viewport/category fetch (pan
      // away, or the category toggled off → applyPois([])). Retain any
      // still-placed POI so its waypoint popover keeps resolving the
      // original POI — and its maps_url — instead of a meta-less fallback.
      for (const poi of poisByIdRef.current.values()) {
        if (
          !nextPoiLookup.has(poi.id) &&
          (usedPois.ids.has(poi.id) ||
            usedPois.spots.has(`${poi.lng},${poi.lat}`))
        ) {
          nextPoiLookup.set(poi.id, poi);
        }
      }
      poisByIdRef.current = nextPoiLookup;
      const source = map.getSource(POI_SOURCE) as GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: pois.map((poi) => ({
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [poi.lng, poi.lat],
          },
          properties: {
            poiId: poi.id,
            category: poi.category,
            name: poi.name,
            source: poi.source,
          },
        })),
      });
      // Latch the Foursquare map-bar credit on the first time FSQ POIs appear
      // (#869) — checked against the full fetched set, not the placement-
      // filtered `pois`, so a placed-away FSQ pin still counts.
      if (!sawFsqRef.current && fetched.some((poi) => poi.source === "fsq")) {
        sawFsqRef.current = true;
        handleRef.current?.setPoiAttribution([FSQ_ATTRIBUTION]);
      }
    };
    if (categories.length === 0) {
      applyPois([]);
      setPoiMenu(null);
      return;
    }
    // jsdom's map mock has no getBounds — the layer simply stays empty.
    if (typeof map.getBounds !== "function") return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const bounds = map.getBounds();
        const bbox: [number, number, number, number] = [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ];
        const pois = await plannerApi.getPoisByCategories(
          bbox,
          categories,
          month,
          { signal: controller.signal },
        );
        if (!cancelled) applyPois(pois);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        console.warn("[planner] category poi fetch failed", err);
      }
    }, POI_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    activePoiCategories,
    poiViewportToken,
    ready,
    poiBrowsing,
    usedPois,
    month,
  ]);
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
  // Cancels the previous reverse-geocode so a slow response for an earlier
  // menu can't overwrite a newer one's address (real backend round-trip).
  const reverseAddressCtrlRef = useRef<AbortController | null>(null);
  // Shared opener for the waypoint point dialog — reached by right-click
  // AND left-click on a pin (rider feedback). Everything it touches is
  // referentially stable, so ready-time closures may capture it.
  const openWaypointMenuFromFeature = useCallback(
    (
      props: { waypointId?: string; label?: string; waypointType?: string },
      lng: number,
      lat: number,
      clientX: number,
      clientY: number,
    ) => {
      if (!props.waypointId) return;
      const waypointId = props.waypointId;
      setContextMenu(null);
      setPoiMenu(null);
      setWaypointMenu({
        waypointId,
        name: props.label ?? t("Waypoint"),
        role:
          props.waypointType === "end"
            ? "finish"
            : (props.waypointType ?? "via"),
        lng,
        lat,
        x: clientX,
        y: clientY,
        address: null,
      });
      // Resolve the place name lazily; keep the menu snappy meanwhile. Abort
      // any prior lookup so its late response can't overwrite this menu.
      reverseAddressCtrlRef.current?.abort();
      const controller = new AbortController();
      reverseAddressCtrlRef.current = controller;
      void plannerApi
        .reverseGeocode(lat, lng, { signal: controller.signal, format })
        .then((address) => {
          if (controller.signal.aborted) return;
          setWaypointMenu((menu) =>
            menu && menu.waypointId === waypointId
              ? { ...menu, address }
              : menu,
          );
        })
        .catch(() => {
          // Address is informational — coordinates already show.
        });
    },
    [t, format],
  );
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
      openWaypointMenuFromFeature(
        props,
        lng,
        lat,
        event.originalEvent.clientX,
        event.originalEvent.clientY,
      );
    };
    map.on("contextmenu", onPinContextMenu);
    return () => {
      map.off("contextmenu", onPinContextMenu);
    };
  }, [ready, editable, openWaypointMenuFromFeature]);
  // ── Dialogs follow their point while the map moves (rider feedback):
  // every open menu is anchored to a geo coordinate and reprojected on
  // each map move instead of staying frozen at the click position. ──
  const anyMapMenuOpen = Boolean(
    poiMenu ||
    waypointMenu ||
    contextMenu ||
    conditionMenu ||
    hazardMenu ||
    placeMenu,
  );
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !anyMapMenuOpen) return;
    // jsdom's map mock projects nothing — menus just keep their spot.
    if (typeof map.project !== "function") return;
    const reposition = () => {
      const rect = map.getCanvas()?.getBoundingClientRect?.();
      if (!rect) return;
      const toScreen = (lng: number, lat: number) => {
        const point = map.project([lng, lat]);
        return { x: rect.left + point.x + 10, y: rect.top + point.y + 10 };
      };
      setPoiMenu((menu) =>
        menu ? { ...menu, ...toScreen(menu.poi.lng, menu.poi.lat) } : menu,
      );
      setWaypointMenu((menu) =>
        menu ? { ...menu, ...toScreen(menu.lng, menu.lat) } : menu,
      );
      setContextMenu((menu) =>
        menu
          ? { ...menu, ...toScreen(menu.coords.lng, menu.coords.lat) }
          : menu,
      );
      setConditionMenu((menu) =>
        menu ? { ...menu, ...toScreen(menu.lng, menu.lat) } : menu,
      );
      setHazardMenu((menu) =>
        menu ? { ...menu, ...toScreen(menu.lng, menu.lat) } : menu,
      );
      setPlaceMenu((menu) =>
        menu ? { ...menu, ...toScreen(menu.place.lng, menu.place.lat) } : menu,
      );
    };
    map.on("move", reposition);
    return () => {
      map.off("move", reposition);
    };
  }, [ready, anyMapMenuOpen]);
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
  const fitMapToDay = useCallback(
    (dayNumber: number) => {
      const map = handleRef.current?.map;
      const bounds = getTripPlannerDayBounds(trip, dayNumber);
      if (!map || !bounds) return;
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 72, duration: 1200, essential: true, maxZoom: 12 },
      );
    },
    [trip],
  );
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
      // Same rider courtesy as the INSPECT-card reroute: the page arms
      // an animated fit so the new line comes back into full view.
      onRerouteRequested?.();
      selectPlannerSegment(null);
    },
    [insertWaypointBefore, selectPlannerSegment, onRerouteRequested],
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
      fitDay: fitMapToDay,
      flyToSegment,
      startRegionDraw: () => drawRef.current?.start(),
      cancelRegionDraw: () => drawRef.current?.cancel(),
      openConditionPopover: (ref: { kind: "closure" | "pass"; id: string }) => {
        const map = handleRef.current?.map;
        if (!map) return;
        const current = conditionsRef.current;
        let lng: number | undefined;
        let lat: number | undefined;
        if (ref.kind === "closure") {
          const closure = current.closures.find((c) => c.id === ref.id);
          const anchor = closure?.geometry[0];
          if (!closure || !anchor) return;
          lng = anchor.lng;
          lat = anchor.lat;
          setConditionMenu({
            kind: "closure",
            closure,
            affectsRoute: current.affectsClosureIds.has(closure.id),
            lng,
            lat,
            x: 0,
            y: 0,
          });
        } else {
          const pass = current.passes.find((p) => p.id === ref.id);
          if (!pass) return;
          lng = pass.lng;
          lat = pass.lat;
          setConditionMenu({
            kind: "pass",
            pass,
            affectsRoute: current.affectsPassIds.has(pass.id),
            lng,
            lat,
            x: 0,
            y: 0,
          });
        }
        setContextMenu(null);
        setWaypointMenu(null);
        setPoiMenu(null);
        const rect = map.getCanvas()?.getBoundingClientRect?.();
        const projected =
          typeof map.project === "function" ? map.project([lng, lat]) : null;
        setConditionMenu((menu) =>
          menu
            ? {
                ...menu,
                x:
                  rect && projected
                    ? rect.left + projected.x + 10
                    : (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
                y:
                  rect && projected
                    ? rect.top + projected.y + 10
                    : (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
              }
            : menu,
        );
        if (typeof map.flyTo === "function") {
          map.flyTo({
            center: [lng, lat],
            zoom: Math.max(map.getZoom?.() ?? 0, 9),
            duration: 1200,
            essential: true,
          });
        }
      },
      openPoiPopover: (poi: Poi) => {
        const map = handleRef.current?.map;
        if (!map) return;
        setContextMenu(null);
        setWaypointMenu(null);
        const rect = map.getCanvas()?.getBoundingClientRect?.();
        const projected =
          typeof map.project === "function"
            ? map.project([poi.lng, poi.lat])
            : null;
        setPoiMenu({
          poi,
          x:
            rect && projected
              ? rect.left + projected.x + 10
              : (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
          y:
            rect && projected
              ? rect.top + projected.y + 10
              : (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
        });
        if (typeof map.flyTo === "function") {
          map.flyTo({
            center: [poi.lng, poi.lat],
            zoom: Math.max(map.getZoom?.() ?? 0, 11),
            duration: 1200,
            essential: true,
          });
        }
      },
    }),
    [fitMapToTrip, fitMapToDay, flyToSegment],
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
      showQuality={effectiveBasemap === "map" && lineColorMode === "quality"}
      showSurface={effectiveBasemap === "map" && lineColorMode === "surface"}
      selectedSegmentId={selectedRoadSegmentId ?? null}
      onReady={handleReady}
      // v2 planner renders on a cream basemap (grey roads) regardless of the
      // viewer's scheme, matching the design.
      forceColorScheme="light"
    >
      {/* "What am I searching / placing" cluster (revision 4 §F): address
          search + POI chips own the top edge; the basemap/line-color/draw
          cluster steps down one row to keep the two groups readable. */}
      {poiBrowsing ? <MapToolbar onPlace={handleSearchResult} /> : null}
      <div
        className={`absolute left-3 z-20 flex flex-col gap-2 ${
          poiBrowsing ? "top-[60px]" : "top-3"
        }`}
      >
        {/* Basemap toggle — swaps the map UNDER the line (independent of
            coloring). Hidden while `sys_aerial_basemap` is killed. */}
        {aerialBasemapEnabled && (
          <div
            role="group"
            aria-label={t("Basemap")}
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
                {t(label === "Map" ? "Map" : "Aerial")}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {/* Line-coloring toggle — recolors the route line. */}
          {qualityOverlayEnabled && (
            <button
              type="button"
              aria-pressed={lineColorMode === "quality"}
              aria-label={t("Colour the route line by road quality")}
              onClick={() =>
                setLineColorMode((mode) =>
                  mode === "quality" ? null : "quality",
                )
              }
              className={toggleClassName(lineColorMode === "quality")}
            >
              <Layers3 size={14} />
              {t("Road quality")}
            </button>
          )}
          <button
            type="button"
            aria-pressed={lineColorMode === "surface"}
            aria-label={t("Colour the route line by surface")}
            onClick={() =>
              setLineColorMode((mode) =>
                mode === "surface" ? null : "surface",
              )
            }
            className={toggleClassName(lineColorMode === "surface")}
          >
            <Layers3 size={14} />
            {t("Surface")}
          </button>
          {/* Ambient point overlays — a distinct set of layer toggles,
              independent of basemap and line coloring. Ordered Hazards then
              Conditions to match the road explorer's toggle row. */}
          {hazardAlertsEnabled && (
            <button
              type="button"
              aria-pressed={hazardsVisible}
              aria-label={t("Toggle the hazards overlay")}
              onClick={() => setHazardsVisible((visible) => !visible)}
              className={toggleClassName(hazardsVisible)}
            >
              <Siren size={14} />
              {t("Hazards")}
            </button>
          )}
          <button
            type="button"
            aria-pressed={conditionsVisible}
            aria-label={t("Toggle the conditions overlay")}
            onClick={() => setConditionsVisible((visible) => !visible)}
            className={toggleClassName(conditionsVisible)}
          >
            <TriangleAlert size={14} />
            {t("Conditions")}
          </button>
        </div>

        {drawMode === "drawing" && !outlineStarted ? (
          <div className="max-w-[320px] self-start rounded-[10px] bg-ink px-3 py-2 text-xs leading-relaxed text-cream/90 shadow-[0_4px_12px_rgba(14,14,16,0.16)]">
            {t(
              "Click and drag on the map to outline a region. Release to finish.",
            )}
          </div>
        ) : drawMode === "idle" && editable && !pointPlacedForTrip ? (
          <div className="max-w-[320px] self-start rounded-[10px] bg-ink px-3 py-2 text-xs leading-relaxed text-cream/90 shadow-[0_4px_12px_rgba(14,14,16,0.16)]">
            {t(
              "Click the map to add points. We snap to nearby roads when visible.",
            )}
          </div>
        ) : null}
      </div>

      {/* ── Unified map legend (shared with the explorer + preview) ── */}
      <MapLegend
        {...(lineColorMode === "quality" && routeCollection.features.length > 0
          ? { quality: PLANNER_QUALITY_LEGEND }
          : {})}
        surface={
          lineColorMode === "surface" && routeCollection.features.length > 0
        }
        conditions={conditionsVisible}
        hazards={hazardsVisible}
      />
      {/* ── Road Preview Card — opened by clicking any route section ── */}
      {previewSegment ? (
        <RoadPreviewPopover
          segment={previewSegment}
          onClose={() => selectPlannerSegment(null)}
          {...(editable ? { onReroute: handleReroute } : {})}
          {...(onOpenSegmentDetail
            ? {
                onOpenFullDetail: (roadSegmentId: string) => {
                  // Close the preview card, then hand off to the shared drawer.
                  selectPlannerSegment(null);
                  onOpenSegmentDetail(roadSegmentId);
                },
              }
            : {})}
        />
      ) : null}
      {/* ── Context menu overlay (Task 10) ── */}
      {conditionMenu ? (
        <MapPointPopover
          point={
            conditionMenu.kind === "closure"
              ? {
                  kind: "closure",
                  closure: conditionMenu.closure,
                  affectsRoute: conditionMenu.affectsRoute,
                }
              : {
                  kind: "pass",
                  pass: conditionMenu.pass,
                  affectsRoute: conditionMenu.affectsRoute,
                }
          }
          x={conditionMenu.x}
          y={conditionMenu.y}
          onClose={closeConditionMenu}
          {...(conditionMenu.affectsRoute && editable
            ? {
                actions: {
                  onReroute: () => handleConditionReroute(conditionMenu),
                },
              }
            : {})}
        />
      ) : null}
      {hazardMenu ? (
        <MapPointPopover
          point={{ kind: "hazard", hazard: hazardMenu.hazard }}
          x={hazardMenu.x}
          y={hazardMenu.y}
          onClose={closeHazardMenu}
        />
      ) : null}
      {poiMenu
        ? (() => {
            const stopType = STOP_TYPE_BY_CATEGORY[poiMenu.poi.category];
            const showAddAsStop =
              stopType !== undefined && planningMode === "multiday";
            const placedId = poiMenu.placedWaypointId;
            // Placed POI → Remove; editable map → add/set actions; otherwise
            // info-only (read-only preview). The shared popover renders the
            // matching buttons, or none.
            const actions: PoiPopoverActions | undefined = placedId
              ? onRemoveWaypoint
                ? {
                    onRemove: () => {
                      onRemoveWaypoint(placedId);
                      closePoiMenu();
                    },
                  }
                : undefined
              : editable
                ? {
                    onAddVia: () => handleAddPoiWaypoint(poiMenu.poi, "via"),
                    onSetStart: () =>
                      handlePlacePoiEndpoint(poiMenu.poi, "start"),
                    onSetFinish: () =>
                      handlePlacePoiEndpoint(poiMenu.poi, "end"),
                    ...(showAddAsStop && stopType
                      ? {
                          onAddStop: () =>
                            handleAddPoiWaypoint(poiMenu.poi, stopType),
                        }
                      : {}),
                  }
                : undefined;
            return (
              <MapPointPopover
                point={{ kind: "poi", poi: poiMenu.poi }}
                x={poiMenu.x}
                y={poiMenu.y}
                onClose={closePoiMenu}
                {...(actions ? { actions: { poi: actions } } : {})}
              />
            );
          })()
        : null}
      {placeMenu
        ? (() => {
            // Editable planner: add the basemap place to the route (info-only
            // otherwise). A place has no PoiCategory, so no "add as stop".
            const actions: PoiPopoverActions | undefined = editable
              ? {
                  onAddVia: () =>
                    handleAddPlaceWaypoint(placeMenu.place, "via"),
                  onSetStart: () =>
                    handlePlacePlaceEndpoint(placeMenu.place, "start"),
                  onSetFinish: () =>
                    handlePlacePlaceEndpoint(placeMenu.place, "end"),
                }
              : undefined;
            return (
              <MapPointPopover
                point={{ kind: "place", place: placeMenu.place }}
                x={placeMenu.x}
                y={placeMenu.y}
                onClose={closePlaceMenu}
                {...(actions ? { actions: { poi: actions } } : {})}
              />
            );
          })()
        : null}
      {waypointMenu ? (
        <div
          role="dialog"
          aria-label={t("Waypoint details")}
          className="fixed z-30 w-60 overflow-hidden rounded-xl border border-line bg-cream shadow-[0_6px_20px_rgba(14,14,16,0.16)]"
          style={{ left: waypointMenu.x, top: waypointMenu.y }}
        >
          <div className="px-3.5 pb-2.5 pt-3">
            <p className="font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {translateKnownLabel(waypointMenu.role, WAYPOINT_ROLE_LABELS, t)}
            </p>
            <p className="mt-0.5 truncate text-[13px] font-bold text-ink">
              {waypointMenu.name || t("Waypoint")}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-snug text-fg-dim">
              {waypointMenu.address ?? t("Looking up the place…")}
            </p>
            <p className="mt-1 font-mono text-[10px] tracking-[0.3px] text-fg-mute">
              {format.decimal(waypointMenu.lat, 5)},{" "}
              {format.decimal(waypointMenu.lng, 5)}
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
        // Snap against the UNCAPPED hit layer so waypoint placement/drag keeps
        // snapping to roads past the free `road_quality_max_zoom` cap.
        layers: [TARMOTO_ROAD_HIT_LAYER, TARMOTO_SURFACE_LAYER],
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
 * Canvas-drawn waypoint circles per role (2× for crisp rendering) — the
 * design's unified pin language: a flat circle whose CENTER is the
 * point, matching the POI pins. Start/via ring in white, the finish
 * rings in ink (accent-on-cream needs the darker ring to read).
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
    const size = 56;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    const center = size / 2;
    ctx.beginPath();
    ctx.arc(center, center, 24, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = ring;
    ctx.stroke();
    const image = ctx.getImageData(0, 0, size, size);
    map.addImage(imageId, image, { pixelRatio: 2 });
  }
}

/**
 * Rasterize the category glyphs into accent-circle pin images (2x for
 * crisp rendering). SVG -> Image is async; MapLibre repaints the symbol
 * layer as each image lands. jsdom never fires Image onload — tests
 * simply render no icons.
 */
function installPoiPinImages(map: MapLibreMap): void {
  for (const [category, children] of Object.entries(POI_PIN_ICON_CHILDREN)) {
    const imageId = `${POI_PIN_IMAGE_PREFIX}${category}`;
    if (map.hasImage?.(imageId)) continue;
    // Unified pin language: cream circle + ink glyph and ring — except
    // twisty highlights, OUR derived layer, which invert to accent.
    const accent = category === "twisty_highlight";
    const fill = accent ? "#FF6A1A" : "#F5EFE6";
    const ring = accent ? "#F5EFE6" : "#0E0E10";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">' +
      `<circle cx="28" cy="28" r="24" fill="${fill}" stroke="${ring}" stroke-width="5"/>` +
      `<g transform="translate(15,15) scale(1.083)" fill="none" stroke="${ring === "#F5EFE6" ? "#F5EFE6" : "#0E0E10"}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">` +
      children +
      "</g></svg>";
    const image = new Image(56, 56);
    image.onload = () => {
      if (!map.hasImage?.(imageId)) {
        map.addImage(imageId, image, { pixelRatio: 2 });
      }
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

/**
 * Role-colored circles WITH the category glyph, for waypoints that were
 * placed from a POI pin — same circle as the plain role pins, same
 * glyph as the POI pins, so a placed viewpoint reads as "a via that is
 * a viewpoint" with a single marker.
 */
function installWaypointPoiPinImages(map: MapLibreMap): void {
  const roles: Array<[string, string, string]> = [
    ["start", "#1F8A5B", "#FFFFFF"],
    ["via", "#1FA6B8", "#FFFFFF"],
    ["end", "#FF6A1A", "#0E0E10"],
  ];
  for (const [role, fill, ring] of roles) {
    for (const [category, children] of Object.entries(POI_PIN_ICON_CHILDREN)) {
      const imageId = `${WAYPOINT_PIN_IMAGE_PREFIX}${role}-${category}`;
      if (map.hasImage?.(imageId)) continue;
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">' +
        `<circle cx="28" cy="28" r="24" fill="${fill}" stroke="${ring}" stroke-width="5"/>` +
        '<g transform="translate(15,15) scale(1.083)" fill="none" stroke="#F5EFE6" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
        children +
        "</g></svg>";
      const image = new Image(56, 56);
      image.onload = () => {
        if (!map.hasImage?.(imageId)) {
          map.addImage(imageId, image, { pixelRatio: 2 });
        }
      };
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
  }
}

/**
 * Clustered category-POI layer (revision 4 §C). Slotted under the
 * waypoint pins so route points always stay on top of browse pins.
 */
function ensurePoiLayers(map: MapLibreMap): void {
  installPoiPinImages(map);
  installWaypointPoiPinImages(map);
  if (!map.getSource(POI_SOURCE)) {
    map.addSource(POI_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 10,
      clusterRadius: 46,
      // ODbL: the browse POIs are OpenStreetMap data, so MapLibre's attribution
      // control credits OSM whenever the POI layer is present (#852). Same exact
      // string as the base-map OSM credit → MapLibre dedupes it to one entry.
      attribution: OSM_ATTRIBUTION,
    });
  }
  const beforeId = map.getLayer(WAYPOINT_PIN) ? WAYPOINT_PIN : undefined;
  if (!map.getLayer(POI_CLUSTER_LAYER)) {
    map.addLayer(
      {
        id: POI_CLUSTER_LAYER,
        type: "circle",
        source: POI_SOURCE,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#FF6A1A",
          "circle-opacity": 0.9,
          "circle-radius": ["step", ["get", "point_count"], 13, 5, 16, 15, 20],
          "circle-stroke-color": "#F5EFE6",
          "circle-stroke-width": 2,
        },
      },
      beforeId,
    );
  }
  if (!map.getLayer(POI_CLUSTER_COUNT_LAYER)) {
    map.addLayer(
      {
        id: POI_CLUSTER_COUNT_LAYER,
        type: "symbol",
        source: POI_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          // Single hosted face — see the waypoint-label note.
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#F5EFE6" },
      },
      beforeId,
    );
  }
  if (!map.getLayer(POI_PIN_LAYER)) {
    map.addLayer(
      {
        id: POI_PIN_LAYER,
        type: "symbol",
        source: POI_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: {
          // Category glyph pins (rider feedback) — the icon says what
          // the POI is before any click.
          "icon-image": ["concat", POI_PIN_IMAGE_PREFIX, ["get", "category"]],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      beforeId,
    );
  }
}

function ensurePlannerLayers(map: MapLibreMap, t: Translate): void {
  // Aerial raster sits under our overlays but ABOVE the base fills/roads and
  // BELOW the base labels + OSM POI icons, so those stay visible over imagery.
  ensureAerialBasemap(map, firstSymbolLayerId(map) ?? TARMOTO_QUALITY_LAYER);
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: "geojson",
      data: buildPlannerQualityRouteCollection(null),
    });
  }
  if (!map.getSource(ROUTE_OVERVIEW_SOURCE)) {
    map.addSource(ROUTE_OVERVIEW_SOURCE, {
      type: "geojson",
      data: buildPlannerRouteOverviewCollection(null),
    });
  }
  // Cream casing under the colored segments so the quality line reads
  // against both the cream basemap and aerial imagery (design frames).
  if (!map.getLayer(ROUTE_CASING_LINE)) {
    map.addLayer({
      id: ROUTE_CASING_LINE,
      type: "line",
      source: ROUTE_OVERVIEW_SOURCE,
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
  // At country scale, thousands of short quality features are smaller than a
  // pixel and MapLibre simplifies them independently, which looks like a
  // dashed route. Draw one continuous accent line until inspection zoom.
  if (!map.getLayer(ROUTE_OVERVIEW_LINE)) {
    map.addLayer({
      id: ROUTE_OVERVIEW_LINE,
      type: "line",
      source: ROUTE_OVERVIEW_SOURCE,
      maxzoom: DETAILED_ROUTE_MIN_ZOOM,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ROUTE_OVERVIEW_LINE_COLOR,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          ["case", ["get", "selected"], 3, 1.5],
          10,
          ["case", ["get", "selected"], 5, 3],
        ],
        "line-opacity": ["case", ["get", "selected"], 1, 0.45],
      },
    });
  }
  if (!map.getLayer(ROUTE_LINE)) {
    map.addLayer({
      id: ROUTE_LINE,
      type: "line",
      source: ROUTE_SOURCE,
      minzoom: DETAILED_ROUTE_MIN_ZOOM,
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
      data: buildTripPlannerWaypointCollection(null, undefined, undefined, t),
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
          "concat",
          WAYPOINT_PIN_IMAGE_PREFIX,
          [
            "match",
            ["get", "waypointType"],
            "start",
            "start",
            "end",
            "end",
            "via",
          ],
          // POI-derived waypoints carry their category -> glyph variant.
          [
            "case",
            ["has", "poiCategory"],
            ["concat", "-", ["get", "poiCategory"]],
            "",
          ],
        ],
        // The image is authored at 2× (pixelRatio 2 → 28 px logical);
        // the circle's CENTER sits exactly on the waypoint location,
        // same anchor rule as the POI pins.
        "icon-size": 1,
        "icon-anchor": "center",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
  // Waypoint pins are intentionally label-free: the geocoded place name is
  // shown on click (the point dialog) rather than crowding the map with a text
  // label on every start/finish/via pin. Day-break/overnight-town labels below
  // are a separate, wanted layer.
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
  ensureConditionLayers(map);
  // ── Collaboration overlays (US-35) ──
  // Collaborator cursors are rendered as avatar HTML markers (not a GeoJSON
  // layer) so each shows the rider's photo/initials — see the cursor-marker
  // effect in the map content component. Suggestions are text-only and live in
  // the collaborate modal; they have no map placement flow, so no map layer.
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
