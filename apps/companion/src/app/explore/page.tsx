"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import {
  getUserFacingErrorMessage,
  type EnglishMessageKey,
  type Translate,
} from "@/i18n";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMapStore } from "@/stores/map";
import { useAuthStore } from "@/stores/auth";
import {
  RotateCcw,
  Route,
  Bike,
  SlidersHorizontal,
  Map as MapIcon,
  Layers3,
  TriangleAlert,
  Siren,
  Flame,
  Info,
  Square,
  X,
} from "lucide-react";
import {
  DEFAULT_MAP_FILTERS,
  filtersEqual,
  filtersFromSearchParams,
  filtersToSearchParams,
  type FilterableSurface,
  type QualityTier,
} from "@/lib/map-filters";
import { HAZARD_CONFIG, HAZARD_TYPES_UI, QUALITY_CONFIG } from "@/lib/utils";
import { MapLegend } from "@/components/map/MapLegend";
import type { HazardType } from "@tarmoto/shared";
import { QualityMap, type QualityMapHandle } from "./_components/QualityMap";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "@/components/roads/SegmentDetailSidebar";
import {
  TripDetailSidebar,
  type TripDetailPanelState,
} from "@/components/roads/TripDetailSidebar";
import {
  RideDetailSidebar,
  type RideDetailPanelState,
} from "@/components/roads/RideDetailSidebar";
import { ApiError, api, roadsApi, tripsApi } from "@/lib/api";
import { useFeatureGrantNonce, useSystemSwitch } from "@/hooks";
import { useUserTrips } from "@/hooks/useUserTrips";
import { useUserRideTracks } from "@/hooks/useUserRideTracks";
import { useFormat } from "@/format/FormatProvider";
import { FunZonePanel } from "./_components/FunZonePanel";
import {
  fetchFunZonesInBbox,
  funZoneSeasonLabel,
  type FunZoneListItem,
} from "@/lib/discover";
import { tripFromDetail } from "@/lib/trip-from-detail";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { PassesPanel } from "@/components/PassesPanel";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import { GeocodeSearchField } from "@/components/planner/GeocodeSearchField";
import { POI_CATEGORY_META } from "@/components/planner/MapToolbar";
import type { PoiCategory } from "@/lib/planner/types";
import { currentUtcMonth } from "@/lib/passes-summary";
import { Button, Stamp } from "@tarmoto/ui";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

declare global {
  interface Window {
    __tarmotoSelectExploreSegment?: (segmentId: string) => void;
  }
}
/**
 * ExplorerPage — Full-screen road quality map explorer
 *
 * Filter state is mirrored to the URL (?q=...&s=...&c=...) so the view is
 * shareable. QualityMap consumes the store's `filters` and dims non-matching
 * segments via MapLibre paint expressions rather than hiding them outright.
 */
const QUALITY_OPTIONS: {
  key: QualityTier;
  label: EnglishMessageKey;
  color: string;
}[] = [
  { key: "excellent", label: "Excellent", color: "bg-quality-excellent" },
  { key: "good", label: "Good", color: "bg-quality-good" },
  { key: "fair", label: "Fair", color: "bg-quality-fair" },
  { key: "poor", label: "Poor", color: "bg-quality-poor" },
  { key: "very-poor", label: "Very Poor", color: "bg-quality-very-poor" },
];
// The explorer colours all roads in the 5 quality tiers — the legend uses the
// same hex the tile overlay paints (QUALITY_CONFIG), best → worst.
const EXPLORE_QUALITY_LEGEND = QUALITY_OPTIONS.map((opt) => ({
  label: opt.label,
  color: QUALITY_CONFIG[opt.key].hex,
}));
const SURFACE_OPTIONS: {
  key: FilterableSurface;
  label: EnglishMessageKey;
  color: string;
}[] = [
  { key: "asphalt", label: "Asphalt", color: "bg-surface-asphalt" },
  { key: "concrete", label: "Concrete", color: "bg-surface-concrete" },
  { key: "cobblestone", label: "Cobblestone", color: "bg-surface-cobblestone" },
  { key: "gravel", label: "Gravel", color: "bg-surface-gravel" },
  { key: "dirt", label: "Dirt", color: "bg-surface-dirt" },
];
const HAZARD_OPTIONS: {
  key: HazardType;
  label: EnglishMessageKey;
  emoji: string;
  hex: string;
}[] = HAZARD_TYPES_UI.map((key) => ({
  key,
  label: HAZARD_CONFIG[key].label,
  emoji: HAZARD_CONFIG[key].emoji,
  hex: HAZARD_CONFIG[key].hex,
}));

function formatBbox(bbox: readonly [number, number, number, number]): string {
  return bbox.join(",");
}

// Map-overlay toggle pill, styled like the planner's map controls: accent
// outline + text when active, muted cream otherwise.
const OVERLAY_PILL_BASE =
  "flex items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12.5px] font-bold shadow-[0_4px_12px_rgba(14,14,16,0.1)] backdrop-blur-[6px] transition";
function overlayPillClass(active: boolean): string {
  return active
    ? `${OVERLAY_PILL_BASE} border-accent bg-cream text-accent`
    : `${OVERLAY_PILL_BASE} border-line-strong bg-cream/80 text-fg-dim hover:bg-cream hover:text-ink`;
}

// Today, normalised to the same noon-UTC anchor the date picker
// produces. Using a raw `new Date()` would feed the closures API
// the current instant — closures starting later today wouldn't
// match `active_on=<now>` until the rider re-picked the visible
// date, even though the picker UI already shows today.
//
// The year/month/day come from the rider's *local* calendar
// (`getFullYear()` / `getMonth()` / `getDate()`), not UTC. A user
// in California at 18:00 PST sees Friday on their device even
// though UTC is already Saturday at 02:00; pulling UTC fields
// here would boot the picker on Saturday's preview while the
// browser still reads Friday.
function todayAsPreviewDate(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0),
  );
}

// `Filters` panel — endpoint mapping reference
// ──────────────────────────────────────────────
// Each filter section corresponds to a specific backend contract;
// changing the section signature here means touching the matching
// endpoint:
//
//  • Road quality / Surface  → GET /api/v1/tiles/... (segment vector
//    tiles). Filtering is done client-side via the MapLibre opacity
//    expression in `QualityMap.buildQualityOpacityExpression` —
//    the tile payload carries `quality_score` and `surface_type` and
//    the active toggle simply dims non-matching segments.
//  • Hazards                 → GET /api/v1/hazards (PostGIS bbox).
//    `HazardOverlay` reads `filters.hazardTypes` to filter the
//    rendered markers.
//  • Closures / Passes       → GET /api/v1/closures + GET /api/v1/passes.
//    Driven from the top-bar info-layer toggles (#570), not the
//    filter column. When either toggle is on, a right-docked panel
//    surfaces the structured list for the current viewport bbox.
//    `ClosuresPanel` carries a noon-UTC date picker so the rider
//    can preview "tomorrow", "next weekend", etc.; `PassesPanel`
//    keeps its month-of-year selector (passes are seasonal).
//
// Pages can opt into a new filter only after the corresponding tile/
// endpoint actually serves it — for example, the prior `Curviness`
// slider was removed (#576) because `road_segments.curviness_score`
// holds quality-shaped 0–5 values, not the 0–100 the slider implied,
// so the filter was effectively a no-op for every realistic value.
function ExplorerPageInner() {
  const t = useTranslation();
  // SSR-stable initial value (true) avoids a hydration mismatch on
  // narrow viewports where a `matchMedia`-driven initializer would
  // return a different value than the server-rendered HTML. The
  // post-mount effect below narrows the default for real browsers.
  const [filterOpen, setFilterOpen] = useState<boolean>(true);
  // Wide-viewport detection. Drives both the post-mount sidebar
  // default and the info-panel layout swap (grid third column vs.
  // absolute overlay) so a phone toggling Closures/Passes still
  // sees a usable map rather than a 70 px sliver.
  const [isWideViewport, setIsWideViewport] = useState(true);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsWideViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // The draw-region control is drag-based and only handles mouse events, so we
  // offer it only where a fine pointer (mouse / trackpad) exists. On touch-only
  // devices it can't complete a box; the zone list still scopes to the
  // viewport there (pan to re-scope). SSR-stable default true; narrowed post
  // mount. Proper touch draw is a follow-up on the shared RegionDrawControl.
  const [canDrawRegion, setCanDrawRegion] = useState(true);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia("(any-pointer: fine)");
    const update = () => setCanDrawRegion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Post-mount narrow-screen default: close the sidebar so the map
  // gets full width on phones. Runs once on mount; subsequent user
  // toggles of the Filters pill are respected (the effect is keyed
  // to `[]`, not to the viewport state, so a resize doesn't yank
  // the sidebar open or closed against the rider's wishes).
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      setFilterOpen(false);
    }
  }, []);
  // Header overlays: draw the rider's own planned trips / finished rides on top
  // of the quality map. Toggle state lives here; the map rendering is wired in
  // a follow-up (the button shell + active state land first).
  const [showMyTrips, setShowMyTrips] = useState(false);
  const [showMyRides, setShowMyRides] = useState(false);
  // Basemap under the overlays — the branded map or aerial imagery (matches the
  // planner/preview map/aerial toggle).
  const [basemap, setBasemap] = useState<"map" | "aerial">("map");
  // `sys_aerial_basemap` operator kill switch (ČÚZK WMTS outage): when off, hide
  // the Map/Aerial toggle and force the base map back to "map" — even if the
  // `basemap` state was left on "aerial" — so the raster never renders. Re-
  // enabling restores the prior choice (state is preserved). Fails safe (toggle
  // stays available while the switch fetch is unresolved).
  const { enabled: aerialBasemapEnabled } =
    useSystemSwitch("sys_aerial_basemap");
  const effectiveBasemap = aerialBasemapEnabled ? basemap : "map";
  // Active POI browse categories (public `/poi/in-bbox`, so available to
  // everyone). A local Set — not the trip store — keeps /explore independent.
  const [activePoiCategories, setActivePoiCategories] = useState<
    ReadonlySet<PoiCategory>
  >(() => new Set());
  const togglePoiCategory = (category: PoiCategory) =>
    setActivePoiCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  const [conditionsMonth, setConditionsMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  const [conditionsDate, setConditionsDate] = useState<Date>(() =>
    todayAsPreviewDate(),
  );
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );

  const [conditionBbox, setConditionBbox] = useState<string | null>(null);
  const [segmentDetailState, setSegmentDetailState] =
    useState<SegmentDetailPanelState>({ status: "idle" });
  // "My trips" overlay: the rider's trips + the drawer for a clicked route.
  // Only fetch the (geospatial) trip outlines while the overlay is on.
  const format = useFormat();
  const { trips } = useUserTrips({ enabled: showMyTrips });
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [tripDetailState, setTripDetailState] = useState<TripDetailPanelState>({
    status: "idle",
  });
  // "My rides" overlay: the rider's ride tracks + the drawer for a clicked ride.
  const { tracks: rideTracks, truncated: rideTracksTruncated } =
    useUserRideTracks({ enabled: showMyRides });
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [rideDetailState, setRideDetailState] = useState<RideDetailPanelState>({
    status: "idle",
  });
  // The ride drawer shows advanced_ride_stats (lean/ascent) that the backend
  // nulls for a non-entitled request. If the flag unlocks while a drawer is
  // open (upgrade in another tab / operator re-enable), silently refetch the
  // open ride so those fields fill in — this nonce bumps on that transition.
  const advancedStatsGrantNonce = useFeatureGrantNonce("advanced_ride_stats");
  const rideGrantNonceRef = useRef(advancedStatsGrantNonce);
  // Mirror the drawer state into a ref so the fetch effect can tell an
  // enrichment (a ready ride already on screen) from an unlock that lands while
  // the FIRST load is still pending — without adding `rideDetailState` to the
  // effect deps (which would re-fetch on every drawer state change).
  const rideDetailStateRef = useRef(rideDetailState);
  useEffect(() => {
    rideDetailStateRef.current = rideDetailState;
  }, [rideDetailState]);
  // "Fun Zones" overlay (public /roads/fun-zones, migrated from the retired
  // /discover page): score-ramped zone polygons for the viewport, click →
  // right-docked detail drawer. Zones are fetched only while the pill is on.
  const [showFunZones, setShowFunZones] = useState(false);
  const [funZones, setFunZones] = useState<FunZoneListItem[]>([]);
  const [funZonesError, setFunZonesError] = useState(false);
  const [selectedFunZoneId, setSelectedFunZoneId] = useState<string | null>(
    null,
  );
  // Optional drawn bounding box (from the sidebar "Draw region" control). When
  // set it constrains the zone fetch to that box instead of the live viewport,
  // so panning doesn't re-scope the list — matching the retired /discover flow.
  const [drawnBbox, setDrawnBbox] = useState<
    [number, number, number, number] | null
  >(null);
  // Narrow viewports render the info column as a full-width overlay that
  // covers the map — no room to drag a box. While a draw is armed there we
  // hide the overlay (map exposed) and show a floating cancel affordance,
  // restoring the panel once the box is drawn or the draw is cancelled.
  const [narrowDrawing, setNarrowDrawing] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    center,
    zoom,
    showQualityOverlay,
    showHazardOverlay,
    showSurfaceOverlay,
    showConditionsLayer,
    toggleQuality,
    toggleHazards,
    toggleSurface,
    toggleConditionsLayer,
    filters,
    toggleQualityTier,
    toggleSurfaceType,
    toggleHazardType,
    setFilters,
    setCenter,
    setZoom,
    resetFilters,
  } = useMapStore();

  // Operator kill switches. The map components gate their own data, so this is
  // about the CONTROLS agreeing with them: a pill that reads "on", a legend
  // entry, and an upgrade prompt for an overlay the operator has killed all tell
  // the rider the feature is working when it is gone — the exact false sense of
  // control the switch exists to give the OPERATOR, handed to the wrong person.
  //
  // The stored preference is left untouched: the rider's choice is theirs, and it
  // must come back when the switch is lifted.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const { enabled: hazardAlertsEnabled } =
    useFeatureKillSwitch("hazard_alerts");
  const qualityOverlayOn = showQualityOverlay && qualityOverlayEnabled;
  const hazardOverlayOn = showHazardOverlay && hazardAlertsEnabled;
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authUserId = useAuthStore((s) => s.user?.id ?? null);
  // Public visitors get no in-page header — the layout's PublicExploreHeader
  // already carries the brand + auth CTAs. Without our header there's no Filter
  // toggle for them, so the filter column is always shown.
  const filterVisible = isAuthenticated ? filterOpen : true;
  // The right info column composites one block per active info layer: Fun
  // Zones (list + draw region) and/or Conditions (closures + passes). It docks
  // in whenever either is on.
  // Derived, exactly like `qualityOverlayOn` above — NOT sequenced through an
  // effect. Mount effects run in declaration order, so the legacy `?zones=1` /
  // `?zone=` deep-link effect below re-sets `showFunZones` after any teardown
  // effect has cleared it; deriving means no ordering can leave the overlay,
  // the panel or the map mode on while the switch is off.
  const funZonesOn = showFunZones && qualityOverlayEnabled;
  const rightPanelOpen = funZonesOn || showConditionsLayer;
  // Narrow viewports render the info panel as an absolute overlay. While it's
  // up, HIDE the map's floating controls (POI/search row, basemap toggle): on
  // phone widths the panel covers them entirely, and leaving them mounted lets
  // keyboard users tab into controls hidden behind the panel. The panel itself
  // stays below the condition popover (z-30) a Closures/Passes row opens, so
  // focusing a row still shows the popover without disabling the layer.
  const narrowInfoPanelOverlay =
    rightPanelOpen && !isWideViewport && !narrowDrawing;
  // Imperative handle to the MapLibre camera. `MapCanvas` reads
  // its initial center/zoom only at mount (to avoid yanking user
  // pans), so search-pick flows need this narrow opt-in channel
  // to actually fly the map.
  const mapRef = useRef<QualityMapHandle | null>(null);
  // Hydrate the store from URL params on mount and on back/forward navigation.
  // `hydrated` is state (not a ref) so the URL-sync effect waits for the render
  // that follows the store update — otherwise it would see stale `filters` from
  // the same commit and overwrite the URL with defaults.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setFilters(filtersFromSearchParams(searchParams));
    setHydrated(true);
  }, [searchParams, setFilters]);
  // Reflect store changes back into the URL without scrolling or pushing history.
  useEffect(() => {
    if (!hydrated) return;
    const current = new URLSearchParams(searchParams.toString());
    const next = filtersToSearchParams(filters, current);
    if (next.toString() === current.toString()) return;
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [filters, hydrated, pathname, router, searchParams]);
  useEffect(() => {
    // Test-only hook letting Playwright drive segment selection without a
    // real map click. Kept out of real production builds, but the e2e build
    // opts in via `NEXT_PUBLIC_E2E` (set only by playwright.config) so the
    // suite can run against a production build — `next dev`'s per-route JIT
    // compile is what made the CI run exceed its timeout.
    if (
      process.env.NODE_ENV === "production" &&
      process.env.NEXT_PUBLIC_E2E !== "1"
    ) {
      return;
    }
    window.__tarmotoSelectExploreSegment = (segmentId: string) => {
      if (segmentId) setSelectedSegmentId(segmentId);
    };
    return () => {
      delete window.__tarmotoSelectExploreSegment;
    };
  }, []);
  // Drop any selection when the overlay is killed. Hiding the map layers is not
  // enough: the detail effect below keys off `selectedSegmentId`, so an in-flight
  // `getSegmentDetail` would still land and render the quality score, provenance
  // and history in the sidebar — the exact data the switch was flipped to stop,
  // arriving after the overlay it came from has gone.
  useEffect(() => {
    if (!qualityOverlayEnabled) setSelectedSegmentId(null);
  }, [qualityOverlayEnabled]);

  useEffect(() => {
    if (!selectedSegmentId || !qualityOverlayEnabled) {
      setSegmentDetailState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSegmentDetailState({
      status: "loading",
      segmentId: selectedSegmentId,
    });

    roadsApi
      .getSegmentDetail(selectedSegmentId, { signal: controller.signal })
      .then(({ data }) => {
        if (cancelled) return;
        setSegmentDetailState({ status: "ready", segment: data });
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setSegmentDetailState({
            status: "not-found",
            segmentId: selectedSegmentId,
          });
          return;
        }
        setSegmentDetailState({
          status: "error",
          segmentId: selectedSegmentId,
          message: getUserFacingErrorMessage(
            err,
            t("Could not load road segment details."),
          ),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `qualityOverlayEnabled` is a real dependency, not just a lint appeasement:
    // it aborts the in-flight `getSegmentDetail` the moment the switch flips,
    // rather than waiting for the clear-selection effect to cascade.
  }, [t, selectedSegmentId, qualityOverlayEnabled]);
  // Load the clicked trip's detail into the drawer (mirrors the segment fetch).
  useEffect(() => {
    if (!selectedTripId) {
      setTripDetailState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setTripDetailState({ status: "loading", tripId: selectedTripId });
    tripsApi
      .get(selectedTripId)
      .then((result) => {
        if (cancelled) return;
        setTripDetailState({
          status: "ready",
          trip: tripFromDetail(result.data),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setTripDetailState({
          status: "error",
          tripId: selectedTripId,
          message: getUserFacingErrorMessage(
            err,
            t("Could not load this trip."),
          ),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [t, selectedTripId]);
  // Load the clicked ride's detail into the drawer.
  useEffect(() => {
    if (!selectedRideId) {
      // Consume the nonce even with no drawer open, otherwise a grant that
      // lands while nothing is selected would leave `rideGrantNonceRef` stale
      // and misclassify the NEXT ride selection as a silent grant-refetch —
      // skipping the loading state and swallowing errors for a fresh open.
      rideGrantNonceRef.current = advancedStatsGrantNonce;
      setRideDetailState({ status: "idle" });
      return;
    }
    // Silence the refetch ONLY when the drawer already shows a READY ride for
    // this exact selection. If the first load is still pending (or it's a
    // different ride), a nonce bump must run as a normal load so the loading
    // state shows and a failure surfaces an error — otherwise a failed
    // "enrichment" would strand the drawer on its stale loading snapshot.
    const priorState = rideDetailStateRef.current;
    const readyForSelected =
      priorState.status === "ready" && priorState.ride.id === selectedRideId;
    const isGrantRefetch =
      advancedStatsGrantNonce !== rideGrantNonceRef.current && readyForSelected;
    rideGrantNonceRef.current = advancedStatsGrantNonce;
    let cancelled = false;
    const controller = new AbortController();
    // A grant-triggered refetch keeps the drawer showing its current ride
    // instead of flashing back to the loading state — we're only enriching the
    // already-open ride with the newly-unlocked fields.
    if (!isGrantRefetch) {
      setRideDetailState({ status: "loading", rideId: selectedRideId });
    }
    api
      .GET("/api/v1/rides/{rideId}", {
        params: { path: { rideId: selectedRideId } },
        signal: controller.signal,
      })
      .then(({ data, error, response }) => {
        if (cancelled) return;
        if (response?.status === 404) {
          setRideDetailState({ status: "not-found", rideId: selectedRideId });
          return;
        }
        if (error || !data) {
          // On a silent grant-refetch, keep the ride already in the drawer
          // rather than swapping it for an error state.
          if (!isGrantRefetch) {
            setRideDetailState({
              status: "error",
              rideId: selectedRideId,
              message: t("Could not load this ride."),
            });
          }
          return;
        }
        setRideDetailState({ status: "ready", ride: data });
      })
      .catch((err) => {
        if (cancelled || (err as { name?: string }).name === "AbortError")
          return;
        if (!isGrantRefetch) {
          setRideDetailState({
            status: "error",
            rideId: selectedRideId,
            message: t("Could not load this ride."),
          });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [t, selectedRideId, advancedStatsGrantNonce]);
  // Toggling a route overlay off closes its drawer.
  useEffect(() => {
    if (!showMyTrips) setSelectedTripId(null);
  }, [showMyTrips]);
  useEffect(() => {
    if (!showMyRides) setSelectedRideId(null);
  }, [showMyRides]);
  // A live kill takes the feature down mid-session: close the panel, drop the
  // loaded zones (so the overlay stops drawing them) and switch the layer off,
  // which also stops the fetch effect above. Derived state alone would leave
  // the last-loaded zones painted until the next pan.
  useEffect(() => {
    if (qualityOverlayEnabled) return;
    setShowFunZones(false);
    setFunZones([]);
    setFunZonesError(false);
    setSelectedFunZoneId(null);
  }, [qualityOverlayEnabled]);
  useEffect(() => {
    if (!showFunZones) {
      setSelectedFunZoneId(null);
      // Toggling the overlay off also drops any drawn region + its map box,
      // and ends a narrow draw session.
      setDrawnBbox(null);
      setNarrowDrawing(false);
      mapRef.current?.clearDrawnRegion();
    }
  }, [showFunZones]);
  // The bbox the zone list is scoped to: a drawn region (stable across pans)
  // takes precedence over the live viewport.
  const funZoneBbox = drawnBbox ? drawnBbox.join(",") : conditionBbox;
  // Zone fetch while the overlay is on. Debounced so continuous panning
  // doesn't spam the endpoint; superseded requests abort. On failure the
  // previous zones stay on the map and a floating notice appears — silently
  // blanking the overlay would read as "no zones here".
  useEffect(() => {
    // `qualityOverlayEnabled` gates the REQUEST, not just the render — this is
    // a quality-specific endpoint (`avg_quality`, and the zone set is filtered
    // on `quality_score >= 3.0`), so a killed switch must stop it being asked
    // for. Listed in the deps so a live flip tears down an in-flight fetch via
    // the cleanup below rather than letting it land.
    if (!funZonesOn || !funZoneBbox) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const bbox = funZoneBbox.split(",").map(Number) as [
        number,
        number,
        number,
        number,
      ];
      fetchFunZonesInBbox(bbox, { signal: controller.signal })
        .then((zones) => {
          setFunZones(
            [...zones].sort((a, b) => b.composite_score - a.composite_score),
          );
          setFunZonesError(false);
        })
        .catch((err) => {
          if ((err as { name?: string }).name === "AbortError") return;
          setFunZonesError(true);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [funZonesOn, funZoneBbox]);
  // Legacy /discover deep links: the permanent redirect lands here with the
  // old page's query intact (lng/lat/z camera, zone=<id>, zones=1, and the
  // drawn-region bbox — the last has no explorer equivalent; drawn-region
  // zone browsing lives in the trip planner). Consume the params once on
  // mount — restore the camera, open the Fun Zones overlay/panel — then
  // strip them so the URL doesn't replay stale one-shot state on refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const zoneId = params.get("zone");
    const wantZones = zoneId != null || params.get("zones") === "1";
    const lng = params.get("lng") != null ? Number(params.get("lng")) : NaN;
    const lat = params.get("lat") != null ? Number(params.get("lat")) : NaN;
    const z = params.get("z") != null ? Number(params.get("z")) : NaN;
    const hasCamera = Number.isFinite(lng) && Number.isFinite(lat);
    const hasLegacyParams =
      wantZones || hasCamera || params.get("bbox") != null;
    if (!hasLegacyParams) return;
    if (hasCamera) {
      const nextZoom = Number.isFinite(z) ? z : useMapStore.getState().zoom;
      // Child effects ran first, so the map instance exists — fly it, and
      // mirror into the store for a later remount (same as search-pick).
      mapRef.current?.flyTo({ lng, lat, zoom: nextZoom });
      setCenter({ lng, lat });
      setZoom(nextZoom);
    }
    // Ingest the Fun Zone half ONLY if the feature is live. `funZonesOn` masks
    // this state while killed, but the params are stripped just below — so
    // storing it anyway leaves a charge that fires the moment a poll lifts the
    // kill, springing the overlay and drawer open with no user action, from a
    // link that was consumed minutes earlier. The camera restore above is not
    // quality data and is unaffected.
    if (wantZones && qualityOverlayEnabled) {
      setShowFunZones(true);
      if (zoneId) setSelectedFunZoneId(zoneId);
    }
    const url = new URL(window.location.href);
    for (const key of ["zone", "zones", "lng", "lat", "z", "bbox"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);
    // Deliberately NOT re-running on `qualityOverlayEnabled`: this effect is a
    // one-shot param consumer, and re-running it after the params are stripped
    // would do nothing anyway. Restoring a killed link once the switch returns
    // is the behaviour being prevented, not a case to support.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCenter, setZoom]);
  // A session/account change (sign-in as another user, sign-out) must never
  // leave the previous rider's private trip/ride drawer open.
  useEffect(() => {
    setSelectedTripId(null);
    setSelectedRideId(null);
  }, [authUserId]);
  const isDefault = filtersEqual(filters, DEFAULT_MAP_FILTERS);
  // Road quality and surface are mutually exclusive overlays (one line-coloring
  // vocabulary at a time, like the planner): activating one clears the other;
  // clicking the active one turns it off.

  const selectQualityOverlay = () => {
    if (showSurfaceOverlay) toggleSurface();
    toggleQuality();
  };
  const selectSurfaceOverlay = () => {
    if (showQualityOverlay) toggleQuality();
    toggleSurface();
  };
  // Dismisses the whole composited info column (narrow-viewport ×), turning
  // off every info layer that feeds it.
  const closeRightPanel = () => {
    if (showFunZones) setShowFunZones(false);
    if (showConditionsLayer) toggleConditionsLayer();
  };
  // Composited right-column content: a Fun Zones block (draw region + ranked
  // list) and/or a Conditions block, with a divider only between the two.
  const rightPanel = (
    <div className="flex min-h-0 flex-col gap-4">
      {funZonesOn && (
        <FunZonesBlock
          zones={funZones}
          selectedZoneId={selectedFunZoneId}
          hasDrawnRegion={drawnBbox != null}
          canDraw={canDrawRegion}
          error={funZonesError}
          format={format}
          onSelectZone={(zoneId) => {
            setSelectedSegmentId(null);
            setSelectedTripId(null);
            setSelectedRideId(null);
            setSelectedFunZoneId(zoneId);
          }}
          onDrawRegion={() => {
            mapRef.current?.startDrawRegion();
            // Narrow overlay covers the map — step it aside to drag on.
            if (!isWideViewport) setNarrowDrawing(true);
          }}
          onClearRegion={() => mapRef.current?.clearDrawnRegion()}
        />
      )}
      {showConditionsLayer && (
        <InfoPanelContent
          // A leading divider only when a Fun Zones block sits above — same
          // `border-t` the Closures/Passes sections use, so the between-blocks
          // rule reads consistently (a 1px bg div could sub-pixel away).
          topDivider={funZonesOn}
          conditionsMonth={conditionsMonth}
          setConditionsMonth={setConditionsMonth}
          conditionsDate={conditionsDate}
          setConditionsDate={setConditionsDate}
          conditionBbox={conditionBbox}
          onFocusClosure={(closure) =>
            mapRef.current?.openConditionPopover({
              kind: "closure",
              id: closure.id,
            })
          }
          onFocusPass={(pass) =>
            mapRef.current?.openConditionPopover({
              kind: "pass",
              id: pass.id,
            })
          }
        />
      )}
    </div>
  );
  return (
    // Spec-aligned Route Explorer (v2-pages.jsx RoadExplorerView): a
    // 300|1fr grid with the Filters sidebar on the left, full-bleed
    // map on the right carrying floating search + layer pills +
    // legend overlays. Closures / Passes info panel docks in via a
    // third column when those layers are toggled.
    //
    // Responsive grid template via CSS variables so each side column
    // collapses to 0 when its content is hidden — handles the
    // narrow-viewport case where the fixed 300 px + 370 px chrome
    // would crowd out the map and leave the rider with no recovery
    // affordance (the floating "Filters" pill in the layer overlay
    // is the toggle, matching the spec's primary-accent pill).
    <div className="flex h-full min-h-0 flex-col bg-cream text-ink">
      {/* Page header — same chrome/height as the trip preview/edit bar:
          heading on the left, action buttons on the right. "My trips" /
          "My rides" overlay the rider's own routes on the map; "Filter"
          toggles the left filter column. Shown only for signed-in riders —
          public visitors get the layout's PublicExploreHeader instead. */}
      {isAuthenticated && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur-sm">
          <div className="flex min-w-0 shrink-0 items-center gap-[9px]">
            <MapIcon size={18} className="shrink-0 text-accent" aria-hidden />
            <h1 className="truncate font-sans text-[18px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
              {t("Road Explorer")}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Toggle buttons: outline (secondary) when off, neutral ink fill
              (primary) when on — coral/accent stays reserved for CTAs. */}
            <Button
              variant={showMyTrips ? "primary" : "secondary"}
              size="sm"
              uppercase
              leftIcon={<Route size={14} />}
              aria-pressed={showMyTrips}
              onClick={() => setShowMyTrips((value) => !value)}
            >
              {t("My trips")}
            </Button>
            <Button
              variant={showMyRides ? "primary" : "secondary"}
              size="sm"
              uppercase
              leftIcon={<Bike size={14} />}
              aria-pressed={showMyRides}
              onClick={() => setShowMyRides((value) => !value)}
            >
              {t("My rides")}
            </Button>
            <Button
              variant={filterOpen ? "primary" : "secondary"}
              size="sm"
              uppercase
              leftIcon={<SlidersHorizontal size={14} />}
              aria-pressed={filterOpen}
              onClick={() => setFilterOpen((value) => !value)}
            >
              {t("Filter")}
            </Button>
          </div>
        </header>
      )}
      {/* Spec-aligned Route Explorer grid: Filters sidebar | map | info panel.
          Each side column collapses to 0 via its CSS variable; the grid
          animates the width change (mirrors the planner's day column). */}
      <div
        className="grid min-h-0 flex-1 grid-cols-[var(--explore-left)_1fr_var(--explore-right)] transition-[grid-template-columns] duration-300 ease-out"
        style={
          {
            "--explore-left": filterVisible ? "300px" : "0px",
            // Info panel only takes a real grid column on wide
            // viewports. On narrow viewports it overlays the map
            // (see the absolute-positioned aside below) so a phone
            // doesn't lose its entire map area to a fixed rail.
            "--explore-right":
              isWideViewport && rightPanelOpen ? "370px" : "0px",
          } as React.CSSProperties
        }
      >
        {/* LEFT — Filters sidebar. Always present in the grid so the
          map column stays in the middle track — `display: none`
          would drop the aside from layout and the map would land
          in the 0-width first column instead. Closed state =
          `overflow-hidden` on a 0-width column clips the children,
          and `inert` + `aria-hidden` drop the (still-mounted)
          form controls out of focus order and the AT tree so
          keyboard users don't tab through invisible inputs. */}
        <aside
          className="flex min-h-0 flex-col overflow-hidden border-r border-line bg-paper"
          inert={!filterVisible}
          aria-hidden={!filterVisible}
        >
          <div className="flex items-center justify-between border-b border-line px-5 pb-3 pt-[18px]">
            <h2 className="whitespace-nowrap font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
              {t("Filters")}
            </h2>
            <button
              type="button"
              onClick={resetFilters}
              disabled={isDefault}
              className="inline-flex items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[1px] text-fg-dim transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={12} />
              {t("Reset")}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* These checkboxes feed `qualityOpacityExpression` and nothing
                else, so with the overlay killed they are controls that cannot
                change anything on screen. The surface filters below are
                unaffected — they drive their own expression. */}
            {qualityOverlayEnabled ? (
              <div className="mb-[18px]">
                <Stamp as="h3" className="mb-2.5 block">
                  {t("Road quality")}
                </Stamp>
                <div className="flex flex-col gap-2">
                  {QUALITY_OPTIONS.map((opt) => (
                    <FilterCheckbox
                      key={opt.key}
                      checked={filters.quality.has(opt.key)}
                      onChange={() => toggleQualityTier(opt.key)}
                      swatch={
                        <span
                          aria-hidden="true"
                          className={`h-2.5 w-2.5 rounded-full ${opt.color}`}
                        />
                      }
                      label={t(opt.label)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mb-[18px]">
              <Stamp as="h3" className="mb-2.5 block">
                {t("Surface type")}
              </Stamp>
              <div className="flex flex-col gap-2">
                {SURFACE_OPTIONS.map((opt) => (
                  <FilterCheckbox
                    key={opt.key}
                    checked={filters.surface.has(opt.key)}
                    onChange={() => toggleSurfaceType(opt.key)}
                    swatch={
                      <span
                        aria-hidden="true"
                        className={`h-2.5 w-2.5 rounded-full ${opt.color}`}
                      />
                    }
                    label={t(opt.label)}
                  />
                ))}
              </div>
            </div>

            <div className="mb-[18px]">
              <Stamp as="h3" className="mb-2.5 block">
                {t("Hazard type")}
              </Stamp>
              <div className="flex flex-col gap-2">
                {HAZARD_OPTIONS.map((opt) => (
                  <FilterCheckbox
                    key={opt.key}
                    checked={filters.hazardTypes.has(opt.key)}
                    onChange={() => toggleHazardType(opt.key)}
                    swatch={
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: opt.hex }}
                      />
                    }
                    label={t(opt.label)}
                  />
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* CENTER — Map + floating overlays */}
        <div className="relative min-h-0 min-w-0 bg-cream">
          <div className="absolute inset-0">
            <QualityMap
              ref={mapRef}
              center={center}
              zoom={zoom}
              filters={filters}
              basemap={effectiveBasemap}
              poiCategories={activePoiCategories}
              poiMonth={conditionsMonth}
              showQuality={qualityOverlayOn}
              showSurface={showSurfaceOverlay}
              showHazards={hazardOverlayOn}
              showConditions={showConditionsLayer}
              conditionBbox={conditionBbox}
              conditionsMonth={conditionsMonth}
              conditionsDate={conditionsDate}
              showMyTrips={showMyTrips}
              trips={trips}
              onTripSelect={(tripId) => {
                // One drawer at a time — a trip click supersedes ride/segment.
                setSelectedSegmentId(null);
                setSelectedRideId(null);
                setSelectedFunZoneId(null);
                setSelectedTripId(tripId);
              }}
              showMyRides={showMyRides}
              rideTracks={rideTracks}
              onRideSelect={(rideId) => {
                setSelectedSegmentId(null);
                setSelectedTripId(null);
                setSelectedFunZoneId(null);
                setSelectedRideId(rideId);
              }}
              showFunZones={funZonesOn}
              funZones={funZones}
              // Derived like the panel's `zoneId`: the raw selection survives a
              // kill (nothing clears it, and a `?zone=` link can set it), so
              // handing the map the raw value leaves a killed zone highlighted
              // there. The last writer of this state that was not derived.
              selectedFunZoneId={funZonesOn ? selectedFunZoneId : null}
              onFunZoneSelect={(zoneId) => {
                setSelectedSegmentId(null);
                setSelectedTripId(null);
                setSelectedRideId(null);
                setSelectedFunZoneId(zoneId);
              }}
              onDrawnRegionChange={(bbox) => {
                setDrawnBbox(bbox);
                // A committed/cleared box ends the narrow draw session.
                setNarrowDrawing(false);
              }}
              onSegmentSelect={(segmentId) => {
                setSelectedTripId(null);
                setSelectedRideId(null);
                setSelectedFunZoneId(null);
                setSelectedSegmentId(segmentId);
              }}
              selectedSegmentId={selectedSegmentId}
              onViewChange={(view) => {
                setCenter({ lng: view.lng, lat: view.lat });
                setZoom(view.zoom);
                setConditionBbox(formatBbox(view.bbox));
              }}
            />
          </div>

          {/* Row 1 — address search + POI category chips. The search is
              signed-in only (the `/api/v1/geocode` endpoint sits behind
              AuthGuard); the chips browse the public `/poi/in-bbox` store so
              they show for everyone. Mirrors the planner/preview MapToolbar. */}
          <div
            className={`absolute left-3 right-14 top-3 items-center gap-2 ${
              narrowInfoPanelOverlay ? "hidden" : "z-30 flex"
            }`}
          >
            {isAuthenticated ? (
              <div className="relative w-[240px] shrink-0 rounded-[10px] border border-line-strong bg-cream/95 px-3 py-2 shadow-[0_4px_12px_rgba(14,14,16,0.10)]">
                <GeocodeSearchField
                  placeholder={t("Address search")}
                  ariaLabel={t("Address search")}
                  onSelect={(place) => {
                    // Fly the actual MapLibre camera; MapCanvas reads
                    // center/zoom only at init, so mirror it into the store
                    // too for a later remount.
                    mapRef.current?.flyTo({
                      lng: place.lng,
                      lat: place.lat,
                      zoom: EXPLORE_SEARCH_RESULT_ZOOM,
                    });
                    setCenter({ lng: place.lng, lat: place.lat });
                    setZoom(EXPLORE_SEARCH_RESULT_ZOOM);
                  }}
                  clearOnSelect
                  widenDropdown
                  clearable
                />
              </div>
            ) : null}
            <div
              role="group"
              aria-label={t("POI categories")}
              className="scrollbar-none flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5"
            >
              {POI_CATEGORY_META.map(({ category, label, icon: Icon }) => {
                const active = activePoiCategories.has(category);
                return (
                  <button
                    key={category}
                    type="button"
                    aria-pressed={active}
                    onClick={() => togglePoiCategory(category)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold transition ${
                      active
                        ? "border-accent bg-accent text-cream"
                        : "border-line-strong bg-cream/90 text-ink hover:border-ink"
                    }`}
                  >
                    <Icon size={13} />
                    {t(label)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Rows 2 & 3 — basemap toggle + layer pills, styled like the
              planner's map controls. Sits below row 1 (search + POI chips).
              Hidden with the other map controls while the narrow info panel
              overlays the map, so keyboard users can't tab into the Map/Aerial
              and layer buttons hidden behind the full-width panel. */}
          <div
            className={`absolute left-3 top-[60px] flex-col gap-2 ${
              narrowInfoPanelOverlay ? "hidden" : "z-20 flex"
            }`}
          >
            {/* Row 2 — Map / Aerial basemap (swaps what's under the overlays).
                Hidden while `sys_aerial_basemap` is killed. */}
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

            {/* Row 3 — layer pills. Road quality | Surface are mutually
                exclusive; Hazards / Conditions are independent. "Conditions"
                is one toggle for closures + passes together, matching the
                planner/preview map. */}
            <div className="flex flex-wrap gap-2">
              {/* HIDDEN under the kill, not disabled. `overlayPillClass` has no
                  disabled styling, so a disabled pill looked identical to the
                  live Surface / Hazards pills beside it and simply did not
                  respond — a dead control is worse than an absent one. This
                  matches Fun Zones below and the planner's line-colour toggle,
                  both of which already hide. */}
              {qualityOverlayEnabled ? (
                <button
                  type="button"
                  onClick={selectQualityOverlay}
                  aria-pressed={qualityOverlayOn}
                  className={overlayPillClass(qualityOverlayOn)}
                >
                  <Layers3 size={14} />
                  {t("Road quality")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={selectSurfaceOverlay}
                aria-pressed={showSurfaceOverlay}
                className={overlayPillClass(showSurfaceOverlay)}
              >
                <Layers3 size={14} />
                {t("Surface")}
              </button>
              <button
                type="button"
                onClick={toggleHazards}
                aria-pressed={hazardOverlayOn}
                disabled={!hazardAlertsEnabled}
                className={overlayPillClass(hazardOverlayOn)}
              >
                <Siren size={14} />
                {t("Hazards")}
              </button>
              <button
                type="button"
                onClick={toggleConditionsLayer}
                aria-pressed={showConditionsLayer}
                className={overlayPillClass(showConditionsLayer)}
              >
                <TriangleAlert size={14} />
                {t("Conditions")}
              </button>
              {/* The whole feature goes under a `road_quality_overlay` kill,
                  not just its quality figures: zones are clustered from roads
                  filtered at `quality_score >= 3.0`, so the zone SET is
                  quality-derived. Removing the control is what stops the
                  quality-specific `/roads/fun-zones` requests being issued at
                  all — an operator flipping this switch must be able to stop
                  them, not merely stop them rendering. */}
              {qualityOverlayEnabled ? (
                <button
                  type="button"
                  onClick={() => setShowFunZones((v) => !v)}
                  aria-pressed={showFunZones}
                  className={overlayPillClass(showFunZones)}
                >
                  <Flame size={14} />
                  {t("Fun Zones")}
                </button>
              ) : null}
            </div>
          </div>

          <MapLegend
            {...(qualityOverlayOn ? { quality: EXPLORE_QUALITY_LEGEND } : {})}
            surface={showSurfaceOverlay}
            conditions={showConditionsLayer}
            hazards={hazardOverlayOn}
          />

          {/* The overlay caps how many routes it draws (server-side, ≤500).
              When the rider has more route-bearing rides than that, say so
              rather than letting the partial overlay read as complete history.
              Uses the actual returned count so the copy stays correct whatever
              the configured cap is. Bottom-center clears the bottom-left
              legend; pointer-events-none so it never blocks the map. */}
          {funZonesOn && funZonesError && (
            <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-quality-q1/40 bg-cream/90 px-3 py-1.5 text-[11px] font-semibold text-red-700 shadow-[0_4px_12px_rgba(14,14,16,0.12)] backdrop-blur-sm">
              {t("Couldn't refresh Fun Zones for this area")}
            </div>
          )}
          {showMyRides && rideTracksTruncated && (
            <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-cream/90 px-3 py-1.5 text-[11px] font-semibold text-fg-dim shadow-[0_4px_12px_rgba(14,14,16,0.12)] backdrop-blur-sm">
              <Info size={13} className="shrink-0 text-accent" aria-hidden />
              {t(
                "Showing your {count, plural, one {# most recent route} other {# most recent routes}}",
                {
                  count: rideTracks.length,
                },
              )}
            </div>
          )}
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedSegmentId(null)}
            // Signed-in riders get the full-window drawer (their page header is
            // the only chrome it covers, same as the trip views). Public
            // visitors stay container-anchored so it never covers the
            // PublicExploreHeader's sign-in / create-account CTAs.
            anchor={isAuthenticated ? "viewport" : "container"}
          />
          <TripDetailSidebar
            state={tripDetailState}
            onClose={() => setSelectedTripId(null)}
            anchor={isAuthenticated ? "viewport" : "container"}
          />
          <RideDetailSidebar
            state={rideDetailState}
            onClose={() => setSelectedRideId(null)}
            anchor={isAuthenticated ? "viewport" : "container"}
          />
          {/* Derived, not sequenced: a legacy `?zone=<id>` deep link sets the
              selection on mount, so reading the raw id here would leave the
              drawer mounted under a kill even with the control gone. */}
          <FunZonePanel
            zoneId={funZonesOn ? selectedFunZoneId : null}
            summary={
              funZones.find((zone) => zone.id === selectedFunZoneId) ?? null
            }
            onClose={() => setSelectedFunZoneId(null)}
          />

          {/* Narrow draw session: the overlay is stepped aside so the rider
              can drag on the exposed map. A floating chip keeps a cancel out
              (which restores the panel via `startDrawRegion`'s counterpart). */}
          {!isWideViewport && narrowDrawing && (
            <div className="absolute bottom-8 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong bg-cream/95 px-3 py-1.5 text-[11px] font-semibold text-fg-dim shadow-[0_4px_12px_rgba(14,14,16,0.12)] backdrop-blur-sm">
              <Square size={12} className="shrink-0 text-accent" aria-hidden />
              {t("Drag on the map to draw a region")}
              <button
                type="button"
                onClick={() => {
                  mapRef.current?.cancelDrawRegion();
                  setNarrowDrawing(false);
                }}
                className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper-2"
              >
                {t("Cancel")}
              </button>
            </div>
          )}

          {/* Narrow-viewport info panel — overlays the map instead of
            taking a grid column so a phone keeps useful map area
            underneath. Hidden while a draw is armed (above). Close button
            toggles off whichever info layer is active (mirrors how toggling
            the pill in the top overlay dismisses the panel). */}
          {narrowInfoPanelOverlay && (
            <aside
              // z-20: below the condition popover (z-30) a Closures/Passes row
              // opens (so focusing a row shows it on the map above the panel)
              // and below modals (z-40/z-50). The map controls are hidden while
              // this overlay is up, so nothing paints over the panel.
              className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col overflow-y-auto border-l border-line bg-paper p-4 pt-16 shadow-[-6px_0_16px_rgba(14,14,16,0.08)]"
              aria-label={t("Info layers")}
            >
              <button
                type="button"
                onClick={closeRightPanel}
                className="absolute right-3 top-3 rounded-md border border-line-strong bg-cream px-2 py-1 text-[11px] font-bold uppercase tracking-[1px] text-ink transition hover:bg-paper-2"
                aria-label={t("Close info panel")}
              >
                {t("Close")}
              </button>
              {rightPanel}
            </aside>
          )}
        </div>

        {/* RIGHT — composited info column. One block per active info layer
          (Fun Zones list + draw region, and/or Closures/Passes), stacked with
          a divider only *between* blocks. On wide viewports it docks in as a
          real third grid column (`--explore-right` = 370 px); on narrow
          viewports the grid column collapses to 0 and the same content
          overlays the map (above) so a phone keeps a usable map underneath. */}
        {rightPanelOpen && isWideViewport && (
          <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-line bg-paper p-4">
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
// Zoom the map flies to when a rider picks an address-search result.
const EXPLORE_SEARCH_RESULT_ZOOM = 12;

// Conditions info-panel content (closures + passes together, one toggle).
// Shared between the wide-viewport third-grid-column aside and the
// narrow-viewport overlay aside so the closures date picker, ClosuresPanel,
// and PassesPanel only get described once. `onFocusClosure`/`onFocusPass`
// fly the map to a list-row's marker and open its shared popover.
function InfoPanelContent({
  topDivider = false,
  conditionsMonth,
  setConditionsMonth,
  conditionsDate,
  setConditionsDate,
  conditionBbox,
  onFocusClosure,
  onFocusPass,
}: {
  /** Divider above the first section — set when another block sits above. */
  topDivider?: boolean;
  conditionsMonth: number;
  setConditionsMonth: (month: number) => void;
  conditionsDate: Date;
  setConditionsDate: (date: Date) => void;
  conditionBbox: string | null;
  onFocusClosure: (closure: PlannerClosure) => void;
  onFocusPass: (pass: MountainPass) => void;
}) {
  const t = useTranslation();
  return (
    <>
      {conditionBbox ? (
        <ClosuresPanel
          month={conditionsMonth}
          previewDate={conditionsDate}
          onPreviewDateChange={setConditionsDate}
          routes={[]}
          bbox={conditionBbox}
          showRouteWarnings={false}
          onFocusClosure={onFocusClosure}
          // Leading divider only when a block sits above (Fun Zones); when
          // Conditions is the first/only block the panel top stays clean.
          topDivider={topDivider}
        />
      ) : (
        <p className="text-xs text-fg-dim">
          {t("Pan the map to load closures for this area.")}
        </p>
      )}
      {conditionBbox ? (
        <PassesPanel
          month={conditionsMonth}
          onMonthChange={setConditionsMonth}
          routes={[]}
          bbox={conditionBbox}
          showRouteWarnings={false}
          onFocusPass={onFocusPass}
          focusOpenPasses
        />
      ) : (
        <p className="text-xs text-fg-dim">
          {t("Pan the map to load passes for this area.")}
        </p>
      )}
    </>
  );
}

// Fun Zones info block: header + draw-region controls + a ranked list of zones
// in the current scope (drawn box or viewport). Selecting a row opens the
// zone's detail drawer. Carried over from the retired /discover left panel.
function FunZonesBlock({
  zones,
  selectedZoneId,
  hasDrawnRegion,
  canDraw,
  error,
  format,
  onSelectZone,
  onDrawRegion,
  onClearRegion,
}: {
  zones: readonly FunZoneListItem[];
  selectedZoneId: string | null;
  hasDrawnRegion: boolean;
  /** Whether the drag-based draw-region control is offered (fine pointer). */
  canDraw: boolean;
  error: boolean;
  format: ReturnType<typeof useFormat>;
  onSelectZone: (zoneId: string) => void;
  onDrawRegion: () => void;
  onClearRegion: () => void;
}) {
  const t = useTranslation();
  // Read the kill here rather than take it as a prop — the page above already
  // resolves the same flag, but a prop is one more thing a caller has to
  // remember, and both read the one cached `/config/flags` query so they
  // cannot disagree.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Flame size={14} className="text-accent" />
          {t("Fun Zones")}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.4px] text-fg-mute">
          {t("{count} in {scope}", {
            count: zones.length,
            scope: hasDrawnRegion ? t("drawn region") : t("view"),
          })}
        </span>
      </div>

      {canDraw && (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Square size={13} />}
            onClick={onDrawRegion}
            className="flex-1"
          >
            {hasDrawnRegion ? t("Redraw region") : t("Draw region")}
          </Button>
          {hasDrawnRegion && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X size={13} />}
              onClick={onClearRegion}
            >
              {t("Clear")}
            </Button>
          )}
        </div>
      )}

      {error ? (
        <p className="text-xs text-fg-dim">
          {t("Couldn't refresh Fun Zones for this area.")}
        </p>
      ) : zones.length === 0 ? (
        <p className="text-xs text-fg-dim">
          {hasDrawnRegion
            ? t("No Fun Zones in the drawn region — redraw a larger area.")
            : t("No Fun Zones in view — zoom out or pan the map.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {zones.map((zone, index) => {
            const active = zone.id === selectedZoneId;
            return (
              <li key={zone.id}>
                <button
                  type="button"
                  onClick={() => onSelectZone(zone.id)}
                  className={`flex w-full items-start gap-3 rounded-[11px] border px-3 py-2.5 text-left transition ${
                    active
                      ? "border-accent bg-accent/10"
                      : "border-line bg-cream hover:border-line-strong hover:bg-paper"
                  }`}
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-bold tabular-nums text-accent">
                    {format.number(index + 1, {
                      useGrouping: false,
                      maximumFractionDigits: 0,
                    })}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                        {zone.name ?? funZoneFallbackName(zone, format, t)}
                      </span>
                      <span className="shrink-0 text-xs font-bold tabular-nums text-accent">
                        {format.decimal(zone.composite_score, 1)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
                      {t(
                        "{roads}{hasCurves, select, yes { · {curves} curves} other {}}{hasQuality, select, yes { · avg {quality}★} other {}}",
                        {
                          roads: t(
                            "{count, plural, one {{n} road} other {{n} roads}}",
                            {
                              count: zone.road_count,
                              n: format.integer(zone.road_count),
                            },
                          ),
                          hasCurves: zone.total_curve_km != null ? "yes" : "no",
                          curves:
                            zone.total_curve_km != null
                              ? format.distanceKm(zone.total_curve_km)
                              : "",
                          // The message already selects on `hasQuality`, so a
                          // kill reads as "this zone has no quality figure"
                          // rather than needing a second copy of the line.
                          hasQuality:
                            qualityOverlayEnabled && zone.avg_quality != null
                              ? "yes"
                              : "no",
                          quality:
                            qualityOverlayEnabled && zone.avg_quality != null
                              ? format.decimal(zone.avg_quality, 1)
                              : "",
                        },
                      )}
                    </span>
                    {zone.best_season ? (
                      <span className="mt-0.5 block truncate text-[10px] text-fg-mute">
                        {t(funZoneSeasonLabel(zone.best_season))}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Placeholder name from the zone polygon centroid when the backend has no
// human label yet — the boundary is a closed ring, so averaging its vertices
// is a cheap centroid approximation (mirrors the retired /discover panel).
function funZoneFallbackName(
  zone: FunZoneListItem,
  format: ReturnType<typeof useFormat>,
  t: Translate,
): string {
  const points = zone.boundary as unknown as Array<{
    lat: number;
    lng: number;
  }>;
  if (!points || points.length === 0) return t("Unnamed zone");
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return t("Zone near {lat}, {lng}", {
    lat: format.decimal(lat, 2),
    lng: format.decimal(lng, 2),
  });
}

// Spec-styled filter checkbox: 16 × 16 rounded-4 ink-bordered
// square that fills with solid ink + cream checkmark when on.
// The native `<input>` stays in the DOM (visually hidden via
// `sr-only`) for keyboard + screen-reader semantics; the visual
// square renders in a sibling span styled with the `peer-…`
// modifier chain so focus rings and checked-state styling stay
// linked to the underlying input state.
function FilterCheckbox({
  checked,
  onChange,
  swatch,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  swatch: React.ReactNode;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-ink">
      {/* eslint-disable-next-line no-restricted-syntax -- sr-only checkbox
          carrying native keyboard/AT semantics; the visible spec-styled
          square is the sibling span. */}
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-[4px] border-[1.5px] border-ink transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-1 ${
          checked ? "bg-ink" : "bg-cream"
        }`}
      >
        {checked && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            className="text-cream"
          >
            <path
              d="M2 6l3 3 5-6"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {swatch}
      <span>{label}</span>
    </label>
  );
}

export default function ExplorerPage() {
  return (
    <Suspense fallback={null}>
      <ExplorerPageInner />
    </Suspense>
  );
}
