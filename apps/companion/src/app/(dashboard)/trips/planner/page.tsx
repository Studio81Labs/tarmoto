"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import {
  getUserFacingErrorMessage,
  type EnglishMessageKey,
  type Translate,
} from "@/i18n";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  Checkbox,
  Input,
  NumberField,
  Select,
  Toggle,
  Tooltip,
} from "@tarmoto/ui";
import {
  useTripStore,
  normalizeDayFinish,
  dayFinishWaypoint,
} from "@/stores/trip";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  MapPin,
  MoveRight,
  X,
  Save,
  SlidersHorizontal,
  GripVertical,
  Lightbulb,
  LogOut,
  RotateCcw,
  RotateCw,
  Users,
  Upload,
  FileUp,
  Layers,
  Maximize2,
  Trash2,
  Loader2,
  Plus,
  Star,
  Pencil,
  PanelLeft,
} from "lucide-react";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import type { PlannerClosure } from "@/lib/closures-summary";
import { PassesPanel } from "@/components/PassesPanel";
import { InspectTab } from "@/components/planner/InspectTab";
import {
  PlannerPanel,
  SectionStamp,
  type PlannerTab,
} from "@/components/planner/PlannerPanel";
import { TripPlannerMap } from "@/components/TripPlannerMap";
import type { TripPlannerMapHandle } from "@/components/TripPlannerMap";
import { TripStopsPanel } from "@/components/TripStopsPanel";
import { DayByDayList } from "@/components/trips/DayByDayList";
import {
  coordinateAtKm,
  kmAlongRouteAt,
  rawBreakTargetKms,
  splitIntoDays,
} from "@/lib/planner/day-splitter";
import { fetchOvernightTowns } from "@/lib/planner/api";
import { aggregateInspectDay } from "@/lib/planner/inspect-day";
import { plannerApi } from "@/lib/planner/api";
import {
  dayPlanBoundaryDisplayName,
  isLegacyGeneratedWaypointName,
  waypointDisplayName,
} from "@/lib/planner/labels";
import { insertDraftedVias } from "./page.helpers";
import {
  buildPrefsSummary,
  DEFAULT_ROAD_PREFERENCE,
  effectiveLegPreference,
  fromTripRoadPreference,
  legId as legPairId,
  minQualityFromLevel,
  minQualityToLevel,
  reconcileLegPrefs,
  sameUserRoutePrefs,
  toTripRoadPreference,
  FALLBACK_USER_ROUTE_PREFS,
  ROAD_PREFERENCE_LABELS,
  POINT_TO_POINT_PREFERENCES,
  type LegPref,
  type RoadPreference,
  type UserRoutePrefs,
} from "@/lib/planner/prefs";
import type {
  PlannerRoutingLeg,
  TripLegBreak,
} from "@/lib/planner/leg-routing";
import { RoundtripDialog } from "@/components/planner/RoundtripDialog";
import type { GeoResult } from "@/lib/planner/types";
import type { RoundtripOptions } from "@/lib/planner/types";
import {
  rerouteAroundConditionInTrip,
  rerouteAroundSegmentInTrip,
} from "@/lib/planner/reroute";
import { GeocodeSearchField } from "@/components/planner/GeocodeSearchField";
import {
  deriveDayQualitySegments,
  findPlannerQualitySegment,
} from "@/lib/trip-planner-map";
import { tripCollabApi } from "@/lib/api/trip-collab";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { TripExportButton } from "@/components/TripExportButton";
import { TripImportDialog } from "@/components/TripImportDialog";
import type {
  RegionDrawBbox,
  RegionDrawMode,
} from "@/components/map/RegionDrawControl";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { usePlannerRouting } from "@/hooks/usePlannerRouting";
import { useRouteQualityHydration } from "@/hooks/useRouteQualityHydration";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import { useEntitlements, useFeature, useLimit } from "@/hooks";
import { useUserTrips } from "@/hooks/useUserTrips";
import { countOpenOwnedTrips } from "@/lib/trip-filters";
import { parseFeatureLimitError, tierLabel } from "@/lib/entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { useAuthStore } from "@/stores/auth";
import { ApiError, roadsApi, tripsApi } from "@/lib/api";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "@/components/roads/SegmentDetailSidebar";
import { toast } from "@/lib/toast";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { UNPAVED_SURFACES } from "@/lib/surface-preferences";
import {
  generatedOptionsFromResponse,
  selectedGeneratedOption,
  type GenerateTripResponse,
  type GeneratedTripOption,
  type TripGenerationOptionId,
} from "@/lib/trip-generation-options";
import {
  currentUtcMonth,
  type MountainPass as MountainPassSummary,
} from "@/lib/passes-summary";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import {
  findOwnerId,
  tripFromDetail,
  withRequestOnlyRouteOptions,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import type {
  SurfaceType,
  Trip,
  TripDay,
  TripParameters,
  Waypoint,
} from "@/lib/types";
import { useFormat } from "@/format/FormatProvider";
/**
 * TripPlannerPage — Full-screen map-based trip planner.
 *
 * Live trip collaboration (US-35) is wired through `useTripCollabSession`:
 * cursors, presence, suggestions, and remote `trip:updated`/`trip:deleted`
 * broadcasts are merged into local state so collaborators see each
 * other's edits without reloading.
 */
const SURFACE_OPTIONS: {
  value: SurfaceType;
  label: EnglishMessageKey;
}[] = [
  { value: "asphalt", label: "Asphalt" },
  { value: "concrete", label: "Concrete" },
  { value: "cobblestone", label: "Cobbles" },
  { value: "gravel", label: "Gravel" },
  { value: "dirt", label: "Dirt" },
];
const MIN_BACKEND_DAILY_KM = 1;
const IMPORTABLE_WAYPOINT_TYPES = new Set<Waypoint["type"]>([
  "via",
  "fuel",
  "rest",
  "photo",
]);
const PLANNER_DEFAULTS = {
  days: 3,
  dailyKmTarget: 250,
  // Revision 3 §A: 'direct' is the default road character — NOT balanced.
  roadPreference: "direct" as TripParameters["roadPreference"],
  surfacePreference: ["asphalt"] as SurfaceType[],
  minQuality: 3,
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
} as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Same map spot within ~1 m — identifies a loop route (finish placed back
 * on the start by the roundtrip draft, or by hand).
 */
function sameSpot(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): boolean {
  return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
}
const VALID_ROAD_PREFERENCES: ReadonlyArray<TripParameters["roadPreference"]> =
  ["curvy", "scenic", "mixed", "direct"];
const VALID_SURFACES: ReadonlyArray<SurfaceType> = [
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
];
const URL_PARAM_KEYS = {
  days: "days",
  dailyKm: "dailyKm",
  road: "road",
  surfaces: "surfaces",
  minQuality: "minQuality",
  avoidHighways: "avoidHighways",
  avoidTolls: "avoidTolls",
  avoidUnpaved: "avoidUnpaved",
  bbox: "bbox",
} as const;
export default function TripPlannerPage() {
  const t = useTranslation();
  const format = useFormat();
  const [importOpen, setImportOpen] = useState(false);
  // A `?import=1` deep-link request, held until the own-cap gate resolves so the
  // import opens only once we've confirmed the rider isn't (or no longer) capped.
  const [importRequestedFromUrl, setImportRequestedFromUrl] = useState(false);
  const [collaborateOpen, setCollaborateOpen] = useState(false);
  const [collabEntryUpsellOpen, setCollabEntryUpsellOpen] = useState(false);
  // Controlled "Plan as multi-day trip" disclosure — collapsed by default
  // (revision 2 §D: splitting is an optional layer most riders never
  // touch). Controlled rather than a bare `open` attribute so parent
  // re-renders can't clobber the rider's toggle.
  const [multiDayOpen, setMultiDayOpen] = useState(false);
  // Honest sizing note from the last draft (revision 2 §E): set when the
  // soft daily-km target couldn't be reached with genuinely good roads.
  const [draftNote, setDraftNote] = useState<string | null>(null);
  // Roundtrip options dialog (revision 3 §E) — opened by Draft roundtrip
  // when no finish exists, and by Recalculate roundtrip on a drafted loop.
  const [roundtripOpen, setRoundtripOpen] = useState(false);
  // Last confirmed roundtrip options: a drafted loop stays a roundtrip,
  // and recalculating starts from what the rider picked last time.
  const [lastRoundtripOpts, setLastRoundtripOpts] = useState<Pick<
    RoundtripOptions,
    "distanceKm" | "direction" | "preference"
  > | null>(null);
  // §02 collapsed summary row (revision 3 §B) — expanded inline.
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Saved user defaults (revision 3 §F): loaded once, pre-applied to
  // fresh trips, and written back (debounced) when prefs change.
  const [savedRoutePrefs, setSavedRoutePrefs] = useState<UserRoutePrefs | null>(
    null,
  );
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [travelMonth, setTravelMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  // Planner controls render with their defaults during SSR/static
  // prerender (where `window` doesn't exist) and on the client's first
  // render so the prerendered HTML and the hydrated tree always agree.
  // The post-mount effect below re-applies any values pulled from
  // `?days=…&road=…` etc., so a shared URL still lands on the right
  // panel state — just on the second client render rather than the first.
  // Explicit type params widen `PLANNER_DEFAULTS`'s `as const` literals
  // so later `setDays(params.days)` etc. with arbitrary numbers compile.
  const [days, setDays] = useState<number>(PLANNER_DEFAULTS.days);
  const [saving, setSaving] = useState(false);
  const { tier } = useEntitlements();
  // The resolved own cap. The trip-count query + full mint gate are computed
  // lower down (they depend on `isTripOwner`/`displayedTrip`); see `mintGateBlocked`.
  const { limit: maxActiveTrips, isSuccess: capResolved } =
    useLimit("max_active_trips");
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  // A proactively-shown cap prompt the rider dismissed — don't re-show it for
  // the rest of this planner session (the save-path 403 still enforces).
  const [proactiveUpgradeDismissed, setProactiveUpgradeDismissed] =
    useState(false);
  // The cap the server enforced on the mint 403 — authoritative for the modal's
  // CTA (the planner modal only ever opens from a limit rejection).
  const [upgradeModalLimit, setUpgradeModalLimit] = useState<number | null>(
    null,
  );
  const router = useRouter();
  const [dailyKmTarget, setDailyKmTarget] = useState<number>(
    PLANNER_DEFAULTS.dailyKmTarget,
  );
  // Trip-wide road character in the FIVE-value planner vocabulary
  // (revision 3 §A) — the legacy TripParameters vocabulary only exists at
  // the persistence/URL seams via to/fromTripRoadPreference.
  const [roadPreference, setRoadPreference] = useState<RoadPreference>(
    DEFAULT_ROAD_PREFERENCE,
  );
  const [surfacePreference, setSurfacePreference] = useState<SurfaceType[]>(
    () => [...PLANNER_DEFAULTS.surfacePreference],
  );
  const [minQuality, setMinQuality] = useState<number>(
    PLANNER_DEFAULTS.minQuality,
  );
  const [avoidHighways, setAvoidHighways] = useState<boolean>(
    PLANNER_DEFAULTS.avoidHighways,
  );
  const [avoidTolls, setAvoidTolls] = useState<boolean>(
    PLANNER_DEFAULTS.avoidTolls,
  );
  const [avoidUnpaved, setAvoidUnpaved] = useState<boolean>(
    PLANNER_DEFAULTS.avoidUnpaved,
  );
  const urlControlsHydratedRef = useRef(false);
  const urlRegionHydratedRef = useRef(false);
  const [plannerRegion, setPlannerRegion] = useState<RegionDrawBbox | null>(
    null,
  );
  // Live mirror of the map's region-draw state machine so the BUILD
  // column's Fun-Zone checkbox can reflect and drive it.
  const [regionDrawMode, setRegionDrawMode] = useState<RegionDrawMode>("idle");
  const [generatedOptions, setGeneratedOptions] = useState<
    GeneratedTripOption[]
  >([]);
  const [generatedOptionsSignature, setGeneratedOptionsSignature] = useState<
    string | null
  >(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  // Bumped after any flow that swaps route geometry without
  // changing `trip.id` (initial generation, regenerate, picking a
  // different generated option) so the map refits the new bounds.
  // The map's per-trip-id auto-fit suppresses these by design to
  // preserve user zoom/pan during waypoint edits (#559).
  const [fitRouteToken, setFitRouteToken] = useState(0);
  // When true, the map renders only the selected day's route so the rider
  // can focus on a single leg without other days' colors cluttering the view.
  const [focusSelectedDay, setFocusSelectedDay] = useState(false);
  // Rider can collapse the left day column to give the map more room; the
  // "Show days" map toggle brings it back. Only meaningful once days exist.
  const [showDaysColumn, setShowDaysColumn] = useState(true);
  const generationLockRef = useRef(false);
  const requestTokenRef = useRef(0);
  const isMountedRef = useRef(true);
  const activeTripRef = useRef<Trip | null>(null);
  const generatedOptionsRef = useRef<GeneratedTripOption[]>([]);
  const syncedControlsTripIdRef = useRef<string | null>(null);
  const mapRef = useRef<TripPlannerMapHandle>(null);
  const activeTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  const isGenerating = useTripStore((s) => s.isGenerating);
  const setGenerating = useTripStore((s) => s.setGenerating);
  const applyRouteResult = useTripStore((s) => s.applyRouteResult);
  const applyRouteQuality = useTripStore((s) => s.applyRouteQuality);
  const routeDirty = useTripStore((s) => s.routeDirty);
  const namesDirty = useTripStore((s) => s.namesDirty);
  const stalePreviewDays = useTripStore((s) => s.stalePreviewDays);
  const markRouteDirty = useTripStore((s) => s.markRouteDirty);
  const markDayRouteDirty = useTripStore((s) => s.markDayRouteDirty);
  const setDraftPlannerParameters = useTripStore(
    (s) => s.setDraftPlannerParameters,
  );
  // ── Multi-day store selectors ────────────────────────────────────────
  const selectedDayIndex = useTripStore((s) => s.selectedDayIndex);
  const setSelectedDay = useTripStore((s) => s.setSelectedDay);
  // Stable selector identity — the store fn is recreated each call, but
  // we select the *selected day's waypoints array* so useMemo below only fires
  // when the waypoints array actually changes (reference equality).
  const activeDayWaypoints = useTripStore(
    (s) => s.activeTrip?.days[s.selectedDayIndex]?.waypoints ?? null,
  );
  const selectedOption = useMemo(
    () =>
      generatedOptions.find((option) => option.id === selectedOptionId) ?? null,
    [generatedOptions, selectedOptionId],
  );
  const canUndo = useTripStore((s) => s.canUndo);
  const canRedo = useTripStore((s) => s.canRedo);
  const undo = useTripStore((s) => s.undo);
  const redo = useTripStore((s) => s.redo);
  const appendPlannerWaypoint = useTripStore((s) => s.appendPlannerWaypoint);
  const reorderWaypoints = useTripStore((s) => s.reorderWaypoints);
  const moveWaypoint = useTripStore((s) => s.moveWaypoint);
  const selectedPlannerSegmentId = useTripStore(
    (s) => s.selectedPlannerSegmentId,
  );
  const selectPlannerSegment = useTripStore((s) => s.selectPlannerSegment);
  const insertWaypointBefore = useTripStore((s) => s.insertWaypointBefore);
  const removeWaypointById = useTripStore((s) => s.removeWaypointById);
  const splitStatus = useTripStore((s) => s.splitStatus);
  const planningMode = useTripStore((s) => s.planningMode);
  const setPlanningMode = useTripStore((s) => s.setPlanningMode);
  const dayPlans = useTripStore((s) => s.dayPlans);
  const applySplit = useTripStore((s) => s.applySplit);
  const renameWaypoint = useTripStore((s) => s.renameWaypoint);
  const insertWaypointBeforeEnd = useTripStore(
    (s) => s.insertWaypointBeforeEnd,
  );
  const displayedTrip = activeTrip ?? selectedOption?.trip ?? null;
  // Header meta parity with the trip preview (days · length · time ·
  // members): loaded trips carry member_count; an unsaved draft is just
  // the rider, so it honestly reads "1 member".
  const headerMemberCount = displayedTrip
    ? (displayedTrip.member_count ??
      Math.max(1, displayedTrip.collaborators?.length ?? 0))
    : null;
  // ── Live routing (Task 11) ────────────────────────────────────────
  // Memoize both inputs so the hook's effect only re-fires when the
  // actual data changes — not on every parent render.
  // We derive the routing waypoints directly from `activeDayWaypoints`
  // (the store selector above) so this memo is driven by the waypoints
  // array reference rather than by calling `getState()` inside render.
  const routingWaypoints = useMemo(() => {
    if (!activeDayWaypoints)
      return [] as { id: string; lat: number; lng: number }[];
    // Normalize a terminal accommodation (generated overnight) to the day's
    // finish FIRST — the same transform saveDays applies — so the live preview
    // routes start→overnight and matches what the backend persists. Without
    // this, an accommodation-terminated day has <2 routing points (its preview
    // can't refresh / clear stale) yet Save would persist an unpreviewed route.
    return filterRoutingWaypoints(normalizeDayFinish(activeDayWaypoints)).map(
      (w) => ({
        id: w.id,
        lat: w.location.lat,
        lng: w.location.lng,
      }),
    );
  }, [activeDayWaypoints]);
  const routeOptions = useMemo(
    () => ({
      // Avoids are independent hard constraints layered on top of ANY
      // road preference (revision 3 §A).
      avoid_highways: avoidHighways,
      avoid_tolls: avoidTolls,
      avoid_unpaved: avoidUnpaved,
      // Reserved fields today (backend ignores them), sent anyway so the
      // client is already correct when routing gains quality/surface
      // costing — and so pref changes alter the request, re-firing the
      // live-routing hook via its options dependency.
      surfaces: surfacePreference,
      prefer_quality: minQuality >= 3,
      // Trip-wide road character (revision 3 §A) — per-leg overrides
      // replace this on their own leg's request below. 'efficient_loop'
      // costs like the engine default, same as 'direct'.
      preference: roadPreference,
    }),
    [
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      surfacePreference,
      minQuality,
      roadPreference,
    ],
  );
  // ── Per-leg road filters (revision 3 §C) ───────────────────────────
  // Overrides keyed by waypoint identity, stored PER DAY: reconciliation
  // (which re-inherits broken pairs) must only ever run a day's legs
  // against that day's own spine — switching the selected day is not a
  // spine edit, so it must not discard another day's overrides.
  const [legPrefsByDay, setLegPrefsByDay] = useState<Record<number, LegPref[]>>(
    {},
  );
  const legPrefs = legPrefsByDay[selectedDayIndex] ?? EMPTY_LEG_PREFS;
  useEffect(() => {
    const ids = routingWaypoints.map((w) => w.id);
    setLegPrefsByDay((previous) => {
      const current = previous[selectedDayIndex] ?? EMPTY_LEG_PREFS;
      const next = reconcileLegPrefs(current, ids);
      return next.length === current.length &&
        next.every(
          (leg, i) =>
            leg.fromWaypointId === current[i]!.fromWaypointId &&
            leg.toWaypointId === current[i]!.toWaypointId &&
            leg.preference === current[i]!.preference,
        )
        ? previous
        : { ...previous, [selectedDayIndex]: next };
    });
  }, [routingWaypoints, selectedDayIndex]);
  const handleChangeLegPref = useCallback(
    (fromWaypointId: string, preference: LegPref["preference"]) => {
      setLegPrefsByDay((previous) => ({
        ...previous,
        [selectedDayIndex]: (previous[selectedDayIndex] ?? []).map((leg) =>
          leg.fromWaypointId === fromWaypointId ? { ...leg, preference } : leg,
        ),
      }));
      // A leg's road character is a routing input for THIS day only —
      // staling every day would wedge the Save gate on days the live
      // hook never revisits.
      markDayRouteDirty(selectedDayIndex);
    },
    [markDayRouteDirty, selectedDayIndex],
  );
  // Per-leg routing requests (revision 3 §C): each consecutive pair is
  // requested with its EFFECTIVE preference; the hook concatenates the
  // responses back into one route tagged with leg breaks.
  const routingLegs = useMemo<PlannerRoutingLeg[]>(() => {
    if (routingWaypoints.length < 2) return [];
    const legs = reconcileLegPrefs(
      legPrefs,
      routingWaypoints.map((w) => w.id),
    );
    return legs.map((leg, index) => {
      const from = routingWaypoints[index]!;
      const to = routingWaypoints[index + 1]!;
      const effective = effectiveLegPreference(leg, roadPreference);
      return {
        legId: legPairId(leg.fromWaypointId, leg.toWaypointId),
        from: { lat: from.lat, lng: from.lng },
        to: { lat: to.lat, lng: to.lng },
        options: {
          ...routeOptions,
          preference: effective === "efficient_loop" ? "direct" : effective,
        },
      };
    });
  }, [routingWaypoints, legPrefs, routeOptions, roadPreference]);
  // Gate live routing: only route when the selected day is stale (has
  // unsent edits since last applyRouteResult) AND the route is dirty.
  // This prevents an existing saved trip from being silently re-routed
  // on open before any edits, and restricts routing to the selected day.
  //
  // Phase 2 note: when the rider switches to a stale neighbor day, that
  // day's staleness was set by a prior edit-cascade — the routing hook
  // fires automatically because `selectedDay.dayNumber` appears in
  // `stalePreviewDays`. This is the intended behavior for phase 2.
  const selectedDay = activeTrip?.days[selectedDayIndex] ?? null;
  // ── Plan & inspect panel: tab state + bidirectional panel↔map wiring ──
  const [panelTab, setPanelTab] = useState<PlannerTab>("BUILD");
  // Day column selection — scopes the INSPECT tab to one DayPlan.
  const [selectedPlanIndex, setSelectedPlanIndex] = useState<number | null>(
    null,
  );
  // A route-section click on the map opens its Road Preview; surface the
  // matching panel context too so the flagged-card highlight is visible.
  useEffect(() => {
    if (selectedPlannerSegmentId) setPanelTab("INSPECT");
  }, [selectedPlannerSegmentId]);
  useEffect(() => {
    // Start (and re-split) with no day selected so every tab — and the map —
    // opens on the whole route; the rider explicitly picks a day to drill in.
    // "Focus day" stays disabled (with a hint) until then, so it can't
    // silently focus an unpicked day 1.
    setSelectedPlanIndex(null);
  }, [dayPlans]);
  // An interactive split on a single, not-yet-materialized day: days = [whole
  // route], dayPlans = the slices. Until `materializeSplit()` runs on save,
  // `displayedTrip.days` still holds only the original whole-route day, so the
  // per-day surfaces (cards, map focus, conditions/stops) can't read a real
  // per-day TripDay — they fall back to the DayPlan (segmentIds/towns) instead.
  const splitOnSingleDay =
    (displayedTrip?.days.length ?? 0) === 1 && (dayPlans?.length ?? 0) > 1;
  // Left day column reuses the preview's rich "Day-by-day" cards. The card
  // count follows the split (`dayPlans`); each card's content comes from the
  // index-aligned saved day (`displayedTrip.days[i]`, the rich TripDay) when
  // it exists, otherwise a light projection of the DayPlan. During an
  // unmaterialized split `days[0]` is still the whole route, so every card
  // (including day 1) projects from its DayPlan instead of that shared day.
  const dayCards = useMemo<TripDay[]>(() => {
    if (!dayPlans) return [];
    return dayPlans.map((plan, index) => {
      const savedDay = splitOnSingleDay
        ? undefined
        : displayedTrip?.days[index];
      if (savedDay) return savedDay;
      const startLabel = dayPlanBoundaryDisplayName(
        plan.startTown,
        plan.startNameIsSource,
        plan.startPoiCategory,
        "start",
        t,
      );
      const endLabel = dayPlanBoundaryDisplayName(
        plan.endTown,
        plan.endNameIsSource,
        plan.endPoiCategory,
        "end",
        t,
      );
      return {
        dayNumber: plan.dayNumber,
        title: t("{start} → {end}", {
          start: startLabel,
          end: endLabel,
        }),
        waypoints: [],
        distanceKm: plan.distanceKm,
        durationMinutes: plan.timeMin ?? 0,
        elevationGain: 0,
        avgQuality: plan.quality.score ?? 0,
      };
    });
  }, [dayPlans, displayedTrip, splitOnSingleDay, t]);
  // The day-view selection (card highlight + map day focus) is explicit and
  // nullable: day 1 is preselected on load, and clicking the active day
  // deselects it (all days shown again).
  const selectedCardDayNumber =
    selectedPlanIndex != null
      ? (dayPlans?.[selectedPlanIndex]?.dayNumber ?? null)
      : null;
  const handleSelectDayCard = useCallback(
    (dayNumber: number) => {
      if (!dayPlans) return;
      const planIndex = dayPlans.findIndex((p) => p.dayNumber === dayNumber);
      if (planIndex < 0) return;
      // Toggle — clicking the already-selected day deselects it, back to the
      // whole-route view. Realign the store's placement/edit target to day 1
      // so the map's context-menu endpoints (which fall back to day 1 when no
      // day is selected) match where a newly placed waypoint actually lands.
      if (selectedPlanIndex === planIndex) {
        setSelectedPlanIndex(null);
        setSelectedDay(0);
        return;
      }
      setSelectedPlanIndex(planIndex);
      setPanelTab("INSPECT");
      // Loaded multi-day trips: the card also selects the real day (drives
      // per-day live routing + preview).
      if (activeTrip && planIndex < activeTrip.days.length) {
        setSelectedDay(planIndex);
      }
    },
    [dayPlans, activeTrip, setSelectedDay, selectedPlanIndex],
  );
  // ── Tab scoping: INSPECT / CONDITIONS / STOPS follow the day-view pick.
  // No day selected → whole route; a day selected → that day only.
  const daySelected = selectedCardDayNumber != null;
  // The selected, materialized day's rich TripDay (null for the whole-route
  // view or an unmaterialized split slice).
  const selectedTripDay =
    daySelected && !splitOnSingleDay && selectedPlanIndex != null
      ? (displayedTrip?.days[selectedPlanIndex] ?? null)
      : null;
  // INSPECT input: the selected day's own route (materialized), the whole
  // single route + a DayPlan scope (unmaterialized split), or the all-days
  // aggregate (whole route). A loaded day's split DayPlan has empty segmentIds
  // and would filter every segment out, so materialized days carry no plan.
  const inspectDay = useMemo<TripDay | null>(() => {
    const days = displayedTrip?.days ?? [];
    if (!daySelected) return aggregateInspectDay(days);
    if (splitOnSingleDay) return days[0] ?? null;
    return selectedTripDay;
  }, [displayedTrip, daySelected, splitOnSingleDay, selectedTripDay]);
  const inspectPlan =
    daySelected && splitOnSingleDay && selectedPlanIndex != null
      ? (dayPlans?.[selectedPlanIndex] ?? null)
      : null;
  // Road-segment detail drawer (reviews + history), shared with the road
  // explorer. Opens when an inspected span resolves to a real road_segment id.
  const [selectedRoadSegmentId, setSelectedRoadSegmentId] = useState<
    string | null
  >(null);
  const [segmentDetailState, setSegmentDetailState] =
    useState<SegmentDetailPanelState>({ status: "idle" });
  // INSPECT card → focus the segment on the map, opening its Road Preview
  // popover (an on-route segment). The full history+reviews drawer is reached
  // from that popover's "Full history & reviews" button, or by tapping an
  // off-route mapped segment — never straight from here, so the two never
  // stack on screen.
  const handleInspectSegment = useCallback(
    (segmentId: string) => {
      selectPlannerSegment(segmentId);
      mapRef.current?.flyToSegment(segmentId);
    },
    [selectPlannerSegment],
  );
  useEffect(() => {
    if (!selectedRoadSegmentId) {
      // Bail out without a new object when already idle, so the initial mount
      // (segment unselected) doesn't force an extra render.
      setSegmentDetailState((prev) =>
        prev.status === "idle" ? prev : { status: "idle" },
      );
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSegmentDetailState({
      status: "loading",
      segmentId: selectedRoadSegmentId,
    });
    roadsApi
      .getSegmentDetail(selectedRoadSegmentId, { signal: controller.signal })
      .then(({ data }) => {
        if (!cancelled)
          setSegmentDetailState({ status: "ready", segment: data });
      })
      .catch((err: unknown) => {
        if (cancelled || (err as { name?: string }).name === "AbortError") {
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setSegmentDetailState({
            status: "not-found",
            segmentId: selectedRoadSegmentId,
          });
          return;
        }
        setSegmentDetailState({
          status: "error",
          segmentId: selectedRoadSegmentId,
          message: getUserFacingErrorMessage(err, t("Failed to load segment")),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [t, selectedRoadSegmentId]);
  // Shared with the map's Road Preview reroute: arm a one-shot animated
  // fit for whenever the rerouted line lands.
  const armFitAfterRoute = useCallback(() => {
    fitAfterRouteRef.current = true;
  }, []);
  // On-route condition cards (revision 7): the tab's REROUTE buttons run
  // the same via-insert as the marker popover, then glide back to the
  // whole route once the new line lands.
  const handleRerouteClosure = useCallback(
    (closure: PlannerClosure) => {
      const anchor = closure.geometry[0];
      if (!anchor) return;
      const done = rerouteAroundConditionInTrip(
        activeTripRef.current,
        { id: closure.id, location: anchor, line: closure.geometry },
        insertWaypointBefore,
      );
      if (done) fitAfterRouteRef.current = true;
    },
    [insertWaypointBefore],
  );
  const handleReroutePass = useCallback(
    (pass: MountainPassSummary) => {
      const done = rerouteAroundConditionInTrip(
        activeTripRef.current,
        { id: pass.id, location: { lng: pass.lng, lat: pass.lat } },
        insertWaypointBefore,
      );
      if (done) fitAfterRouteRef.current = true;
    },
    [insertWaypointBefore],
  );
  const handleRerouteSegment = useCallback(
    (segmentId: string) => {
      const trip = activeTripRef.current;
      const segment = findPlannerQualitySegment(trip, segmentId);
      if (segment) {
        rerouteAroundSegmentInTrip(trip, segment, insertWaypointBefore);
        // The rider is often zoomed into the flagged segment they just
        // rerouted away from — animate back to the whole route once the
        // new line lands so they keep the overview.
        fitAfterRouteRef.current = true;
      }
      selectPlannerSegment(null);
    },
    [insertWaypointBefore, selectPlannerSegment],
  );
  // ── Phase 2: on-demand day split (addendum §4/§5) ──
  // Daily km is the primary input; a day count is an OPTIONAL override.
  const [forcedDays, setForcedDays] = useState<number | null>(null);
  const [splitting, setSplitting] = useState(false);
  // Whether the last applied split derived its ids from real quality (vs the
  // geometry-only baseline). Drives the one-shot resync effect below.
  const splitBasisHadQualityRef = useRef(false);
  const handleSplit = useCallback(async () => {
    const trip = activeTripRef.current;
    // Splitting operates on the SINGLE working route only. A loaded
    // multi-day trip already carries materialized days: splitting just
    // day 1 would replace the day column with a wrong itinerary that
    // materializeSplit() refuses to persist. (The auto-resplit effect
    // and re-split buttons are gated too — this is the backstop.)
    if (trip && trip.days.length > 1) return;
    const routeDay = trip?.days[0];
    const coordinates = routeDay?.routeGeometry?.coordinates;
    if (!routeDay || !coordinates || coordinates.length < 2) {
      toast.error(t("Build a route first — the splitter needs a routed line."));
      return;
    }
    setSplitting(true);
    try {
      const segments = deriveDayQualitySegments(routeDay);
      // routeGeometry is present (checked above), so this mirrors what
      // deriveDayQualitySegments used: real quality iff the day carries it.
      splitBasisHadQualityRef.current =
        (routeDay.qualitySegments?.length ?? 0) > 0;
      const totalKm = routeDay.distanceKm;
      const targets = rawBreakTargetKms(
        totalKm,
        dailyKmTarget,
        forcedDays,
        useTripStore.getState().pinnedBreakKms,
      );
      // Overnight-town candidates near each raw break (real POI endpoint);
      // a failed fetch just means breaks land at raw distances.
      const towns = await fetchOvernightTowns(coordinates, targets).catch(
        () => [],
      );
      const plans = splitIntoDays(
        segments,
        {
          dailyKmTarget,
          forcedDays,
          totalTimeMin: routeDay.durationMinutes,
        },
        towns,
        useTripStore.getState().pinnedBreakKms,
        format,
        t,
      );
      if (plans.length === 0) {
        toast.error(t("Could not split this route into days."));
        return;
      }
      applySplit(plans);
    } finally {
      setSplitting(false);
    }
  }, [t, applySplit, dailyKmTarget, forcedDays, format]);
  // Changing the DAY CONTROLS while split means "recompute now" — route
  // and pref edits, by contrast, only mark the split stale (§5).
  const splitInputsRef = useRef({ dailyKmTarget, forcedDays });
  useEffect(() => {
    const previous = splitInputsRef.current;
    splitInputsRef.current = { dailyKmTarget, forcedDays };
    if (splitStatus !== "split") return;
    if (
      previous.dailyKmTarget === dailyKmTarget &&
      previous.forcedDays === forcedDays
    ) {
      return;
    }
    void handleSplit();
  }, [dailyKmTarget, forcedDays, splitStatus, handleSplit]);
  // Real quality can land AFTER a split was computed on the geometry-only
  // baseline — the rider hit Split within the fetch window, or quality resolved
  // while handleSplit was still awaiting overnight towns (before splitStatus
  // flipped to "split"). deriveDayQualitySegments then switches from baseline
  // slice ids to real span ids, orphaning the plans' captured `segmentIds`
  // (InspectTab scopes its strip by them). handleSplit records whether it split
  // on real quality; resync once when it didn't and quality has since arrived.
  // Keying on that flag (not a quality-value transition) is robust to quality
  // landing before splitStatus flips. Single working-day split only.
  const workingDayQuality = activeTrip?.days[0]?.qualitySegments;
  useEffect(() => {
    if (splitStatus !== "split") return;
    if (splitBasisHadQualityRef.current) return;
    if (!workingDayQuality || workingDayQuality.length === 0) return;
    splitBasisHadQualityRef.current = true; // handled — don't re-fire
    void handleSplit();
  }, [workingDayQuality, splitStatus, handleSplit]);
  // When a trip arrives already split (saved multi-day trip, planner
  // reopened), surface the multi-day section so its controls are in
  // view. Only fires on status transitions — a rider's manual collapse
  // while split stays collapsed.
  useEffect(() => {
    if (splitStatus !== "none") setMultiDayOpen(true);
  }, [splitStatus]);
  // Day-break markers for the map — one per split boundary (not the finish).
  const dayBreakMarkers = useMemo(() => {
    if (splitStatus === "none" || !dayPlans || dayPlans.length < 2) return [];
    const trip = displayedTrip;
    // Working-day model only: a loaded multi-day trip has per-day geometry
    // and draws its own boundaries via the waypoint markers.
    const coordinates =
      trip && trip.days.length === 1
        ? trip.days[0]?.routeGeometry?.coordinates
        : undefined;
    if (!coordinates || coordinates.length < 2) return [];
    return dayPlans.slice(0, -1).flatMap((plan) => {
      const at = coordinateAtKm(coordinates, plan.endKm);
      return at
        ? [
            {
              lng: at.lng,
              lat: at.lat,
              label: dayPlanBoundaryDisplayName(
                plan.endTown,
                plan.endNameIsSource,
                plan.endPoiCategory,
                "end",
                t,
              ),
              pinned: plan.breakPinned === true,
            },
          ]
        : [];
    });
  }, [splitStatus, dayPlans, displayedTrip, t]);
  // Unnamed non-POI pins and legacy auto-generated names are reverse-geocoded
  // to a real place name once per placement (addendum §2). POI pins keep their
  // semantic category fallback instead of turning a generated address into a
  // custom name.
  const reverseGeocodedRef = useRef(new Set<string>());
  useEffect(() => {
    const seen = reverseGeocodedRef.current;
    const waypoints = selectedDay?.waypoints ?? [];
    const needsPlaceName = (
      waypoint: Pick<Waypoint, "name" | "nameIsSource" | "poiCategory">,
    ) =>
      !waypoint.poiCategory &&
      !waypoint.nameIsSource &&
      (!waypoint.name?.trim() || isLegacyGeneratedWaypointName(waypoint.name));
    const keyFor = (w: {
      id: string;
      location: { lat: number; lng: number };
    }) => `${w.id}:${w.location.lat.toFixed(4)}:${w.location.lng.toFixed(4)}`;
    for (const waypoint of waypoints) {
      if (!needsPlaceName(waypoint)) continue;
      const key = keyFor(waypoint);
      // Fire once per (waypoint, position) ever. We deliberately do NOT abort +
      // re-issue on cleanup: with several default-named waypoints, the first
      // rename changes `selectedDay`, and re-firing the others would re-send
      // their already-dispatched upstream requests — costly against public
      // Nominatim (1 req/s). Staleness is handled at apply time instead.
      if (seen.has(key)) continue;
      seen.add(key);
      void plannerApi
        .reverseGeocode(waypoint.location.lat, waypoint.location.lng, {
          format,
        })
        .then((placeName) => {
          if (!placeName) return;
          // Apply only if the waypoint still exists at the same position and
          // still carries an auto-generated name — i.e. the rider hasn't
          // moved/renamed it and no earlier response already named it. A moved
          // waypoint gets its own fresh key + lookup; this stale one is dropped.
          const current = useTripStore
            .getState()
            .activeTrip?.days.flatMap((d) => d.waypoints)
            .find((w) => w.id === waypoint.id);
          if (current && keyFor(current) === key && needsPlaceName(current)) {
            renameWaypoint(waypoint.id, placeName);
          }
        })
        .catch(() => {
          // Naming is cosmetic — keep the default label on failure.
        });
    }
  }, [selectedDay, renameWaypoint, format]);
  // Dropping a day-break marker pins that break at the drop's along-route
  // km and re-splits the surrounding days around it (addendum §6).
  const handleMoveDayBreak = useCallback(
    (boundary: number, location: { lng: number; lat: number }) => {
      const trip = activeTripRef.current;
      const plans = useTripStore.getState().dayPlans;
      const coordinates =
        trip && trip.days.length === 1
          ? trip.days[0]?.routeGeometry?.coordinates
          : undefined;
      if (!coordinates || !plans || boundary < 1 || boundary > plans.length - 1)
        return;
      const droppedKm = kmAlongRouteAt(coordinates, location);
      const movedBreakKm = plans[boundary - 1]?.endKm ?? null;
      if (movedBreakKm === null || droppedKm <= 0) return;
      // Keep every OTHER existing pin; the moved boundary re-pins at the
      // drop. Unpinned breaks recompute around the pins on re-split.
      const otherPins = useTripStore
        .getState()
        .pinnedBreakKms.filter((km) => Math.abs(km - movedBreakKm) > 1);
      useTripStore
        .getState()
        .setPinnedBreaks([...otherPins, Math.round(droppedKm * 10) / 10]);
      void handleSplit();
    },
    [handleSplit],
  );
  const liveRouteEnabled =
    routeDirty &&
    selectedDay !== null &&
    stalePreviewDays.includes(selectedDay.dayNumber);
  // Set by the draft flows: the next live-routing result represents a
  // freshly built route, so the map should zoom to fit it.
  const fitAfterRouteRef = useRef(false);
  const handleRouteResult = useCallback(
    (
      result: Parameters<typeof applyRouteResult>[1],
      legBreaks: TripLegBreak[],
      requestDayNumber: number | null,
    ) => {
      // Apply geometry to the day the request was FIRED for (passed back by the
      // hook), not the live `selectedDay` — the rider may have switched tabs
      // before this response resolved, which would otherwise corrupt the
      // now-current day and clear its stale flag.
      if (requestDayNumber == null) return;
      // Fit when a route is BUILT (the day had no routed line yet, or a
      // draft just replaced it) — but never on ordinary edits, which
      // must preserve the rider's zoom/pan (#559).
      const day = activeTripRef.current?.days.find(
        (d) => d.dayNumber === requestDayNumber,
      );
      const hadGeometry = Boolean(day?.routeGeometry?.coordinates?.length);
      applyRouteResult(requestDayNumber, result, legBreaks);
      if (!hadGeometry || fitAfterRouteRef.current) {
        fitAfterRouteRef.current = false;
        setFitRouteToken((token) => token + 1);
      }
    },
    [applyRouteResult],
  );
  const { routing } = usePlannerRouting(
    routingLegs,
    handleRouteResult,
    (msg: string) => toast.error(msg),
    liveRouteEnabled,
    selectedDay?.dayNumber ?? null,
  );
  // Real per-segment quality (#862): hydrate every routed day the map can draw.
  // Shared with the read-only saved-trip detail view via this hook.
  useRouteQualityHydration(activeTrip, applyRouteQuality);
  // ── Collab session wiring (US-35) ─────────────────────────────────
  // `?tripId=<uuid>` on the URL activates the collab surface: the
  // socket joins `trip:<id>`, cursors + suggestions + activity start
  // flowing, and the Suggestions / Activity tabs in the modal light up.
  const [serverTripId, setServerTripId] = useState<string | null>(null);
  // New-trip session (create/import) vs an existing-trip edit, decided from the
  // URL's `?tripId=`. Starts "unknown" — the SAME value on the server prerender
  // and the first client render, so it can't cause a hydration mismatch on the
  // gated `disabled` attributes — and is reconciled AFTER mount by the `?tripId`
  // effect below (reading the URL there keeps the page prerenderable). "unknown"
  // fails closed (treated as a mint context) so the first paint blocks minting
  // rather than briefly enabling it for a capped rider.
  const [sessionKind, setSessionKind] = useState<
    "unknown" | "new" | "existing"
  >("unknown");
  const isNewTripSession = sessionKind === "new";
  const [serverTripOwnerId, setServerTripOwnerId] = useState<string | null>(
    null,
  );
  const [serverTripCallerRole, setServerTripCallerRole] = useState<
    TripDetailMember["role"] | null
  >(null);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const canCreateInviteLink =
    !serverTripId ||
    serverTripCallerRole === "owner" ||
    serverTripCallerRole === "editor";
  // Metadata (title, planner parameters) is owner/editor-only on the
  // backend. Viewers must not be
  // offered metadata edits that would silently revert — and while a
  // PERSISTED trip's role is still loading, stay locked too: treating
  // that window as editable would let a member queue a metadata PATCH
  // that fails after the route already committed. Unsaved local trips
  // have no role to wait for.
  const canEditTripMetadata =
    !serverTripId ||
    serverTripCallerRole === "owner" ||
    serverTripCallerRole === "editor";
  // Route writes (PUT /trips/:id/route) are editor+ on the backend too;
  // don't let a viewer build a route locally only to 403 on Save.
  const canWriteRoute =
    !serverTripId ||
    serverTripCallerRole === "owner" ||
    serverTripCallerRole === "editor";
  // Header-button gating for a SAVED trip (mirrors the preview page):
  //  - owner: Collaborate + Discard (delete)
  //  - editor/viewer: Suggestions + Leave, no Discard
  // Unsaved local drafts have no server owner, so the local rider owns
  // everything until they save.
  const isSavedTrip = Boolean(serverTripId);
  const isTripOwner = !isSavedTrip || serverTripCallerRole === "owner";
  // C2 — `collaborative_trips` (Pro) gates the Collaborate ENTRY for a PERSISTED
  // trip, not just the invite controls inside the modal: opening it would let
  // the owner reach the share/invite actions that fire a raw persisted-trip 403
  // when the toggle is off. Gate only when RESOLVED-and-disabled so a Pro
  // owner's brief unresolved window (or a lookup error) still opens the modal —
  // its own internal gates fail closed on the actual share/invite there. Unsaved
  // drafts are carved out (nothing is persisted to share yet).
  const { enabled: collabTripsEnabled, isSuccess: collabTripsResolved } =
    useFeature("collaborative_trips");
  const collabEntryBlocked =
    isSavedTrip && collabTripsResolved && !collabTripsEnabled;
  const isCollaborator =
    isSavedTrip &&
    (serverTripCallerRole === "editor" || serverTripCallerRole === "viewer");
  // Proactive own-cap gate for a planner session reached DIRECTLY (bookmark,
  // address bar, stale tab) — bypassing the /trips header block. A save mints
  // against the rider's OWN cap in two contexts: a brand-new trip, and an OWNER
  // reopening their own COMPLETED trip (the backend treats saving a route onto
  // a completed trip as a completed→planned promotion → assertCanMintOpenTrip).
  // Ordinary open-trip edits mint nothing and are never gated; a collaborator
  // editing someone else's trip can't know the owner's count, so it's left to
  // the save-path 403.
  // For a saved trip we can only decide the mint context once the caller ROLE
  // has loaded (it resolves together with the trip's status from tripsApi.get);
  // until then, fail closed — a completed-trip reopen by the owner would mint.
  const savedTripResolved = serverTripCallerRole !== null;
  const isOwnMintContext =
    // Session kind not yet reconciled (first paint) → fail closed: treat it as a
    // possible mint context so minting stays blocked until we know otherwise.
    sessionKind === "unknown" ||
    (isNewTripSession && !isSavedTrip) ||
    // Saved trip whose role/status hasn't loaded → unknown, fail closed.
    (isSavedTrip && !savedTripResolved) ||
    // Owner reopening their own COMPLETED trip → save promotes it → mints.
    (isSavedTrip && isTripOwner && displayedTrip?.status === "completed");
  // Only fetch the (unpaginated, geospatial) trips list when the COUNT is
  // actually needed: a mint context under a resolved FINITE cap. Cap-unknown
  // fails closed without the count; an unlimited cap needs no count; a
  // non-mint/edit context needs none either.
  const needsTripCount =
    isOwnMintContext && capResolved && maxActiveTrips !== null;
  const {
    trips: ownedTrips,
    loading: ownedTripsLoading,
    error: ownedTripsError,
  } = useUserTrips({ enabled: needsTripCount });
  const atFiniteTripCap =
    needsTripCount &&
    maxActiveTrips !== null &&
    !ownedTripsLoading &&
    !ownedTripsError &&
    countOpenOwnedTrips(ownedTrips, currentUserId) >= maxActiveTrips;
  // The mint gate is ACTIVE — block the mint controls, fail closed — whenever,
  // in an own-mint context, we cannot PROVE the rider is under a finite cap:
  //  - cap not yet resolved (auth-hydration delay / entitlement error) → unknown
  //  - finite cap but the count is unknown (trips query loading/errored)
  //  - finite cap and the count is at/over it
  // This mirrors the /trips header's fail-closed behaviour with a neutral
  // disabled state (no tier is needed to disable, unlike the modal below).
  const mintGateBlocked =
    isOwnMintContext &&
    (!capResolved ||
      (needsTripCount && (ownedTripsLoading || ownedTripsError)) ||
      atFiniteTripCap);
  // The informative upgrade modal shows only when we CONFIRM a finite cap is
  // met (never on a mere unknown — that would claim a limit we can't verify).
  const showProactiveUpgrade = atFiniteTripCap && !proactiveUpgradeDismissed;
  // A viewer opening the edit URL for a saved trip has no business here —
  // the backend 403s their writes. Show an access screen once the role
  // resolves rather than a functional-looking editor.
  const isViewerOnSavedTrip = isSavedTrip && serverTripCallerRole === "viewer";
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const handleLeaveTrip = useCallback(async () => {
    if (!serverTripId) return;
    setConfirmLeaveOpen(false);
    setLeaving(true);
    try {
      await tripCollabApi.leaveTrip(serverTripId);
      router.push("/trips");
    } catch {
      setLeaving(false);
    }
  }, [serverTripId, router]);
  // Live-edit reaction (US-35): another collaborator's import /
  // regenerate / mutation comes in over the socket as `trip:updated`,
  // and we re-hydrate the local planner state from the broadcast
  // payload (it's a full `TripDetailDto`). Skipped when the local
  // `activeTrip` already has the same id and identical contents to
  // avoid clobbering in-flight optimistic edits the local user is
  // making — the canonical state is whatever the backend just
  // committed, but we still want to debounce trivial echoes.
  const handleRemoteTripUpdated = useCallback(
    (payload: unknown) => {
      const detail = payload as TripDetailResponse;
      if (!detail || typeof detail.id !== "string") return;
      // Only react if the planner is currently focused on the trip the
      // event is for. The hook already filters but a defensive check
      // here covers a future change in subscription scope.
      if (detail.id !== serverTripId) return;
      const hydrated = withRequestOnlyRouteOptions(tripFromDetail(detail), {
        surfacePreference,
        avoidHighways,
        avoidTolls,
        avoidUnpaved,
      });
      setActiveTrip(hydrated);
      setServerTripOwnerId(findOwnerId(detail));
      setServerTripCallerRole(findCallerRole(detail, currentUserId));
      // Mirror the REST hydration path below: the planner's control
      // strip is local React state, NOT derived from `activeTrip`, so a remote
      // regenerate that changed persisted values such as `num_days` would
      // otherwise leave those controls stale. Surface / avoid values are
      // request-only, so `hydrated` deliberately carries this rider's current
      // choices instead of adapter defaults.
      const params = hydrated.parameters;
      setDays(params.days);
      setDailyKmTarget(params.dailyKmTarget);
      setRoadPreference(fromTripRoadPreference(params.roadPreference));
      setSurfacePreference(params.surfacePreference);
      setMinQuality(params.minQuality);
      setAvoidHighways(params.avoidHighways);
      setAvoidTolls(params.avoidTolls);
      setAvoidUnpaved(params.avoidUnpaved);
      // State synchronization, not a rider edit — never write it back as a
      // new set of rider defaults (§F).
      prefsTouchedRef.current = false;
    },
    [
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      currentUserId,
      serverTripId,
      setActiveTrip,
      surfacePreference,
    ],
  );
  const handleRemoteTripDeleted = useCallback(() => {
    // Owner deleted the trip out from under everyone. Drop local trip
    // state and the collab session so the planner falls back to a
    // blank canvas — any further interaction would 404 anyway.
    setActiveTrip(null);
    setServerTripId(null);
    setServerTripOwnerId(null);
    setServerTripCallerRole(null);
    setGeneratedOptions([]);
    setGeneratedOptionsSignature(null);
    setSelectedOptionId(null);
  }, [setActiveTrip]);
  const collabSession = useTripCollabSession(serverTripId, {
    onTripUpdated: handleRemoteTripUpdated,
    onTripDeleted: handleRemoteTripDeleted,
  });
  useEffect(() => {
    // `?import=1` is the /trips "Import GPX" entry point: open the import
    // dialog on arrival and strip the param so a reload (or the planner's
    // own URL sync) doesn't re-trigger it. Same client-only pattern as the
    // `?tripId=` effect below.
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("import") !== "1") return;
    // Defer opening until the cap gate resolves (see the effect near
    // `openImport`) instead of opening unconditionally — a direct import URL
    // must not bypass the mint block for a capped/unknown-cap rider.
    setImportRequestedFromUrl(true);
    url.searchParams.delete("import");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  useEffect(() => {
    // Read `?tripId=` in a client-only effect to keep the planner page
    // statically prerenderable. `useSearchParams` would pull the whole
    // tree into the dynamic render path.
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("tripId");
    // Reconcile the new-vs-existing session kind now that we can read the URL
    // (see `sessionKind` above) — resolves the fail-closed "unknown" first paint.
    setSessionKind(fromUrl ? "existing" : "new");
    if (fromUrl) {
      // Skip the no-op null→null setState path so we don't burn an extra
      // render cycle through the planner's downstream data hooks
      // (useClosures/usePasses).
      setServerTripId(fromUrl);
      return;
    }
    // No `?tripId=` is the "new trip" entry point. `activeTrip` lives in a
    // shared store with no unmount cleanup, so a saved trip opened/edited
    // earlier in the session lingers and create-new would otherwise reopen
    // that stale route. Drop a lingering *persisted* trip (UUID id) so the
    // canvas starts blank, regardless of how the rider reached the planner
    // (a CTA, a bookmark, or the address bar). An in-memory draft
    // (`planner-*`/`imported-*`) is the rider's working state — and survives
    // a round-trip out to the trip list and back — so it's left intact.
    if (activeTrip && UUID_RE.test(activeTrip.id)) {
      // Mark the stale trip as already control-synced first. The
      // `activeTrip`→controls effect below runs later in this same mount
      // while `activeTrip` is still the stale value; without this it would
      // copy the dropped trip's days/km/road/surface/avoid into the controls
      // (and then the URL) before the null update lands, so the new-trip
      // canvas would blank but inherit the last trip's settings.
      syncedControlsTripIdRef.current = activeTrip.id;
      setActiveTrip(null);
    }
    // Mount-only reconciliation against the initial URL. The `activeTrip`
    // snapshot read here is intentionally the mount-time value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!serverTripId) {
      setServerTripOwnerId(null);
      setServerTripCallerRole(null);
      return;
    }
    // Mirrors the gate on `/trips/:id` and `/settings/subscription`:
    // wait for the auth store to carry a token so the trip fetch on
    // a hard navigation to `/trips/planner?tripId=...` doesn't race
    // AuthSync and silently land as a 401 (the catch swallows errors
    // and the canvas would render empty).
    if (!authReady) {
      setServerTripCallerRole(null);
      return;
    }
    let cancelled = false;
    setServerTripCallerRole(null);
    (async () => {
      try {
        const { data } = await tripsApi.get(serverTripId);
        if (cancelled) return;
        const detail = data as unknown as TripDetailResponse;
        setServerTripOwnerId(findOwnerId(detail));
        setServerTripCallerRole(findCallerRole(detail, currentUserId));
        // Hydrate `activeTrip` when the planner is showing a different
        // trip (or no trip at all) so deep links and the `/trips/:id/edit`
        // handoff actually load the requested itinerary instead of leaving
        // the canvas empty. Skipped when the in-memory trip already
        // matches `serverTripId` so unsaved planner edits aren't clobbered
        // by a remount or a refetch.
        if (activeTripRef.current?.id !== detail.id) {
          const hydrated = tripFromDetail(detail);
          setActiveTrip(hydrated);
          // Also seed the local generation controls from the persisted
          // trip parameters. Without this, pressing **Generate** after
          // landing here from `/trips/:id/edit` would regenerate using
          // the planner's default react state (3 days / 250 km / mixed),
          // silently overwriting the rider's persisted settings.
          const params = hydrated.parameters;
          setDays(params.days);
          setDailyKmTarget(params.dailyKmTarget);
          setRoadPreference(fromTripRoadPreference(params.roadPreference));
          setSurfacePreference(params.surfacePreference);
          setMinQuality(params.minQuality);
          setAvoidHighways(params.avoidHighways);
          setAvoidTolls(params.avoidTolls);
          setAvoidUnpaved(params.avoidUnpaved);
          // Persisted trip parameters, not rider edits — keep them out
          // of the saved-defaults write-back (§F).
          prefsTouchedRef.current = false;
        }
      } catch {
        // Non-fatal — modal / hook will surface concrete errors on
        // their own actions if the trip really isn't accessible.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUserId, serverTripId, authReady, setActiveTrip]);
  const handlePromotedToServer = useCallback(
    (newServerTripId: string) => {
      setServerTripId(newServerTripId);
      setServerTripOwnerId(currentUserId);
      setServerTripCallerRole("owner");
      // Push the id into the URL so a reload preserves the live session.
      // history.replaceState avoids depending on the Next router, keeping
      // the page prerenderable (see comment on the URL read above).
      writeServerTripIdToUrl(newServerTripId);
    },
    [currentUserId],
  );
  const plannerParams = useMemo<TripParameters>(
    () => ({
      days,
      dailyKmTarget,
      roadPreference: toTripRoadPreference(roadPreference),
      surfacePreference,
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      minQuality,
    }),
    [
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      dailyKmTarget,
      days,
      minQuality,
      roadPreference,
      surfacePreference,
    ],
  );
  // Panel typed search: picking a result relocates the row's waypoint
  // (forward geocode → coordinates) and adopts the place name.
  const handleRelocateWaypoint = useCallback(
    (waypointId: string, result: GeoResult) => {
      moveWaypoint(
        selectedDayIndex,
        waypointId,
        { lng: result.lng, lat: result.lat },
        plannerParams,
      );
      renameWaypoint(waypointId, result.name);
    },
    [moveWaypoint, plannerParams, renameWaypoint, selectedDayIndex],
  );
  // Empty START/FINISH spine rows: typing a place creates the endpoint
  // (same store path as a map click), then adopts the geocoded name.
  const handleCreateEndpoint = useCallback(
    (role: "start" | "end", result: GeoResult) => {
      useTripStore
        .getState()
        .placeWaypoint(
          { lat: result.lat, lng: result.lng },
          role === "start" ? "set-start" : "set-end",
          plannerParams,
        );
      const state = useTripStore.getState();
      const day = state.activeTrip?.days[state.selectedDayIndex];
      const created =
        role === "start"
          ? day?.waypoints.find((w) => w.type === "start")
          : day
            ? dayFinishWaypoint(day.waypoints)
            : undefined;
      if (created) renameWaypoint(created.id, result.name);
    },
    [plannerParams, renameWaypoint],
  );
  const handleAddViaFromSearch = useCallback(
    (result: GeoResult) => {
      insertWaypointBeforeEnd(selectedDayIndex, {
        id: `search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: result.name,
        nameIsSource: true,
        location: { lng: result.lng, lat: result.lat },
        type: "via",
      });
    },
    [insertWaypointBeforeEnd, selectedDayIndex],
  );

  // Mirror the current planner controls into the store so the map's
  // context-menu placement seeds a brand-new draft with these parameters
  // (days/km/avoid options) rather than store defaults.
  useEffect(() => {
    setDraftPlannerParameters(plannerParams);
  }, [plannerParams, setDraftPlannerParameters]);
  const closureRoutes = useMemo(
    () => buildTripClosureRoutes(displayedTrip, t),
    [t, displayedTrip],
  );
  const currentGenerationSignature = useMemo(
    () =>
      buildGenerationInputSignature(
        displayedTrip,
        plannerParams,
        plannerRegion,
      ),
    [displayedTrip, plannerParams, plannerRegion],
  );
  const closuresData = useClosures(travelMonth, closureRoutes);
  const passesData = usePasses(travelMonth, closureRoutes);
  // CONDITIONS + STOPS scope to the selected materialized day. The map keeps
  // its whole-route markers (closuresData/passesData above); the tab reads a
  // day-scoped copy. React-query keys on the route content, so when nothing is
  // selected the two calls share a cache entry — no extra request.
  const conditionRoutes = useMemo(
    () =>
      selectedTripDay
        ? closureRoutes.filter(
            (route) => route.id === `day-${selectedTripDay.dayNumber}`,
          )
        : closureRoutes,
    [selectedTripDay, closureRoutes],
  );
  const tabClosuresData = useClosures(travelMonth, conditionRoutes);
  const tabPassesData = usePasses(travelMonth, conditionRoutes);
  const stopsTrip = useMemo(
    () =>
      selectedTripDay && displayedTrip
        ? { ...displayedTrip, days: [selectedTripDay] }
        : displayedTrip,
    [selectedTripDay, displayedTrip],
  );
  // selectedDay / selectedDayIndex are derived ~line 264 (routing section above)
  const openImport = useCallback(
    (file: File | null = null) => {
      // An imported route mints on save — block EVERY entry (toolbar button,
      // drag/drop, and the ?import deep-link below) while the own-cap gate is
      // active, so a capped rider can't adopt/edit an import ahead of the 403.
      if (mintGateBlocked) return;
      setPendingImportFile(file);
      setImportOpen(true);
    },
    [mintGateBlocked],
  );
  useEffect(() => {
    // Honour a held `?import=1` request once the gate is confirmed NOT blocking
    // (rider under cap / unlimited). While blocked (loading, unknown, or at cap)
    // it stays held; an at-cap rider's request is simply never opened.
    if (importRequestedFromUrl && !mintGateBlocked) {
      openImport();
      setImportRequestedFromUrl(false);
    }
  }, [importRequestedFromUrl, mintGateBlocked, openImport]);
  // Reset / Discard confirm through the app-styled ConfirmDialog —
  // system dialogs are disallowed (they block the tab and ignore the
  // design system).
  const [pendingConfirm, setPendingConfirm] = useState<
    "reset" | "discard" | null
  >(null);
  // Trip rename dialog (rider feedback) — the header title opens it.
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const renameActiveTrip = useTripStore((s) => s.renameActiveTrip);
  const openRenameDialog = useCallback(() => {
    const trip = activeTripRef.current;
    if (!trip) return;
    setNameDraft(tripDisplayName(trip, t) ?? "");
    setRenameOpen(true);
  }, [t]);
  const confirmRename = useCallback(() => {
    const trimmed = nameDraft.trim();
    if (trimmed) {
      renameActiveTrip(trimmed);
      // Persisted trips save the rename IMMEDIATELY: a rename is a
      // metadata edit, not a route edit, so it must not arm Save route
      // (which would re-route the whole trip unpreviewed just to carry
      // a title, or leave the title unsaved when routing is down).
      const tripId = resolveExistingTripId(serverTripId, activeTripRef.current);
      if (tripId && canEditTripMetadata) {
        void tripsApi
          .update(tripId, { title: trimmed })
          .then(() => toast.success(t("Trip renamed")))
          .catch(() =>
            toast.error(t("Could not rename the trip. Please try again.")),
          );
      }
    }
    setRenameOpen(false);
  }, [t, nameDraft, renameActiveTrip, serverTripId, canEditTripMetadata]);
  // Start over WITHOUT leaving the planner (rider feedback): drop the
  // working route, drawn region, splits and any server-trip binding so
  // the canvas is blank again. Pref controls keep their values.
  const performReset = useCallback(() => {
    setActiveTrip(null);
    setPlannerRegion(null);
    setGeneratedOptions([]);
    setGeneratedOptionsSignature(null);
    setSelectedOptionId(null);
    setServerTripId(null);
    setServerTripOwnerId(null);
    setServerTripCallerRole(null);
    setDraftNote(null);
    setLegPrefsByDay({});
    setForcedDays(null);
    setLastRoundtripOpts(null);
    setMultiDayOpen(false);
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState({}, "", url);
  }, [setActiveTrip]);
  // Discard: delete the persisted trip (routes save server-side) and
  // leave the planner back to the trips list.
  const performDiscard = useCallback(async () => {
    const persistedTripId =
      serverTripId ??
      (activeTripRef.current && UUID_RE.test(activeTripRef.current.id)
        ? activeTripRef.current.id
        : null);
    if (persistedTripId) {
      try {
        await tripsApi.delete(persistedTripId);
      } catch {
        toast.error(
          t("Could not delete the saved trip — it may still be listed."),
        );
      }
    }
    setActiveTrip(null);
    router.push("/trips");
  }, [t, router, serverTripId, setActiveTrip]);
  // Dormant: the "Push to phone" toolbar action was pulled from the UI
  // (rider feedback — not needed for now). Kept intact for when the
  // itinerary-push flow returns; it is still the metadata+imported-route
  // save path the tests exercised.
  const _handleSave = useCallback(async () => {
    if (!displayedTrip || saving || isGenerating || generationLockRef.current) {
      return;
    }
    setSaving(true);
    try {
      const p = plannerParams;
      // Prefer a known serverTripId from collaboration/deep links. Promoted
      // drafts keep local in-memory ids, but their suggestions and activity
      // already belong to the promoted backend trip.
      const existingTripId = resolveExistingTripId(serverTripId, displayedTrip);
      const importedRoutePayload = buildImportedRoutePayload(displayedTrip, t);
      if (displayedTrip.id.startsWith("imported-") && !importedRoutePayload) {
        toast.error(
          t("Imported routes need at least two route points before saving."),
        );
        setSaving(false);
        return;
      }
      if (importedRoutePayload) {
        const { data: saved } = existingTripId
          ? await tripsApi.replaceImportedRoute(
              existingTripId,
              importedRoutePayload,
            )
          : await tripsApi.importRoute(importedRoutePayload);
        const tripId =
          existingTripId ??
          (
            saved as {
              id?: string;
            }
          ).id;
        if (!tripId) {
          throw new Error("Imported trip save response did not include an id");
        }
        router.push(`/trips/${tripId}`);
        return;
      }
      if (
        p.surfacePreference.length > 0 &&
        generationSurfaces(p).length === 0
      ) {
        toast.error(
          t(
            "Select at least one paved surface or turn off Avoid unpaved roads before saving.",
          ),
        );
        setSaving(false);
        return;
      }
      // Generate the route using the first waypoint as start_location.
      const firstDay = displayedTrip.days[0];
      const startWp = firstDay?.waypoints[0];
      if (!startWp) {
        toast.error(t("Add a start waypoint before saving this trip."));
        setSaving(false);
        return;
      }
      const basePayload = buildTripMetadataPayload(displayedTrip, p, t);
      const { data: saved } = existingTripId
        ? await tripsApi.update(existingTripId, basePayload)
        : await tripsApi.create(basePayload);
      const tripId =
        (
          saved as {
            id?: string;
          }
        ).id ?? existingTripId;
      if (!tripId) {
        throw new Error("Trip save response did not include an id");
      }
      const createdTripId = existingTripId ? null : tripId;
      const selectedBackendOption = generatedOptions.find(
        (option) => option.id === selectedOptionId,
      );
      const selectedBackendOptionIsCurrent =
        selectedBackendOption !== undefined &&
        generatedOptionsSignature === currentGenerationSignature;
      const shouldGenerate =
        !selectedBackendOptionIsCurrent &&
        (!existingTripId ||
          displayedTrip.id !== existingTripId ||
          selectedBackendOption !== undefined);
      if (shouldGenerate) {
        try {
          await tripsApi.generate(
            tripId,
            buildGenerationPayload(
              p,
              startWp,
              plannerRegion,
              selectedBackendOption?.id,
            ),
          );
        } catch (generateError) {
          if (createdTripId) {
            try {
              await tripsApi.delete(createdTripId);
            } catch (cleanupError) {
              console.warn("Failed to clean up unsaved trip", cleanupError);
            }
          }
          throw generateError;
        }
      }
      router.push(`/trips/${tripId}`);
    } catch (err) {
      toast.error(t("Could not save this trip. Please try again."));
      console.warn("Failed to save trip", err);
      setSaving(false);
    }
  }, [
    t,
    currentGenerationSignature,
    displayedTrip,
    generatedOptionsSignature,
    generatedOptions,
    isGenerating,
    plannerParams,
    plannerRegion,
    router,
    saving,
    selectedOptionId,
    serverTripId,
  ]);
  // ── Save Route (Task 11 / Task 9 multi-day gate) ────────────────────
  // Per-day completeness helper: "empty" = no waypoints, "incomplete" =
  // has waypoints but missing start/finish OR a previewed route, "complete" =
  // a start, a finish (≥2 points), AND `routeGeometry`. A generated non-final
  // day ends in a terminal `accommodation` (overnight) rather than `end`; that
  // counts as the finish (saveDays normalizes it to `end` before re-route).
  // Geometry is REQUIRED for "complete": a share/imported day can carry valid
  // start/end waypoints but no preview, and without this it would slip past the
  // save gate and let the backend route a leg the rider never previewed.
  const completeness = useCallback(
    (d: TripDay): "empty" | "incomplete" | "complete" => {
      if (d.waypoints.length === 0) return "empty";
      const hasStart = d.waypoints.some((w) => w.type === "start");
      const hasFinish = !!dayFinishWaypoint(d.waypoints);
      return hasStart &&
        hasFinish &&
        d.waypoints.length >= 2 &&
        !!d.routeGeometry
        ? "complete"
        : "incomplete";
    },
    [],
  );
  const dayStates = useMemo(
    () => (activeTrip?.days ?? []).map(completeness),
    [activeTrip, completeness],
  );
  // Only allow saving when:
  // - at least one day is "complete" (has start + end + geometry)
  // - no day is "incomplete" (partial = blocks save until rider fixes it)
  // - no day preview is stale (geometry is current for all days)
  // - there are unsaved edits: route geometry (routeDirty) OR waypoint names
  //   (namesDirty — persisted via the name-only path below, no re-route); both
  //   guard no-op saves on loaded trips
  const canSaveRoute =
    canWriteRoute &&
    dayStates.some((s) => s === "complete") &&
    !dayStates.some((s) => s === "incomplete") &&
    stalePreviewDays.length === 0 &&
    (routeDirty || namesDirty);
  const [savingRoute, setSavingRoute] = useState(false);
  const handleSaveRoute = useCallback(async () => {
    if (savingRoute || routing) return;

    // Name-only fast path (#911): when the only unsaved change is waypoint
    // names (a late/auto reverse-geocoded pin name on a loaded trip), persist
    // them via PATCH /waypoints so the router does NOT run — the full route
    // save re-routes and would replace an imported / manually-adjusted route's
    // geometry. Requires an existing server trip (a fresh draft is always
    // routeDirty and takes the full save below).
    const nameState = useTripStore.getState();
    if (nameState.namesDirty && !nameState.routeDirty) {
      const trip = nameState.activeTrip ?? activeTripRef.current;
      const nameTripId = resolveExistingTripId(serverTripId, trip);
      // Send ONLY the waypoints this client actually renamed — not every
      // persisted stop. Re-sending an unchanged name would let this save
      // revert a collaborator's concurrent rename of a different waypoint.
      const renamedIds = new Set(nameState.renamedWaypointIds);
      const waypoints = (trip?.days ?? [])
        .flatMap((d) => d.waypoints)
        .filter((w) => renamedIds.has(w.id) && UUID_RE.test(w.id))
        .map((w) => ({ id: w.id, name: w.name ?? null }));
      // An unsaved GPX/KML import has no server trip and no UUID waypoints to
      // PATCH — its geometry is the imported track, which saveRoute would
      // re-route and replace. Persist it (names + geometry) through the import
      // endpoint instead. Both branches below skip the re-routing PUT.
      const importedRoutePayload = trip
        ? buildImportedRoutePayload(trip, t)
        : null;
      let persistNames: (() => Promise<{ data: unknown }>) | null = null;
      // Whether this persist CREATES a new backend trip (importRoute on an
      // unsaved import) — if so it must be promoted afterwards, like the
      // full-save creation path, to wire serverTripId + the ?tripId= URL.
      let promotesOnCreate = false;
      if (nameTripId && waypoints.length > 0) {
        persistNames = () =>
          tripsApi.updateWaypointNames(nameTripId, { waypoints });
      } else if (importedRoutePayload) {
        const payload = importedRoutePayload;
        if (nameTripId) {
          persistNames = () =>
            tripsApi.replaceImportedRoute(nameTripId, payload);
        } else {
          promotesOnCreate = true;
          persistNames = () => tripsApi.importRoute(payload);
        }
      }
      if (persistNames) {
        setSavingRoute(true);
        try {
          const { data } = await persistNames();
          const hydrated = withRequestOnlyRouteOptions(
            tripFromDetail(
              data as unknown as Parameters<typeof tripFromDetail>[0],
            ),
            plannerParams,
          );
          setActiveTrip(hydrated);
          if (promotesOnCreate) {
            // importRoute created the backend trip — attach collab + push the
            // ?tripId= URL so a refresh reloads it and role state binds,
            // mirroring the full-save first-save promotion.
            handlePromotedToServer(hydrated.id);
          }
          toast.success(t("Names saved"));
        } catch (err) {
          // The unsaved-import branch mints a trip (importRoute) and can hit
          // the max_active_trips 403 — route it to the upgrade modal like the
          // full-save path, not a generic toast.
          const limitError = parseFeatureLimitError(err);
          if (limitError && tier) {
            setUpgradeModalLimit(limitError.limit);
            setUpgradeModalOpen(true);
          } else {
            toast.error(t("Couldn't save the names. Try again."));
          }
        } finally {
          setSavingRoute(false);
        }
        return;
      }
      // No persisted target yet (e.g. a planned draft, whose geometry the
      // save re-routes idempotently) — fall through to the full save, which
      // persists the names along with the route.
    }

    // Resolve or lazily create the backend trip. Reuse the same pattern
    // as the existing handleSave so collab/deep-link trips are updated
    // in place rather than duplicated.
    // Persist the computed split: rewrite trip.days from the DayPlans so
    // the existing per-day save contract carries them (addendum decision).
    const wasSplitMaterialized =
      useTripStore.getState().splitStatus === "split" &&
      useTripStore.getState().activeTrip?.days.length === 1;
    if (wasSplitMaterialized) {
      useTripStore.getState().materializeSplit();
    }
    const currentTrip =
      useTripStore.getState().activeTrip ?? activeTripRef.current;
    const existingTripId = resolveExistingTripId(serverTripId, currentTrip);
    // Use the store's saveDays() to derive the canonical per-day payload.
    // Calling getState() inside a click handler / useCallback is safe Zustand
    // pattern — it reads current state without subscribing to re-renders.
    const days = useTripStore.getState().saveDays();
    if (days.length === 0) {
      toast.error(t("Add at least a start and end before saving."));
      return;
    }
    setSavingRoute(true);
    let createdTripId: string | null = null;
    try {
      let tripId = existingTripId;
      if (!tripId) {
        // No server trip yet — create metadata first (same pattern as
        // handleSave) so we have a backend id to PUT the route against.
        // num_days reflects the actual non-empty day count from saveDays so
        // the trip metadata stays consistent with the persisted day payload.
        const basePayload = {
          ...(currentTrip
            ? buildTripMetadataPayload(currentTrip, plannerParams, t)
            : buildTripMetadataPayload(
                { name: "" } as Parameters<typeof buildTripMetadataPayload>[0],
                plannerParams,
                t,
              )),
          num_days: days.length,
        };
        const { data: created } = await tripsApi.create(basePayload);
        tripId =
          (
            created as {
              id?: string;
            }
          ).id ?? null;
        if (!tripId) throw new Error("Trip creation did not return an id");
        createdTripId = tripId;
      }
      // Per-leg road overrides ride along with their day (§C): the save
      // re-routes server-side, and without them a custom leg would
      // persist a different line than the approved preview. Payload days
      // are the surviving (non-empty) trip days in order — mirror
      // saveDays' filter to align indexes.
      const survivingDayIndexes = (currentTrip?.days ?? [])
        .map((day, index) => (day.waypoints.length > 0 ? index : -1))
        .filter((index) => index >= 0);
      const daysWithLegs = days.map((day, k) => {
        const dayIndex = survivingDayIndexes[k];
        const tripDay =
          dayIndex === undefined ? undefined : currentTrip?.days[dayIndex];
        if (!tripDay || dayIndex === undefined) return day;
        // A just-materialized split rewrote the single working day into
        // day indexes 0..N-1, but every override still lives under the
        // ORIGINAL day 0 — reconcile that list against each new day's
        // spine (surviving via pairs keep their override; pairs broken
        // by a split boundary re-inherit, §C).
        const sourceLegs = wasSplitMaterialized
          ? (legPrefsByDay[0] ?? [])
          : (legPrefsByDay[dayIndex] ?? []);
        const legs = reconcileLegPrefs(
          sourceLegs,
          filterRoutingWaypoints(normalizeDayFinish(tripDay.waypoints)).map(
            (w) => w.id,
          ),
        );
        if (!legs.some((leg) => leg.preference !== "inherit")) return day;
        return {
          ...day,
          leg_preferences: legs.map((leg) => {
            const effective = effectiveLegPreference(leg, roadPreference);
            return effective === "efficient_loop" ? "direct" : effective;
          }),
        };
      });
      const { data } = await tripsApi.saveRoute(tripId, {
        days: daysWithLegs,
        options: routeOptions,
      });
      let detail = data;
      if (existingTripId && currentTrip && canEditTripMetadata) {
        // PUT /route replaces days but never the trip metadata, and the
        // hydration below would otherwise revert the title AND planner
        // parameters (road preference, min quality, daily km) to stale
        // server values. The PATCH runs AFTER the route commit so a
        // failed re-route can't persist new parameters against old
        // geometry; its response carries both for hydration. Skipped for
        // plain members (metadata is owner/admin-only while route saves
        // are any-member).
        const { data: updated } = await tripsApi.update(tripId, {
          ...buildTripMetadataPayload(currentTrip, plannerParams, t),
          num_days: days.length,
        });
        detail = updated as typeof data;
      }
      const hydrated = withRequestOnlyRouteOptions(
        tripFromDetail(
          detail as unknown as Parameters<typeof tripFromDetail>[0],
        ),
        plannerParams,
      );
      setActiveTrip(hydrated);
      if (!existingTripId) {
        // First save — wire up collab + URL
        handlePromotedToServer(tripId);
      }
      toast.success(t("Route saved"));
    } catch (err) {
      // If we just created a new server trip but the route save failed,
      // delete the empty trip so it doesn't linger in the rider's library.
      // Mirrors the cleanup pattern in handleSave.
      if (createdTripId) {
        await cleanupCreatedTrip(createdTripId);
      }
      // The backend's max_active_trips gate rejects the create call above
      // with a 403 FEATURE_LIMIT_EXCEEDED — this IS the planner's primary
      // mint path (create-on-first-save), so it needs the same upgrade-modal
      // safety net as the /trips list's mint entry points.
      const limitError = parseFeatureLimitError(err);
      if (limitError && tier) {
        setUpgradeModalLimit(limitError.limit);
        setUpgradeModalOpen(true);
      } else {
        toast.error(t("Could not save the route. Please try again."));
      }
    } finally {
      setSavingRoute(false);
    }
  }, [
    t,
    savingRoute,
    routing,
    serverTripId,
    canEditTripMetadata,
    plannerParams,
    legPrefsByDay,
    roadPreference,
    routeOptions,
    setActiveTrip,
    handlePromotedToServer,
    tier,
  ]);
  const handleFitRoute = useCallback(() => {
    mapRef.current?.fitRoute();
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear if leaving the drop target, not bubbling from children.
    if (e.currentTarget === e.target) setIsDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = Array.from(e.dataTransfer.files).find((f) =>
        /\.(gpx|kml)$/i.test(f.name),
      );
      if (file) openImport(file);
    },
    [openImport],
  );
  // Set ONLY by the user-facing pref controls below — the persistence
  // effect uses it to tell a rider's change apart from trip-load /
  // URL-hydration sync (which must never overwrite saved defaults, §F).
  const prefsTouchedRef = useRef(false);
  const handleSurfaceToggle = useCallback(
    (surface: SurfaceType) => {
      setSurfacePreference((current) => {
        if (current.includes(surface)) {
          return current.length === 1
            ? current
            : current.filter((value) => value !== surface);
        }
        return [...current, surface];
      });
      // Routing input per the addendum (§3): re-fire live routing and
      // invalidate a computed split.
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  // Road preference + min quality are routing inputs too (addendum §3):
  // they dirty the route (staling any split) and re-fire live routing
  // through the per-leg request options (revision 3 §C).
  const handleRoadPreferenceChange = useCallback(
    (value: RoadPreference) => {
      setRoadPreference(value);
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  const handleMinQualityChange = useCallback(
    (value: number) => {
      setMinQuality(value);
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  // Wrapped avoid-option handlers: update state AND mark route dirty so
  // live routing fires on a loaded trip when the rider changes an option.
  // These are ONLY called from user-facing controls (the JSX checkboxes
  // below), NOT from the load/hydration effects — so they never mark
  // dirty on page mount.
  const handleAvoidHighwaysChange = useCallback(
    (value: boolean) => {
      setAvoidHighways(value);
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  const handleAvoidTollsChange = useCallback(
    (value: boolean) => {
      setAvoidTolls(value);
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  const handleAvoidUnpavedChange = useCallback(
    (value: boolean) => {
      setAvoidUnpaved(value);
      prefsTouchedRef.current = true;
      markRouteDirty();
    },
    [markRouteDirty],
  );
  // ── Persisted user route prefs (revision 3 §F) ─────────────────────
  // The trip-wide subset only — per-leg overrides and waypoints stay
  // per-trip.
  const currentRoutePrefs = useMemo<UserRoutePrefs>(
    () => ({
      roadPreference,
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      surfaces: surfacePreference,
      minQuality: minQualityToLevel(minQuality),
    }),
    [
      roadPreference,
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      surfacePreference,
      minQuality,
    ],
  );
  const prefsLoadStartedRef = useRef(false);
  useEffect(() => {
    // Load the rider's saved defaults once; pre-apply them ONLY on a
    // fresh planner (no tripId, no shared-URL control overrides) — a
    // loaded trip's own parameters and an explicit URL always win.
    // Gated on authReady like the trip fetch above: on a hard load the
    // auth store has no token yet and the GET would 401 silently,
    // leaving the saved defaults unapplied.
    if (!authReady || prefsLoadStartedRef.current) return;
    prefsLoadStartedRef.current = true;
    let cancelled = false;
    const search = typeof window === "undefined" ? "" : window.location.search;
    const params = new URLSearchParams(search);
    const hasOverrides =
      params.has("tripId") ||
      Object.values(URL_PARAM_KEYS).some((key) => params.has(key));
    plannerApi
      .getUserRoutePrefs()
      .then((prefs) => {
        if (cancelled) return;
        setSavedRoutePrefs(prefs);
        if (prefs && !hasOverrides) {
          setRoadPreference(prefs.roadPreference);
          setAvoidHighways(prefs.avoidHighways);
          setAvoidTolls(prefs.avoidTolls);
          setAvoidUnpaved(prefs.avoidUnpaved);
          if (prefs.surfaces.length > 0) setSurfacePreference(prefs.surfaces);
          setMinQuality(minQualityFromLevel(prefs.minQuality));
        }
      })
      .catch(() => {
        // Saved defaults are a convenience — the fallbacks already apply.
      })
      .finally(() => {
        if (!cancelled) setPrefsHydrated(true);
      });
    return () => {
      cancelled = true;
    };
    // Runs once when auth is ready; reads the initial URL like the
    // tripId effect above.
  }, [authReady]);
  useEffect(() => {
    // Debounced write-back of rider-made pref changes as the new saved
    // defaults. Trip-load sync never triggers this (prefsTouchedRef).
    if (!prefsHydrated || !prefsTouchedRef.current) return;
    const baseline = savedRoutePrefs ?? FALLBACK_USER_ROUTE_PREFS;
    if (sameUserRoutePrefs(currentRoutePrefs, baseline)) return;
    const handle = window.setTimeout(() => {
      void plannerApi
        .saveUserRoutePrefs(currentRoutePrefs)
        .then(() => setSavedRoutePrefs(currentRoutePrefs))
        .catch(() => {
          // Persisting defaults is best-effort; the session keeps them.
        });
    }, 800);
    return () => window.clearTimeout(handle);
  }, [currentRoutePrefs, prefsHydrated, savedRoutePrefs]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestTokenRef.current += 1;
      generationLockRef.current = false;
      setGenerating(false);
    };
  }, [setGenerating]);
  useEffect(() => {
    activeTripRef.current = activeTrip;
  }, [activeTrip]);
  useEffect(() => {
    const tripId = activeTrip?.id ?? null;
    if (!activeTrip) {
      syncedControlsTripIdRef.current = null;
      return;
    }
    if (syncedControlsTripIdRef.current === tripId) return;
    syncedControlsTripIdRef.current = tripId;
    const params = activeTrip.parameters;
    setDays(params.days);
    setDailyKmTarget(params.dailyKmTarget);
    setRoadPreference(fromTripRoadPreference(params.roadPreference));
    setSurfacePreference(params.surfacePreference);
    setMinQuality(params.minQuality);
    setAvoidHighways(params.avoidHighways);
    setAvoidTolls(params.avoidTolls);
    setAvoidUnpaved(params.avoidUnpaved);
    // The values above are the TRIP's parameters, not rider edits: drop
    // any earlier touch so the saved-defaults write-back (§F) can't
    // persist a loaded/remote trip's parameters as the rider's defaults.
    prefsTouchedRef.current = false;
    // Re-seed the leg overrides from the persisted days (§C): saved
    // leg_preferences map positionally onto each day's routing pairs.
    // Values equal to the trip-wide preference collapse back to inherit
    // so the UI shows CUSTOM only where the rider actually diverged.
    const tripWide = fromTripRoadPreference(params.roadPreference);
    const seeded: Record<number, LegPref[]> = {};
    activeTrip.days.forEach((day, index) => {
      const stored = day.legPreferences;
      if (!stored || stored.length === 0) return;
      const ids = filterRoutingWaypoints(normalizeDayFinish(day.waypoints)).map(
        (w) => w.id,
      );
      if (stored.length !== ids.length - 1) return;
      const legs = ids.slice(0, -1).map((fromWaypointId, i) => ({
        fromWaypointId,
        toWaypointId: ids[i + 1]!,
        preference: (stored[i] === tripWide
          ? "inherit"
          : stored[i]!) as LegPref["preference"],
      }));
      if (legs.some((leg) => leg.preference !== "inherit")) {
        seeded[index] = legs;
      }
    });
    // Only replace state when the trip actually carries overrides: the
    // reconcile effect owns the empty shape, and stale entries from a
    // previous trip re-inherit there on their own (broken pairs, §C).
    if (Object.keys(seeded).length > 0) setLegPrefsByDay(seeded);
  }, [activeTrip]);
  // Hydrate the planner controls from `?days=…&road=…` etc. **after** mount
  // so that the SSR/static prerender and the client's first render both
  // start from the same defaults — reading `window.location` during render
  // would diverge the two trees and break hydration. The same effect then
  // mirrors any subsequent control edits back into the URL via
  // history.replaceState (not the Next router) so the page stays
  // statically prerenderable and we don't stack a history entry per tweak.
  // Existing search params (notably `tripId`) are preserved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!urlControlsHydratedRef.current) {
      urlControlsHydratedRef.current = true;
      const fromUrl = readPlannerControlsFromUrl();
      const dirty =
        fromUrl.days !== PLANNER_DEFAULTS.days ||
        fromUrl.dailyKmTarget !== PLANNER_DEFAULTS.dailyKmTarget ||
        fromUrl.roadPreference !== PLANNER_DEFAULTS.roadPreference ||
        !surfacesEqualDefault(fromUrl.surfacePreference) ||
        fromUrl.minQuality !== PLANNER_DEFAULTS.minQuality ||
        fromUrl.avoidHighways !== PLANNER_DEFAULTS.avoidHighways ||
        fromUrl.avoidTolls !== PLANNER_DEFAULTS.avoidTolls ||
        fromUrl.avoidUnpaved !== PLANNER_DEFAULTS.avoidUnpaved;
      if (dirty) {
        setDays(fromUrl.days);
        setDailyKmTarget(fromUrl.dailyKmTarget);
        setRoadPreference(fromTripRoadPreference(fromUrl.roadPreference));
        setSurfacePreference(fromUrl.surfacePreference);
        setMinQuality(fromUrl.minQuality);
        setAvoidHighways(fromUrl.avoidHighways);
        setAvoidTolls(fromUrl.avoidTolls);
        setAvoidUnpaved(fromUrl.avoidUnpaved);
        // Skip the URL write on this pass — we'd just be writing back what
        // we just read. The follow-up render triggered by the setStates
        // above will sync any sanitized values (e.g. clamped numbers).
        return;
      }
    }
    syncPlannerControlsToUrl({
      days,
      dailyKmTarget,
      roadPreference: toTripRoadPreference(roadPreference),
      surfacePreference,
      avoidHighways,
      avoidTolls,
      avoidUnpaved,
      minQuality,
    });
  }, [
    avoidHighways,
    avoidTolls,
    avoidUnpaved,
    dailyKmTarget,
    days,
    minQuality,
    roadPreference,
    surfacePreference,
  ]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!urlRegionHydratedRef.current) {
      urlRegionHydratedRef.current = true;
      const fromUrl = parseBboxParam(
        new URLSearchParams(window.location.search).get(URL_PARAM_KEYS.bbox),
      );
      if (!bboxEqual(fromUrl, plannerRegion)) {
        setPlannerRegion(fromUrl);
        return;
      }
    }
    syncPlannerRegionToUrl(plannerRegion);
  }, [plannerRegion]);
  useEffect(() => {
    generatedOptionsRef.current = generatedOptions;
  }, [generatedOptions]);
  useEffect(() => {
    if (!activeTrip) {
      if (selectedOptionId !== null) setSelectedOptionId(null);
      if (generatedOptionsSignature !== null)
        setGeneratedOptionsSignature(null);
      return;
    }
    const matchingOption = generatedOptionsRef.current.find(
      (option) => option.trip.id === activeTrip.id,
    );
    if (!matchingOption) {
      if (selectedOptionId !== null) setSelectedOptionId(null);
      if (generatedOptionsSignature !== null)
        setGeneratedOptionsSignature(null);
      return;
    }
    if (matchingOption.trip !== activeTrip) {
      setGeneratedOptions((current) =>
        current.map((option) =>
          option.id === matchingOption.id
            ? { ...option, trip: activeTrip }
            : option,
        ),
      );
    }
    if (matchingOption.id !== selectedOptionId) {
      setSelectedOptionId(matchingOption.id);
    }
  }, [activeTrip, generatedOptionsSignature, selectedOptionId]);
  const handleGenerate = useCallback(async () => {
    if (generationLockRef.current) return;
    const activeTripAtStart = activeTripRef.current;
    // ── Start + finish set (revision 2 §E cases 2/3): drafting measures
    // the DIRECT route against the daily-km sizing value, then either
    // inflates a short hop through Fun Zones toward it (soft target) or
    // leaves a full-day route natural with light corridor flavor. The
    // draft returns the vias; live routing redraws through them. Days
    // stay with the splitter — a draft never creates them.
    // The SELECTED day: the draft button's visibility keys on it and the
    // via inserts below target it, so reading any other day would draft
    // one leg's endpoints into another leg's waypoints.
    const routeDay = activeTripAtStart?.days[selectedDayIndex];
    const startWp = routeDay?.waypoints.find((w) => w.type === "start");
    const finishWp = routeDay ? dayFinishWaypoint(routeDay.waypoints) : null;
    // A drafted loop (finish back on the start) is still a roundtrip —
    // recalculating reopens the options dialog, never the A→B draft
    // (whose "direct route" would be 0 km).
    const isLoop = Boolean(
      startWp &&
      finishWp &&
      startWp !== finishWp &&
      sameSpot(startWp.location, finishWp.location),
    );
    if (startWp && finishWp && startWp !== finishWp && !isLoop) {
      setGenerating(true);
      try {
        const result = await plannerApi.draftRoute(
          { lat: startWp.location.lat, lng: startWp.location.lng },
          { lat: finishWp.location.lat, lng: finishWp.location.lng },
          {
            region: plannerRegion,
            prefs: routeOptions,
            dailyKmForSizing: dailyKmTarget,
          },
        );
        const draftedDistance = format.distanceKm(result.summary.distanceKm);
        if (result.vias.length > 0) {
          // Replace existing plain vias with the drafted ones (stops like
          // fuel/stays are kept). Sequential before-finish inserts
          // preserve the travel order.
          const store = useTripStore.getState();
          for (const waypoint of routeDay!.waypoints) {
            if (waypoint.type === "via") store.removeWaypointById(waypoint.id);
          }
          insertDraftedVias(
            result.vias,
            selectedDayIndex,
            "draft",
            useTripStore.getState().insertWaypointBeforeEnd,
          );
          fitAfterRouteRef.current = true;
        }
        if (!result.inflated && result.reachedTargetKm) {
          // Case 3 — already a full day's ride; drafted natural.
          setDraftNote(null);
          toast.success(
            result.vias.length > 0
              ? t(
                  "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}} on the way.",
                  {
                    distance: draftedDistance,
                    count: result.vias.length,
                  },
                )
              : t("≈{distance} — already a full day's ride, left as routed.", {
                  distance: draftedDistance,
                }),
          );
        } else if (result.reachedTargetKm) {
          setDraftNote(null);
          toast.success(
            t(
              "Drafted ≈{distance} through {count, plural, one {# Fun Zone} other {# Fun Zones}}.",
              {
                distance: draftedDistance,
                count: result.vias.length,
              },
            ),
          );
        } else {
          // Honest report — the soft target is a goal, not a contract.
          const note = t("≈{distance} — limited fun roads nearby.", {
            distance: draftedDistance,
          });
          setDraftNote(note);
          toast.success(note);
        }
      } catch {
        toast.error(t("Could not draft the route right now."));
      } finally {
        setGenerating(false);
      }
      return;
    }
    // ── Start only (revision 3 §D): drafting a roundtrip is a discrete
    // generate action — open the options dialog (distance + direction +
    // preference); nothing drafts until the rider confirms.
    if (startWp) {
      setRoundtripOpen(true);
      return;
    }
    toast.error(
      t("Place a start point first — click the map or type a place."),
    );
  }, [
    t,
    dailyKmTarget,
    format,
    plannerRegion,
    routeOptions,
    selectedDayIndex,
    setGenerating,
  ]);
  // Confirmed roundtrip options → REAL loop draft (revision 3 §E). The
  // result lands as waypoints (Fun-Zone vias + turnaround + finish back
  // at the start), so the loop is live-editable like any other route.
  const handleDraftRoundtrip = useCallback(
    async (
      opts: Pick<RoundtripOptions, "distanceKm" | "direction" | "preference">,
    ) => {
      // Selected day, matching the inserts below (see handleGenerate).
      const routeDay = activeTripRef.current?.days[selectedDayIndex];
      const startWp = routeDay?.waypoints.find((w) => w.type === "start");
      if (!routeDay || !startWp) return;
      setGenerating(true);
      try {
        const result = await plannerApi.draftRoundtrip(
          { lat: startWp.location.lat, lng: startWp.location.lng },
          // Sidebar avoids ride along so the measured loop obeys the same
          // constraints the live reroute will; the dialog preference wins.
          { ...opts, region: plannerRegion, prefs: routeOptions },
        );
        // The confirmed dialog preference IS the loop's road character:
        // apply it to the live route inputs too, or the recompute through
        // the drafted vias would fall back to the old trip-wide value.
        // A per-loop choice, not an edit of the rider's saved defaults
        // (§F) — and an EARLIER touch this session must not smuggle it
        // into the write-back either, so the flag is cleared, not just
        // left unset.
        prefsTouchedRef.current = false;
        setRoadPreference(opts.preference);
        const store = useTripStore.getState();
        // The loop replaces plain vias; stops (fuel/stays) are kept.
        for (const waypoint of routeDay.waypoints) {
          if (waypoint.type === "via") store.removeWaypointById(waypoint.id);
        }
        // A roundtrip finishes back at its start.
        const hasFinish = Boolean(dayFinishWaypoint(routeDay.waypoints));
        if (!hasFinish) {
          useTripStore
            .getState()
            .placeWaypoint(
              { lat: startWp.location.lat, lng: startWp.location.lng },
              "set-end",
              plannerParams,
            );
          const day =
            useTripStore.getState().activeTrip?.days[selectedDayIndex];
          const finish = day ? dayFinishWaypoint(day.waypoints) : undefined;
          if (finish) {
            renameWaypoint(finish.id, startWp.name ?? t("Back at start"));
          }
        }
        insertDraftedVias(
          result.vias,
          selectedDayIndex,
          "loop",
          useTripStore.getState().insertWaypointBeforeEnd,
        );
        fitAfterRouteRef.current = true;
        const draftedDistance = format.distanceKm(result.summary.distanceKm);
        if (result.reachedTargetKm) {
          setDraftNote(null);
          toast.success(
            t("Drafted a ≈{distance} roundtrip.", {
              distance: draftedDistance,
            }),
          );
        } else {
          const note = t("≈{distance} — limited fun roads nearby.", {
            distance: draftedDistance,
          });
          setDraftNote(note);
          toast.success(note);
        }
        // Remember the confirmed options: the loop stays a roundtrip and
        // "Recalculate roundtrip" starts from these next time.
        setLastRoundtripOpts(opts);
        setRoundtripOpen(false);
      } catch {
        toast.error(t("Could not draft a roundtrip right now."));
      } finally {
        setGenerating(false);
      }
    },
    [
      t,
      format,
      plannerParams,
      plannerRegion,
      renameWaypoint,
      routeOptions,
      selectedDayIndex,
      setGenerating,
    ],
  );
  // Dormant until the multi-day option cards return (see the placeholder
  // comment in the JSX) — underscore keeps the unused-var lint quiet.
  const _handleSelectOption = useCallback(
    async (option: GeneratedTripOption) => {
      if (generationLockRef.current) return;
      if (option.selected || !serverTripId) {
        setSelectedOptionId(option.id);
        setActiveTrip(option.trip);
        // Only refit when the click actually swaps the displayed
        // route. Re-clicking the already-active option keeps the
        // same geometry on screen, so a refit there would rip the
        // user's panned/zoomed viewport for no visible change.
        if (!option.selected) {
          setFitRouteToken((t) => t + 1);
        }
        return;
      }
      const latestTrip = activeTripRef.current;
      const startWaypoint = findStartWaypoint(latestTrip);
      if (!latestTrip || !startWaypoint) {
        toast.error(t("Add a start waypoint before selecting this route."));
        return;
      }
      const requestToken = requestTokenRef.current + 1;
      requestTokenRef.current = requestToken;
      generationLockRef.current = true;
      setGenerating(true);
      try {
        const { data } = await tripsApi.generate(
          serverTripId,
          buildGenerationPayload(
            plannerParams,
            startWaypoint,
            plannerRegion,
            option.id,
          ),
        );
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        const response = data as GenerateTripResponse;
        const options = generatedOptionsFromResponse(response, plannerParams);
        const selected = selectedGeneratedOption(
          options,
          response.selected_option,
        );
        setGeneratedOptions(options);
        setGeneratedOptionsSignature(
          buildGenerationInputSignature(
            selected?.trip ?? null,
            plannerParams,
            plannerRegion,
          ),
        );
        setSelectedOptionId(selected?.id ?? option.id);
        setActiveTrip(selected?.trip ?? option.trip);
        setFitRouteToken((t) => t + 1);
      } catch (err) {
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        // Regenerating a completed trip re-mints it (assertCanMintOpenTrip) and
        // can hit the max_active_trips 403 — surface the upgrade modal.
        const limitError = parseFeatureLimitError(err);
        if (limitError && tier) {
          setUpgradeModalLimit(limitError.limit);
          setUpgradeModalOpen(true);
        } else {
          toast.error(
            t("Could not select this route option. Please try again."),
          );
        }
      } finally {
        if (requestTokenRef.current === requestToken) {
          generationLockRef.current = false;
          if (isMountedRef.current) {
            setGenerating(false);
          }
        }
      }
    },
    [
      t,
      plannerParams,
      plannerRegion,
      serverTripId,
      setActiveTrip,
      setGenerating,
      tier,
    ],
  );
  const totalDistanceKm = useMemo(() => {
    if (!displayedTrip) return null;
    const sum = displayedTrip.days.reduce(
      (acc, day) => acc + (day.distanceKm ?? 0),
      0,
    );
    return sum > 0 ? sum : null;
  }, [displayedTrip]);
  // Approximate ride time from the routing engine's per-day durations —
  // shown next to the distance so riders can gauge the day at a glance.
  const totalTimeMin = useMemo(() => {
    if (!displayedTrip) return null;
    const sum = displayedTrip.days.reduce(
      (acc, day) => acc + (day.durationMinutes ?? 0),
      0,
    );
    return sum > 0 ? Math.round(sum) : null;
  }, [displayedTrip]);
  // Revision 2 §B: the day column exists ONLY after an actual split
  // inside the multi-day opt-in — otherwise there is no day concept.
  const daysVisible =
    planningMode === "multiday" &&
    splitStatus !== "none" &&
    (dayPlans?.length ?? 0) > 0;
  // Roundtrip mode (revision 3 §D + rider feedback): a start without a
  // finish, OR a drafted loop whose finish sits back on the start — a
  // confirmed roundtrip must STAY a roundtrip, so Draft becomes
  // "Recalculate roundtrip" instead of falling into the A→B path.
  const spineStart =
    selectedDay?.waypoints.find((w) => w.type === "start") ?? null;
  const spineFinish = selectedDay
    ? (dayFinishWaypoint(selectedDay.waypoints) ?? null)
    : null;
  const isLoopRoute = Boolean(
    spineStart &&
    spineFinish &&
    spineStart !== spineFinish &&
    sameSpot(spineStart.location, spineFinish.location),
  );
  const isRoundtripMode = Boolean(spineStart) && (!spineFinish || isLoopRoute);
  // Fun-Zone region checkbox (rider feedback): checking starts the draw
  // on the map, unchecking mid-draw cancels it, unchecking with a drawn
  // region removes the region. The in-map Draw region button is gone.
  const regionDrawing = regionDrawMode === "drawing";
  const regionChecked = regionDrawing || plannerRegion !== null;
  const handleToggleRegionDraw = useCallback(() => {
    if (regionDrawMode === "drawing") {
      mapRef.current?.cancelRegionDraw();
    } else if (plannerRegion) {
      setPlannerRegion(null);
    } else {
      mapRef.current?.startRegionDraw();
    }
  }, [regionDrawMode, plannerRegion]);
  // Viewers have no edit rights — the backend 403s their writes, so the
  // editor is a dead end. Once the role resolves as viewer, show an
  // access screen pointing back to the read-only preview.
  if (isViewerOnSavedTrip) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-cream px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-line-strong text-fg-mute">
          <Users size={22} />
        </div>
        <div>
          <h1 className="text-lg font-extrabold text-ink">
            {t("You have view-only access")}
          </h1>
          <p className="mt-1 max-w-sm text-sm text-fg-dim">
            {t(
              "Editing this trip needs editor access from the owner. You can still open the read-only preview and leave suggestions.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="accent"
            size="sm"
            uppercase
            renderLink={({ className, children }) => (
              <Link href={`/trips/${serverTripId}`} className={className}>
                {children}
              </Link>
            )}
          >
            {t("Open preview")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            uppercase
            renderLink={({ className, children }) => (
              <Link href="/trips" className={className}>
                {children}
              </Link>
            )}
          >
            {t("Back to trips")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-cream">
      {/* Slim top toolbar — keeps Save / Undo / Redo / Import / Export /
          Collaborate / Demo affordances. Generate moves to the right-
          column primary CTA per spec; Parameters / Segments toggles
          drop since both panels are always visible in the 3-col grid. */}
      {/* relative z-40 lifts the whole bar above the grid panels and the
          map's z-30 search/POI row so the Export dropdown isn't painted
          under them. Modals (z-40/z-50) render later in the tree and still
          cover it. */}
      <div className="relative z-40 flex items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur-sm">
        {/* Trip identity lives up here (design v2 top bar): the left day
            column only exists after a split, so it can't own the title.
            Header shows a day count ONLY post-split (revision 2 §C). */}
        <div className="flex min-w-0 items-center gap-3">
          <Tooltip content={t("Back to trips")} placement="below">
            <Button
              iconOnly
              size="sm"
              variant="secondary"
              renderLink={({ className, children }) => (
                <Link
                  href="/trips"
                  aria-label={t("Back to trips")}
                  className={className}
                >
                  {children}
                </Link>
              )}
            >
              <ArrowLeft size={15} />
            </Button>
          </Tooltip>
          <span aria-hidden="true" className="h-[22px] w-px shrink-0 bg-line" />
          {/* flex-col so the tooltip-wrapped rename control is a flex item
              (blockified — no inline-flex line-box strut) and the header
              keeps the same height as the read-only preview view. */}
          <div className="flex min-w-0 flex-col">
            {(() => {
              const canRenameTrip =
                Boolean(displayedTrip) && canEditTripMetadata;
              const renameButton = (
                <button
                  type="button"
                  onClick={openRenameDialog}
                  disabled={!canRenameTrip}
                  className="group flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"
                >
                  <h1 className="min-w-0 truncate text-[15px] font-extrabold leading-tight tracking-[-0.3px] text-ink group-hover:text-accent group-disabled:group-hover:text-ink">
                    {tripDisplayName(displayedTrip, t) ?? t("New Trip")}
                  </h1>
                  {canRenameTrip ? (
                    <Pencil
                      size={11}
                      aria-hidden
                      className="shrink-0 text-fg-faint transition group-hover:text-accent"
                    />
                  ) : null}
                </button>
              );
              return canRenameTrip ? (
                <Tooltip
                  content={t("Rename trip")}
                  placement="below"
                  className="min-w-0 max-w-full"
                >
                  {renameButton}
                </Tooltip>
              ) : (
                renameButton
              );
            })()}
            {totalDistanceKm !== null ? (
              <div className="mt-0.5 flex items-center gap-3 whitespace-nowrap text-[11px] text-fg-dim">
                {daysVisible && dayPlans ? (
                  <span className="inline-flex items-center gap-1">
                    <Layers size={11} aria-hidden className="text-fg-faint" />
                    {t("{count, plural, one {# day} other {# days}}", {
                      count: dayPlans.length,
                    })}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <MapPin size={11} aria-hidden className="text-fg-faint" />
                  {format.distanceKm(totalDistanceKm)}
                </span>
                {totalTimeMin !== null ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} aria-hidden className="text-fg-faint" />
                    {`~${format.duration(totalTimeMin)}`}
                  </span>
                ) : null}
                {headerMemberCount !== null ? (
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} aria-hidden className="text-fg-faint" />
                    {t("{count, plural, one {# member} other {# members}}", {
                      count: headerMemberCount,
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Show / hide the left day column — only when there are days to
              reveal. Filled when the column is open, outlined when hidden. */}
          {daysVisible ? (
            <>
              <Tooltip
                content={showDaysColumn ? t("Hide days") : t("Show days")}
                placement="below"
              >
                <Button
                  iconOnly
                  variant={showDaysColumn ? "primary" : "secondary"}
                  size="sm"
                  aria-pressed={showDaysColumn}
                  aria-label={showDaysColumn ? t("Hide days") : t("Show days")}
                  onClick={() => setShowDaysColumn((v) => !v)}
                >
                  <PanelLeft size={15} />
                </Button>
              </Tooltip>
              <span
                aria-hidden="true"
                className="h-[22px] w-px shrink-0 bg-line"
              />
            </>
          ) : null}
          <Tooltip content={t("Undo")} placement="below">
            <Button
              iconOnly
              variant="secondary"
              size="sm"
              aria-label={t("Undo")}
              disabled={!canUndo}
              onClick={undo}
            >
              <RotateCcw size={15} />
            </Button>
          </Tooltip>
          <Tooltip content={t("Redo")} placement="below">
            <Button
              iconOnly
              variant="secondary"
              size="sm"
              aria-label={t("Redo")}
              disabled={!canRedo}
              onClick={redo}
            >
              <RotateCw size={15} />
            </Button>
          </Tooltip>
          <span aria-hidden="true" className="h-[22px] w-px shrink-0 bg-line" />
          <Tooltip content={t("Import GPX")} placement="below">
            <Button
              iconOnly
              variant="secondary"
              size="sm"
              aria-label={t("Import GPX")}
              // Importing mints on save — block it while the own-cap gate is
              // active (at cap, or the cap/count can't be confirmed).
              disabled={mintGateBlocked}
              onClick={() => openImport()}
            >
              <Upload size={15} />
            </Button>
          </Tooltip>
          <TripExportButton trip={displayedTrip} />
          <Tooltip content={t("Fit route")} placement="below">
            <Button
              iconOnly
              variant="secondary"
              size="sm"
              aria-label={t("Fit route")}
              onClick={handleFitRoute}
              disabled={!activeTrip}
            >
              <Maximize2 size={15} />
            </Button>
          </Tooltip>
          {isCollaborator && (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              collapseLabel
              leftIcon={<Lightbulb size={14} />}
              onClick={() => setSuggestionsOpen(true)}
            >
              {t("Suggestions")}
            </Button>
          )}
          {isTripOwner ? (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              collapseLabel
              leftIcon={<Users size={14} />}
              onClick={() =>
                collabEntryBlocked
                  ? setCollabEntryUpsellOpen(true)
                  : setCollaborateOpen(true)
              }
            >
              {t("Collaborate")}
            </Button>
          ) : isCollaborator ? (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              collapseLabel
              loading={leaving}
              leftIcon={<LogOut size={14} />}
              onClick={() => setConfirmLeaveOpen(true)}
            >
              {t("Leave")}
            </Button>
          ) : null}
          {routing && (
            <span className="flex items-center gap-1.5 text-[11px] text-fg-dim">
              <Loader2 size={12} className="animate-spin" />
              {t("Routing…")}
            </span>
          )}
          {/* Save route — live routing path (Task 11). Enabled when the
              active draft has a routed geometry. */}
          <Button
            variant="accent"
            size="sm"
            uppercase
            collapseLabel
            loading={savingRoute}
            leftIcon={<Save size={14} />}
            disabled={
              !canSaveRoute || savingRoute || routing || mintGateBlocked
            }
            onClick={handleSaveRoute}
          >
            {savingRoute ? t("Saving…") : t("Save route")}
          </Button>
          {/* Reset starts over in place — only offered while the route
              is not yet saved (starting a saved trip from blank makes no
              sense); Discard deletes any persisted trip and leaves the
              planner (rider feedback — routes save server-side, so
              backing out needs an explicit discard). Both show from the
              moment the planner opens so the exits are always visible. */}
          {/* Reset (unsaved drafts) and Discard-delete belong to the trip
              owner — a collaborating editor can't delete someone else's
              trip; they Leave instead. */}
          {isTripOwner && (
            <>
              <span
                aria-hidden="true"
                className="h-[22px] w-px shrink-0 bg-line"
              />
              {!resolveExistingTripId(serverTripId, displayedTrip) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPendingConfirm("reset")}
                >
                  {t("Reset")}
                </Button>
              ) : null}
              <Tooltip content={t("Discard")} placement="below">
                <Button
                  iconOnly
                  variant="danger"
                  size="sm"
                  aria-label={t("Discard")}
                  onClick={() => setPendingConfirm("discard")}
                >
                  <Trash2 size={15} />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Phase 2: multi-day option cards return here */}

      {/* Grid — the left day column exists ONLY after a split inside the
          multi-day opt-in (revision 2 §B); otherwise the map takes the
          space. Right panel is always present. When days exist the rider can
          collapse the column via the "Show days" map toggle: the left track
          animates 340px→0 and the map expands into the freed space. */}
      <div
        className={`grid min-h-0 flex-1 transition-[grid-template-columns] duration-300 ease-out ${
          daysVisible
            ? showDaysColumn
              ? "grid-cols-[370px_1fr_370px]"
              : "grid-cols-[0px_1fr_370px]"
            : "grid-cols-[1fr_370px]"
        }`}
      >
        {/* LEFT — itinerary surface: the split's day cards. Absent (not
            empty-state) before a split. */}
        {daysVisible && dayPlans ? (
          <aside
            // Collapsed to a 0px track but kept mounted for the slide
            // animation — `inert` pulls its controls out of the tab order and
            // the a11y tree so keyboard users can't land on hidden buttons.
            inert={!showDaysColumn}
            aria-hidden={!showDaysColumn}
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
              showDaysColumn ? "border-r border-line" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 pb-3 pt-[18px]">
              <span className="whitespace-nowrap font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
                {t("Itinerary · {count, plural, one {# day} other {# days}}", {
                  count: dayPlans.length,
                })}
              </span>
              {/* Focus selected day — moved off the map (rider feedback):
                  dims every non-selected day so the picked day reads clearly.
                  Disabled (with a hint) when no day is selected — there's
                  nothing to focus. */}
              {(() => {
                // Focus needs a materialized day's geometry. Disabled with no
                // pick, and also while an unmaterialized split slice is picked
                // (its per-day route only exists after saving the split).
                const focusDisabled = selectedTripDay == null;
                const focusHint = daySelected
                  ? t("Save the split to focus this day")
                  : t("Select a day to focus");
                const control = (
                  <label className="flex shrink-0 items-center gap-2">
                    <span className="whitespace-nowrap text-[11px] font-semibold text-fg-dim">
                      {t("Focus day")}
                    </span>
                    <Toggle
                      checked={focusSelectedDay && !focusDisabled}
                      onChange={setFocusSelectedDay}
                      disabled={focusDisabled}
                      ariaLabel={t("Focus selected day")}
                    />
                  </label>
                );
                return focusDisabled ? (
                  <Tooltip content={focusHint} placement="below">
                    {control}
                  </Tooltip>
                ) : (
                  control
                );
              })()}
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-5 pt-3">
              {splitStatus === "stale" &&
              (displayedTrip?.days.length ?? 0) <= 1 ? (
                <div className="flex items-center justify-between gap-2 rounded-[10px] border border-accent/40 bg-accent/10 px-3 py-2">
                  <span className="text-[11.5px] font-semibold text-ink">
                    {t("Route changed")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleSplit()}
                    className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.4px] text-ink transition hover:brightness-95"
                  >
                    {t("RE-SPLIT")}
                  </button>
                </div>
              ) : null}
              {/* Same rich "Day-by-day" cards as the read-only preview, wired
                  to the planner's select/route behavior. Dimmed while a split
                  is stale, matching the previous per-card treatment. */}
              <div className={splitStatus === "stale" ? "opacity-45" : ""}>
                <DayByDayList
                  days={dayCards}
                  selectedDayNumber={selectedCardDayNumber}
                  onSelectDay={handleSelectDayCard}
                  showHeading={false}
                />
              </div>
            </div>
          </aside>
        ) : null}

        {/* CENTER — Map canvas + floating multi-day footer card */}
        <div
          className="relative min-h-0 min-w-0 bg-cream"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="absolute inset-0">
            <TripPlannerMap
              ref={mapRef}
              trip={activeTrip}
              month={travelMonth}
              drawnRegion={plannerRegion}
              onDrawnRegionChange={setPlannerRegion}
              onDrawModeChange={setRegionDrawMode}
              onRerouteRequested={armFitAfterRoute}
              closuresData={closuresData}
              passesData={passesData}
              {...(selectedTripDay != null
                ? { selectedDayNumber: selectedTripDay.dayNumber }
                : {})}
              focusSelectedDay={focusSelectedDay && selectedTripDay != null}
              onAddWaypoint={(location) =>
                appendPlannerWaypoint(selectedDayIndex, location, plannerParams)
              }
              onMoveWaypoint={(dayNumber, waypointId, location) =>
                moveWaypoint(dayNumber - 1, waypointId, location, plannerParams)
              }
              onRemoveWaypoint={removeWaypointById}
              collaboratorCursors={collabSession.cursors}
              collaboratorProfiles={collabSession.members}
              // Suggestions are text-only and live in the collaborate modal;
              // don't feed them to the map (they were only ever rendered as a
              // confusing dot auto-anchored to the start waypoint).
              dayBreaks={dayBreakMarkers}
              onMoveDayBreak={handleMoveDayBreak}
              {...(serverTripId
                ? { onCursorMove: collabSession.emitCursor }
                : {})}
              fitRouteToken={fitRouteToken}
              selectedRoadSegmentId={selectedRoadSegmentId}
              onOpenSegmentDetail={setSelectedRoadSegmentId}
            />
          </div>

          {/* Drop overlay */}
          {isDragOver && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10"
            >
              <div className="text-center">
                <FileUp size={40} className="mx-auto mb-2 text-accent" />
                <p className="font-semibold text-accent">
                  {t("Drop to import GPX or KML")}
                </p>
              </div>
            </div>
          )}

          {/* Routing overlay — shown while the live route is computing */}
          {routing && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/40 backdrop-blur-[2px]">
              <div className="flex items-center gap-2 rounded-full bg-paper/90 px-4 py-2 shadow-sm">
                <Loader2 size={16} className="animate-spin text-accent" />
                <p className="text-sm font-medium text-ink">{t("Routing…")}</p>
              </div>
            </div>
          )}

          {/* Road-segment detail drawer (quality history + reviews), the same
              component the road explorer uses. Slides in over the map when an
              inspected span resolves to a real road_segment id. */}
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedRoadSegmentId(null)}
            anchor="viewport"
          />
        </div>

        {/* RIGHT — Plan & inspect panel: BUILD / INSPECT / CONDITIONS /
            STOPS. Every legacy control keeps its selector — BUILD hosts
            the route spine + generation controls, INSPECT the quality
            readout, CONDITIONS the passes/closures panels, STOPS the
            stop suggestions. Panes stay mounted while hidden. */}
        <PlannerPanel
          tab={panelTab}
          onTabChange={setPanelTab}
          build={
            <div className="flex flex-col gap-6">
              <div>
                <div className="flex items-center justify-between">
                  <SectionStamp n={1}>{t("Route")}</SectionStamp>
                  {isRoundtripMode ? (
                    <span className="mb-3 inline-flex items-center gap-1.5 font-mono text-[8.5px] font-bold tracking-[0.4px] text-accent">
                      <span
                        aria-hidden="true"
                        className="h-[7px] w-[7px] rounded-full bg-accent"
                      />
                      {t("ROUNDTRIP")}
                    </span>
                  ) : null}
                </div>
                <WaypointEditor
                  waypoints={selectedDay?.waypoints ?? []}
                  legPrefs={legPrefs}
                  tripPreference={roadPreference}
                  onChangeLegPref={handleChangeLegPref}
                  onRemove={removeWaypointById}
                  onReorder={(fromIndex, toIndex) =>
                    reorderWaypoints(selectedDayIndex, fromIndex, toIndex)
                  }
                  onRelocate={handleRelocateWaypoint}
                  onAddVia={handleAddViaFromSearch}
                  onCreateEndpoint={handleCreateEndpoint}
                />
              </div>

              {/* §02 ROUTE PREFERENCES — collapsed inline summary by
                  default (revision 3 §B): a single derived row; expanding
                  toggles the full controls inline (no modal, map stays
                  visible, changes re-route live). */}
              <div>
                <SectionStamp n={2}>{t("Route preferences")}</SectionStamp>
                <button
                  type="button"
                  aria-expanded={prefsOpen}
                  aria-label={t("Route preferences")}
                  onClick={() => setPrefsOpen((open) => !open)}
                  className={`flex w-full items-center gap-2.5 rounded-[11px] border px-3.5 py-3 text-left transition ${
                    prefsOpen
                      ? "border-accent bg-accent/[0.04]"
                      : "border-line bg-cream hover:border-line-strong"
                  }`}
                >
                  <SlidersHorizontal
                    size={15}
                    className={`shrink-0 ${prefsOpen ? "text-accent" : "text-fg-mute"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      <span className="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-[8px] tracking-[0.5px] text-fg-mute">
                        {sameUserRoutePrefs(
                          currentRoutePrefs,
                          savedRoutePrefs ?? FALLBACK_USER_ROUTE_PREFS,
                        )
                          ? t("SAVED DEFAULTS")
                          : t("CUSTOM")}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-[12px] font-bold text-ink">
                      {buildPrefsSummary(currentRoutePrefs, t)}
                    </span>
                  </span>
                  <ChevronDown
                    size={13}
                    className={`shrink-0 text-fg-mute transition-transform ${
                      prefsOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                <div
                  className={
                    prefsOpen
                      ? "mt-2.5 rounded-[12px] border border-line-strong bg-cream px-3.5 pb-1 pt-3.5"
                      : "hidden"
                  }
                >
                  <p className="mb-3.5 text-[11px] leading-relaxed text-fg-mute">
                    {t(
                      "Applied to every new trip. Changing a value re-draws the route on the map live.",
                    )}
                  </p>
                  {/* Road preference — one card per row (rider
                    preference over the design's 2-col chips): all five
                    characters in the revision 3 §A vocabulary; the loop
                    mode also drives the roundtrip dialog default. */}
                  <div>
                    <label
                      htmlFor="trip-planner-road-preference"
                      className="mb-2 block text-xs font-bold text-fg-dim"
                    >
                      {t("Road preference")}
                    </label>
                    <div className="flex flex-col gap-1.5">
                      {(
                        [
                          {
                            value: "direct",
                            label: t("Direct"),
                            sub: t("Shortest sensible — no fun detours"),
                          },
                          {
                            value: "balanced",
                            label: t("Balanced"),
                            sub: t("Fun and progress in balance"),
                          },
                          {
                            value: "scenic_balance",
                            label: t("Scenic balance"),
                            sub: t("Views + curves mixed"),
                          },
                          {
                            value: "maximum_twisty",
                            label: t("Maximum twisty"),
                            sub: t("Fun-factor first, chain passes"),
                          },
                          {
                            value: "efficient_loop",
                            label: t("Efficient loop"),
                            sub: t("Roundtrips — minimize backtracking"),
                          },
                        ] as ReadonlyArray<{
                          value: RoadPreference;
                          label: string;
                          sub: string;
                        }>
                      ).map((opt) => {
                        const selected = roadPreference === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              handleRoadPreferenceChange(opt.value)
                            }
                            aria-pressed={selected}
                            disabled={!canEditTripMetadata}
                            className={`rounded-[10px] border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              selected
                                ? "border-ink bg-ink text-cream"
                                : "border-line bg-cream hover:border-line-strong"
                            }`}
                          >
                            <span className="block text-[12.5px] font-bold">
                              {opt.label}
                            </span>
                            <span
                              className={`mt-0.5 block text-[11px] ${
                                selected ? "text-cream/70" : "text-fg-mute"
                              }`}
                            >
                              {opt.sub}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {!canEditTripMetadata ? (
                      <p className="mt-2 text-[11.5px] leading-snug text-fg-dim">
                        {t(
                          "The trip-wide road character is set by the trip owner — use per-leg overrides for your edits.",
                        )}
                      </p>
                    ) : null}
                    {/* sr-only select keeps `getByLabelText("Road preference")`
                      + `fireEvent.change` resolvable. */}
                    {/* eslint-disable-next-line no-restricted-syntax -- sr-only
                        AT/test bridge; the visible control is the RadioCardGrid. */}
                    <select
                      id="trip-planner-road-preference"
                      value={toTripRoadPreference(roadPreference)}
                      disabled={!canEditTripMetadata}
                      tabIndex={-1}
                      onChange={(event) =>
                        handleRoadPreferenceChange(
                          fromTripRoadPreference(
                            event.target
                              .value as TripParameters["roadPreference"],
                          ),
                        )
                      }
                      className="sr-only"
                    >
                      <option value="curvy">{t("Maximum curviness")}</option>
                      <option value="scenic">{t("Scenic roads")}</option>
                      <option value="mixed">{t("Mixed (balanced)")}</option>
                      <option value="direct">{t("Direct / efficient")}</option>
                    </select>
                  </div>

                  <div className="mt-4">
                    {/* Owner metadata like the road character above: a member's
                        edit could never persist, only desync the control
                        from the saved value on reload. */}
                    <p className="mb-2 block text-xs font-bold text-fg-dim">
                      {t("Minimum road quality")}
                    </p>
                    <Select
                      value={String(minQuality)}
                      onChange={(value) =>
                        handleMinQualityChange(Number(value))
                      }
                      tone="cream"
                      disabled={!canEditTripMetadata}
                      ariaLabel={t("Minimum road quality")}
                      options={[
                        { value: "1", label: t("Any condition") },
                        { value: "2", label: t("Fair or better") },
                        { value: "3", label: t("Good or better") },
                        { value: "4", label: t("Excellent only") },
                      ]}
                    />
                  </div>

                  <div className="mt-4">
                    <p className="mb-1 block text-xs font-bold text-fg-dim">
                      {t("Surface")}
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {SURFACE_OPTIONS.map((surface) => (
                        <Checkbox
                          key={surface.value}
                          checked={surfacePreference.includes(surface.value)}
                          onChange={() => handleSurfaceToggle(surface.value)}
                          label={t(surface.label)}
                          ariaLabel={t(surface.label)}
                          className="py-1"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-4">
                    <p className="mb-1 block text-xs font-bold text-fg-dim">
                      {t("Avoid")}
                    </p>
                    {/* Short visible labels per the design (the "Avoid"
                        heading carries the context); ariaLabel keeps the
                        long accessible names the tests target. */}
                    <div className="flex flex-col items-start gap-1">
                      <Checkbox
                        checked={avoidHighways}
                        onChange={handleAvoidHighwaysChange}
                        label={t("Motorways")}
                        ariaLabel={t("Avoid motorways")}
                        className="py-1"
                      />
                      <Checkbox
                        checked={avoidTolls}
                        onChange={handleAvoidTollsChange}
                        label={t("Tolls")}
                        ariaLabel={t("Avoid tolls")}
                        className="py-1"
                      />
                      <Checkbox
                        checked={avoidUnpaved}
                        onChange={handleAvoidUnpavedChange}
                        label={t("Unpaved roads")}
                        ariaLabel={t("Avoid unpaved roads")}
                        className="py-1"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* §03 DRAFT ROUTE — the propose action produces the LINE
                  only (revision 2 §E); days never come from here. The
                  section is conditional on waypoint state (rider
                  feedback): the route is LIVE once start + finish exist,
                  so drafting only has a real job while the trip is a
                  roundtrip — with both points set the whole section
                  disappears and the "Route ready" chip speaks instead. */}
              <div>
                {/* sr-only semantic input keeps `getByLabelText("Number of
                    days")` resolvable for the existing tests; drafting
                    itself always proposes a single day's worth of riding. */}
                <label htmlFor="trip-planner-days" className="sr-only">
                  {t("Number of days")}
                </label>
                {/* eslint-disable-next-line no-restricted-syntax -- sr-only
                    AT/test bridge; drafting proposes a single day visually. */}
                <input
                  id="trip-planner-days"
                  type="number"
                  min={1}
                  max={14}
                  value={days}
                  tabIndex={-1}
                  onChange={(event) =>
                    setDays(clampNumberInput(event.target.value, 1, 14, 3))
                  }
                  className="sr-only"
                />

                {isRoundtripMode ? (
                  <>
                    <SectionStamp n={3}>{t("Draft route")}</SectionStamp>
                    {!isLoopRoute ? (
                      <p className="mb-3.5 text-[12px] leading-relaxed text-fg-dim">
                        {t(
                          "No finish set — Tarmoto will loop you back to your start.",
                        )}
                      </p>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="md"
                      block
                      loading={isGenerating}
                      // Drafting a route is wasted effort if the save can't mint
                      // — block it while the own-cap gate is active.
                      disabled={isGenerating || mintGateBlocked}
                      onClick={() => void handleGenerate()}
                    >
                      {isGenerating
                        ? t("Drafting…")
                        : isLoopRoute
                          ? t("Recalculate roundtrip")
                          : t("Draft roundtrip")}
                    </Button>
                    {draftNote ? (
                      <p className="mt-2 text-[11.5px] leading-snug text-fg-dim">
                        {draftNote}
                      </p>
                    ) : null}
                  </>
                ) : null}

                <button
                  type="button"
                  role="checkbox"
                  aria-checked={regionChecked}
                  onClick={handleToggleRegionDraw}
                  className={`mt-4 flex w-full items-center gap-3 rounded-[11px] border px-3.5 py-3 text-left transition ${
                    regionChecked
                      ? "border-accent bg-cream"
                      : "border-line bg-cream hover:border-line-strong"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition ${
                      regionChecked
                        ? "border-accent bg-accent"
                        : "border-line-strong bg-paper"
                    }`}
                  >
                    {regionChecked ? (
                      <Check
                        size={13}
                        strokeWidth={3.5}
                        className="text-cream"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[13px] font-extrabold ${
                        regionChecked ? "text-accent" : "text-ink"
                      }`}
                    >
                      {t("Draw region · Fun Zones")}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-dim">
                      {regionDrawing
                        ? t("Drag a box on the map to scan it.")
                        : plannerRegion
                          ? t(
                              "Region set — drafting keeps the route inside it.",
                            )
                          : t("Find dense clusters of great road.")}
                    </span>
                  </span>
                  <Star
                    size={14}
                    aria-hidden="true"
                    fill="currentColor"
                    className={`shrink-0 ${
                      regionChecked ? "text-accent" : "text-fg-mute"
                    }`}
                  />
                </button>

                {totalDistanceKm !== null && splitStatus === "none" ? (
                  <div className="mt-4 flex items-center gap-2.5 rounded-[10px] border border-quality-q5/40 bg-quality-q5/15 px-3.5 py-2.5">
                    <span
                      aria-hidden="true"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-quality-q5"
                    >
                      <Check size={11} strokeWidth={3.5} className="text-ink" />
                    </span>
                    <p className="text-[12px] leading-snug text-fg-dim">
                      <b className="block text-ink">
                        {totalTimeMin !== null
                          ? t("Route ready — {distance} · ~{time}", {
                              distance: format.distanceKm(totalDistanceKm),
                              time: format.duration(totalTimeMin),
                            })
                          : t("Route ready — {distance}", {
                              distance: format.distanceKm(totalDistanceKm),
                            })}
                      </b>
                      {t("Save it as-is, or add days below.")}
                    </p>
                  </div>
                ) : null}
              </div>

              {/* Everything below is the OPTIONAL day-planning layer
                  (revision 2 §D) — most riders never open it. */}
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[9px] font-bold tracking-[1.2px] text-fg-mute">
                  {t("OPTIONAL")}
                </span>
                <span className="h-px flex-1 bg-line" />
              </div>

              {/* PLAN AS MULTI-DAY TRIP — collapsed by default; expanding
                  it IS the day-planning opt-in (planningMode='multiday').
                  The daily-km input lives here, nowhere else in BUILD. */}
              <details
                className="overflow-hidden rounded-[13px] border border-line-strong bg-cream"
                open={multiDayOpen}
                onToggle={(event) => {
                  const open = (event.target as HTMLDetailsElement).open;
                  setMultiDayOpen(open);
                  if (open) {
                    setPlanningMode("multiday");
                  } else if (splitStatus === "none") {
                    // Collapsing before ever splitting backs out of the
                    // day concept entirely; an existing split keeps it.
                    setPlanningMode("single");
                  }
                }}
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden="true"
                    className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] border border-line bg-paper text-fg-dim"
                  >
                    <CalendarDays size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-extrabold text-ink">
                      {t("Plan as multi-day trip")}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-fg-dim">
                      {t("Add daily stages, stays & viewpoints")}
                    </span>
                  </span>
                  <ChevronDown
                    size={13}
                    className={`shrink-0 text-fg-mute transition-transform ${
                      multiDayOpen ? "rotate-180" : ""
                    }`}
                  />
                </summary>
                <div className="border-t border-line px-4 pb-4 pt-3.5">
                  <label
                    htmlFor="trip-planner-daily-km"
                    className="mb-1 block text-xs text-fg-dim"
                  >
                    {t("Daily km target")}
                  </label>
                  <NumberField
                    id="trip-planner-daily-km"
                    min={100}
                    max={500}
                    step={25}
                    value={dailyKmTarget}
                    onChange={setDailyKmTarget}
                    tone="cream"
                  />
                  <div className="mb-2 mt-4 flex justify-between">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
                      {t("Days")}
                    </span>
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-accent">
                      {forcedDays === null
                        ? t("Auto")
                        : format.integer(forcedDays)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForcedDays(null)}
                    aria-pressed={forcedDays === null}
                    className={`mb-1 w-full rounded-[6px] border py-2 text-center font-mono text-[12px] font-bold transition ${
                      forcedDays === null
                        ? "border-ink bg-ink text-cream"
                        : "border-line bg-cream text-fg-dim hover:text-ink"
                    }`}
                  >
                    {t("Auto (from daily km)")}
                  </button>
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setForcedDays(n);
                          setDays(n);
                        }}
                        aria-label={t(
                          "Force {count, plural, one {# day} other {# days}}",
                          { count: n },
                        )}
                        className={`rounded-[6px] border py-2 text-center font-mono text-[12px] font-bold transition ${
                          forcedDays === n
                            ? "border-ink bg-ink text-cream"
                            : "border-line bg-cream text-fg-dim hover:text-ink"
                        }`}
                      >
                        {format.number(n, {
                          useGrouping: false,
                          maximumFractionDigits: 0,
                        })}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const routeKm = displayedTrip?.days[0]?.distanceKm ?? 0;
                    const perDay = forcedDays ? routeKm / forcedDays : null;
                    return perDay !== null && perDay > 400 ? (
                      <p className="mt-2 text-[11.5px] leading-snug text-quality-q2">
                        {t(
                          "That's over {distance} per day — long days in the saddle. Consider more days or a shorter route.",
                          { distance: format.distanceKm(400) },
                        )}
                      </p>
                    ) : null;
                  })()}
                  <Button
                    variant="accent"
                    size="md"
                    block
                    uppercase
                    className="mt-3"
                    loading={splitting}
                    disabled={
                      splitting ||
                      !displayedTrip?.days[0]?.routeGeometry ||
                      (displayedTrip?.days.length ?? 0) > 1
                    }
                    onClick={() => void handleSplit()}
                  >
                    {splitStatus === "none"
                      ? t("Split into days")
                      : t("Re-split")}
                  </Button>
                  {(displayedTrip?.days.length ?? 0) > 1 ? (
                    <p className="mt-2 text-[11.5px] leading-snug text-fg-dim">
                      {t(
                        "This trip's days are saved — edit them directly; re-splitting applies to a single working route.",
                      )}
                    </p>
                  ) : splitStatus === "stale" ? (
                    <p className="mt-2 text-[11.5px] leading-snug text-accent">
                      {t("Route changed — re-split to refresh the days.")}
                    </p>
                  ) : null}
                </div>
              </details>
            </div>
          }
          inspect={
            <InspectTab
              day={inspectDay}
              selectedSegmentId={selectedPlannerSegmentId}
              plan={inspectPlan}
              onClearPlan={() => setSelectedPlanIndex(null)}
              onInspectSegment={handleInspectSegment}
              onRerouteSegment={handleRerouteSegment}
            />
          }
          conditions={
            <div className="flex flex-col gap-6">
              <div>
                <SectionStamp n={1}>{t("Seasonal passes")}</SectionStamp>
                <PassesPanel
                  month={travelMonth}
                  onMonthChange={setTravelMonth}
                  routes={conditionRoutes}
                  data={tabPassesData}
                  showRegionalList={false}
                  onFocusPass={(pass) =>
                    mapRef.current?.openConditionPopover({
                      kind: "pass",
                      id: pass.id,
                    })
                  }
                  onReroutePass={handleReroutePass}
                />
              </div>
              <div>
                <SectionStamp n={2}>{t("Closures & roadworks")}</SectionStamp>
                <ClosuresPanel
                  month={travelMonth}
                  routes={conditionRoutes}
                  data={tabClosuresData}
                  showRegionalList={false}
                  onFocusClosure={(closure) =>
                    mapRef.current?.openConditionPopover({
                      kind: "closure",
                      id: closure.id,
                    })
                  }
                  onRerouteClosure={handleRerouteClosure}
                />
              </div>
            </div>
          }
          stops={
            <TripStopsPanel
              trip={stopsTrip}
              month={travelMonth}
              onFocusStop={(stop) => mapRef.current?.openPoiPopover(stop)}
            />
          }
        />
      </div>

      <TripImportDialog
        open={importOpen}
        initialFile={pendingImportFile}
        onClose={() => {
          setImportOpen(false);
          setPendingImportFile(null);
        }}
      />

      <TripCollaborateModal
        open={collaborateOpen}
        trip={displayedTrip}
        serverTripId={serverTripId}
        ownerId={serverTripOwnerId}
        currentUserId={currentUserId}
        canCreateInviteLink={canCreateInviteLink}
        suggestions={collabSession.suggestions}
        onSuggestionsChange={collabSession.setSuggestions}
        suggestionsError={collabSession.suggestionsError}
        onPromoted={handlePromotedToServer}
        onClose={() => setCollaborateOpen(false)}
      />

      {/* C2 — the Collaborate entry itself is gated for a persisted trip when
          `collaborative_trips` is off: the owner gets the upsell instead of the
          modal, so they never reach the share/invite controls that would 403. */}
      {collabEntryUpsellOpen && tier ? (
        <UpgradePrompt
          variant="modal"
          capability={{ feature: "collaborative_trips" }}
          currentTier={tier}
          message={t("Collaborating on a saved trip needs Pro.")}
          onClose={() => setCollabEntryUpsellOpen(false)}
        />
      ) : null}

      {/* Non-owner members reach suggestions through their own button. */}
      <TripCollaborateModal
        open={suggestionsOpen}
        mode="suggestions"
        trip={displayedTrip}
        serverTripId={serverTripId}
        ownerId={serverTripOwnerId}
        currentUserId={currentUserId}
        suggestions={collabSession.suggestions}
        onSuggestionsChange={collabSession.setSuggestions}
        suggestionsError={collabSession.suggestionsError}
        onPromoted={handlePromotedToServer}
        onClose={() => setSuggestionsOpen(false)}
      />

      <ConfirmDialog
        open={confirmLeaveOpen}
        title={t("Leave this trip?")}
        message={t(
          "You'll lose access to this trip and return to your trips. The owner can re-invite you later.",
        )}
        tone="danger"
        confirmLabel={t("Leave trip")}
        busy={leaving}
        onCancel={() => setConfirmLeaveOpen(false)}
        onConfirm={() => void handleLeaveTrip()}
      />

      {/* Roundtrip options (revision 3 §E) — keyed on open so each visit
          starts from the last confirmed options (recalculate) or the
          current trip-wide preference (first draft). */}
      <RoundtripDialog
        key={roundtripOpen ? "roundtrip-open" : "roundtrip-closed"}
        open={roundtripOpen}
        defaultPreference={lastRoundtripOpts?.preference ?? roadPreference}
        initialDistanceKm={lastRoundtripOpts?.distanceKm ?? 250}
        initialDirection={lastRoundtripOpts?.direction ?? "random"}
        recalculate={isLoopRoute}
        hasRegion={Boolean(plannerRegion)}
        drafting={isGenerating}
        onClose={() => setRoundtripOpen(false)}
        onConfirm={(opts) => void handleDraftRoundtrip(opts)}
      />

      <ConfirmDialog
        open={renameOpen}
        title={t("Name this trip")}
        message={t("Shown in your trips list and on exports.")}
        confirmLabel={t("Save name")}
        onCancel={() => setRenameOpen(false)}
        onConfirm={confirmRename}
      >
        {/* Implicit form submission keeps the old Enter-to-save behaviour
            without a bespoke onKeyDown on the shared Input. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmRename();
          }}
        >
          <Input
            value={nameDraft}
            autoFocus
            ariaLabel={t("Trip name")}
            onChange={setNameDraft}
          />
        </form>
      </ConfirmDialog>
      <ConfirmDialog
        open={pendingConfirm !== null}
        title={
          pendingConfirm === "discard"
            ? t("Discard this route?")
            : t("Start over?")
        }
        message={
          pendingConfirm === "discard"
            ? t(
                "The route is removed and a saved trip is deleted for good. This cannot be undone.",
              )
            : t("This clears the current route from the planner.")
        }
        tone={pendingConfirm === "discard" ? "danger" : "default"}
        confirmLabel={
          pendingConfirm === "discard" ? t("Discard route") : t("Reset planner")
        }
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const action = pendingConfirm;
          setPendingConfirm(null);
          if (action === "reset") performReset();
          else if (action === "discard") void performDiscard();
        }}
      />

      {(upgradeModalOpen || showProactiveUpgrade) && tier ? (
        <UpgradePrompt
          variant="modal"
          capability={{
            limit: "max_active_trips",
            // A save-path 403 carries the server's authoritative cap; the
            // proactive prompt uses the resolved cap it gated on.
            resolvedLimit: upgradeModalOpen
              ? upgradeModalLimit
              : maxActiveTrips,
          }}
          currentTier={tier}
          // Saving/regenerating someone else's trip is gated by the OWNER's cap
          // (assertCanMintOpenTrip runs on the trip owner). Upgrading the
          // editor's own plan can't free the owner's slot, so suppress the CTA
          // and speak to the owner's limit when the caller isn't the owner.
          suppressUpgrade={!isTripOwner}
          message={
            isTripOwner
              ? t("You've reached your trip limit on the {tier} plan.", {
                  tier: t(tierLabel(tier)),
                })
              : t("The trip owner has reached their trip limit.")
          }
          onClose={() => {
            setUpgradeModalOpen(false);
            setProactiveUpgradeDismissed(true);
          }}
        />
      ) : null}
    </div>
  );
}
/** The placeholder name a fresh planner draft carries until renamed. */
function isDefaultTripName(name: string | undefined): boolean {
  return !name || name === "New Trip";
}

/**
 * Derive a name from the route's endpoints when the rider never set one
 * — "Praha → Brno", or "Praha loop" for roundtrips. Reverse-geocoded
 * "near X" prefixes are stripped for the title.
 */
function deriveDefaultTripName(trip: Trip | null, t: Translate): string | null {
  const day = trip?.days[0];
  if (!day) return null;
  const start = day.waypoints.find((w) => w.type === "start");
  const finish = dayFinishWaypoint(day.waypoints) ?? null;
  const clean = (name: string | undefined) =>
    name?.replace(/^near /i, "").trim() ?? "";
  const startName = clean(start?.name);
  if (!startName) return null;
  const loop =
    !finish || (start !== finish && sameSpot(start!.location, finish.location));
  if (loop) return t("{name} loop", { name: startName });
  const finishName = clean(finish?.name);
  return finishName
    ? t("{start} → {end}", { start: startName, end: finishName })
    : null;
}

/**
 * The trip name we show AND save: the rider's own name, or the derived
 * endpoints name while the placeholder is still in place.
 */
function tripDisplayName(trip: Trip | null, t: Translate): string | null {
  if (!trip) return null;
  if (!isDefaultTripName(trip.name)) return trip.name;
  return deriveDefaultTripName(trip, t) ?? t("New Trip");
}

function clampNumberInput(
  rawValue: string,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
function resolveExistingTripId(
  serverTripId: string | null,
  trip: Trip | null,
): string | null {
  if (serverTripId) return serverTripId;
  if (trip && UUID_RE.test(trip.id)) return trip.id;
  return null;
}
function findCallerRole(
  detail: TripDetailResponse,
  currentUserId: string | null,
): TripDetailMember["role"] | null {
  if (!currentUserId) return null;
  return (
    detail.members?.find((member) => member.user_id === currentUserId)?.role ??
    null
  );
}
function buildTripMetadataPayload(
  trip: Trip,
  params: TripParameters,
  t: Translate,
) {
  const dailyKmTarget = normalizeBackendDailyKm(params.dailyKmTarget);
  return {
    title: tripDisplayName(trip, t) ?? t("New Trip"),
    num_days: params.days,
    min_quality: params.minQuality,
    road_preference: toBackendRoadPreference(params.roadPreference),
    daily_km_min: dailyKmTarget,
    daily_km_max: dailyKmTarget,
  };
}
function buildGenerationPayload(
  params: TripParameters,
  startWaypoint: Waypoint,
  drawnRegion?: RegionDrawBbox | null,
  option?: TripGenerationOptionId,
) {
  const surfaces = generationSurfaces(params);
  const bbox = drawnRegion ? formatBboxParam(drawnRegion) : undefined;
  return {
    start_location: {
      lat: startWaypoint.location.lat,
      lng: startWaypoint.location.lng,
    },
    ...(bbox !== undefined ? { bbox } : {}),
    ...(option !== undefined ? { option } : {}),
    avoid_highways: params.avoidHighways,
    avoid_tolls: params.avoidTolls,
    avoid_unpaved: params.avoidUnpaved,
    ...(surfaces.length ? { surfaces } : {}),
  };
}
function buildGenerationInputSignature(
  trip: Trip | null,
  params: TripParameters,
  drawnRegion?: RegionDrawBbox | null,
): string | null {
  if (!trip) return null;
  const startWaypoint = findStartWaypoint(trip);
  return JSON.stringify({
    params: {
      days: params.days,
      dailyKmTarget: normalizeBackendDailyKm(params.dailyKmTarget),
      roadPreference: params.roadPreference,
      surfacePreference: [...params.surfacePreference].sort(),
      minQuality: params.minQuality,
      avoidHighways: params.avoidHighways,
      avoidTolls: params.avoidTolls,
      avoidUnpaved: params.avoidUnpaved,
    },
    startLocation: startWaypoint
      ? {
          lng: roundCoordinate(startWaypoint.location.lng),
          lat: roundCoordinate(startWaypoint.location.lat),
        }
      : null,
    bbox: drawnRegion ? formatBboxParam(drawnRegion) : null,
  });
}
function findStartWaypoint(trip: Trip | null): Waypoint | null {
  const firstDay = trip?.days[0];
  if (!firstDay) return null;
  return (
    firstDay.waypoints.find((waypoint) => waypoint.type === "start") ??
    firstDay.waypoints[0] ??
    null
  );
}
function generationSurfaces(params: TripParameters): SurfaceType[] {
  return params.avoidUnpaved
    ? params.surfacePreference.filter(
        (surface) => !UNPAVED_SURFACES.has(surface),
      )
    : params.surfacePreference;
}
function toBackendRoadPreference(
  value: TripParameters["roadPreference"],
): "curvy" | "scenic" | "mixed" | "fast" {
  return value === "direct" ? "fast" : value;
}
function writeServerTripIdToUrl(tripId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("tripId", tripId);
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}
type PlannerControls = {
  days: number;
  dailyKmTarget: number;
  roadPreference: TripParameters["roadPreference"];
  surfacePreference: SurfaceType[];
  minQuality: number;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
};
function readPlannerControlsFromUrl(): PlannerControls {
  const search = new URLSearchParams(window.location.search);
  return {
    days: parseClampedIntParam(
      search.get(URL_PARAM_KEYS.days),
      1,
      14,
      PLANNER_DEFAULTS.days,
    ),
    dailyKmTarget: parseClampedIntParam(
      search.get(URL_PARAM_KEYS.dailyKm),
      100,
      500,
      PLANNER_DEFAULTS.dailyKmTarget,
    ),
    roadPreference: parseRoadPreferenceParam(
      search.get(URL_PARAM_KEYS.road),
      PLANNER_DEFAULTS.roadPreference,
    ),
    surfacePreference: parseSurfacesParam(search.get(URL_PARAM_KEYS.surfaces), [
      ...PLANNER_DEFAULTS.surfacePreference,
    ]),
    minQuality: parseClampedIntParam(
      search.get(URL_PARAM_KEYS.minQuality),
      1,
      4,
      PLANNER_DEFAULTS.minQuality,
    ),
    avoidHighways: parseBooleanParam(
      search.get(URL_PARAM_KEYS.avoidHighways),
      PLANNER_DEFAULTS.avoidHighways,
    ),
    avoidTolls: parseBooleanParam(
      search.get(URL_PARAM_KEYS.avoidTolls),
      PLANNER_DEFAULTS.avoidTolls,
    ),
    avoidUnpaved: parseBooleanParam(
      search.get(URL_PARAM_KEYS.avoidUnpaved),
      PLANNER_DEFAULTS.avoidUnpaved,
    ),
  };
}
function parseClampedIntParam(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  // Reuse the same clamp the input handlers go through so a hand-edited
  // URL and an in-app edit can never disagree on what's a valid value.
  return raw === null ? fallback : clampNumberInput(raw, min, max, fallback);
}
function parseBooleanParam(raw: string | null, fallback: boolean): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}
function parseRoadPreferenceParam(
  raw: string | null,
  fallback: TripParameters["roadPreference"],
): TripParameters["roadPreference"] {
  if (raw === null) return fallback;
  return VALID_ROAD_PREFERENCES.includes(
    raw as TripParameters["roadPreference"],
  )
    ? (raw as TripParameters["roadPreference"])
    : fallback;
}
function parseSurfacesParam(
  raw: string | null,
  fallback: SurfaceType[],
): SurfaceType[] {
  if (raw === null) return fallback;
  const seen = new Set<SurfaceType>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (VALID_SURFACES.includes(trimmed as SurfaceType)) {
      seen.add(trimmed as SurfaceType);
    }
  }
  return seen.size > 0 ? Array.from(seen) : fallback;
}
function parseBboxParam(raw: string | null): RegionDrawBbox | null {
  if (raw === null) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [west, south, east, north] = parts;
  if (
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined
  ) {
    return null;
  }
  if (west >= east || south >= north) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  return [
    roundCoordinate(west),
    roundCoordinate(south),
    roundCoordinate(east),
    roundCoordinate(north),
  ];
}
function syncPlannerControlsToUrl(controls: PlannerControls) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const search = url.searchParams;
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.days,
    controls.days !== PLANNER_DEFAULTS.days ? String(controls.days) : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.dailyKm,
    controls.dailyKmTarget !== PLANNER_DEFAULTS.dailyKmTarget
      ? String(controls.dailyKmTarget)
      : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.road,
    controls.roadPreference !== PLANNER_DEFAULTS.roadPreference
      ? controls.roadPreference
      : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.surfaces,
    surfacesEqualDefault(controls.surfacePreference)
      ? null
      : controls.surfacePreference.join(","),
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.minQuality,
    controls.minQuality !== PLANNER_DEFAULTS.minQuality
      ? String(controls.minQuality)
      : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.avoidHighways,
    controls.avoidHighways !== PLANNER_DEFAULTS.avoidHighways
      ? controls.avoidHighways
        ? "1"
        : "0"
      : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.avoidTolls,
    controls.avoidTolls !== PLANNER_DEFAULTS.avoidTolls
      ? controls.avoidTolls
        ? "1"
        : "0"
      : null,
  );
  setOrDeleteParam(
    search,
    URL_PARAM_KEYS.avoidUnpaved,
    controls.avoidUnpaved !== PLANNER_DEFAULTS.avoidUnpaved
      ? controls.avoidUnpaved
        ? "1"
        : "0"
      : null,
  );
  const nextSearch = search.toString();
  const currentSearch = window.location.search.replace(/^\?/, "");
  if (nextSearch === currentSearch) return;
  const suffix = nextSearch ? `?${nextSearch}` : "";
  window.history.replaceState({}, "", `${url.pathname}${suffix}${url.hash}`);
}
function syncPlannerRegionToUrl(region: RegionDrawBbox | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setOrDeleteParam(
    url.searchParams,
    URL_PARAM_KEYS.bbox,
    region ? formatBboxParam(region) : null,
  );
  const nextSearch = url.searchParams.toString();
  const currentSearch = window.location.search.replace(/^\?/, "");
  if (nextSearch === currentSearch) return;
  const suffix = nextSearch ? `?${nextSearch}` : "";
  window.history.replaceState({}, "", `${url.pathname}${suffix}${url.hash}`);
}
function formatBboxParam(bbox: RegionDrawBbox): string {
  return bbox.map((value) => String(roundCoordinate(value))).join(",");
}
function bboxEqual(
  a: RegionDrawBbox | null,
  b: RegionDrawBbox | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.every((value, index) => value === b[index]);
}
function setOrDeleteParam(
  search: URLSearchParams,
  key: string,
  value: string | null,
) {
  if (value === null) {
    search.delete(key);
  } else {
    search.set(key, value);
  }
}
function surfacesEqualDefault(surfaces: SurfaceType[]): boolean {
  if (surfaces.length !== PLANNER_DEFAULTS.surfacePreference.length) {
    return false;
  }
  const expected = new Set<SurfaceType>(PLANNER_DEFAULTS.surfacePreference);
  for (const surface of surfaces) {
    if (!expected.has(surface)) return false;
  }
  return true;
}
function normalizeBackendDailyKm(value: number) {
  if (!Number.isFinite(value)) return MIN_BACKEND_DAILY_KM;
  return Math.max(MIN_BACKEND_DAILY_KM, Math.round(value));
}
function roundCoordinate(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}
async function cleanupCreatedTrip(tripId: string) {
  try {
    await tripsApi.delete(tripId);
  } catch (cleanupError) {
    console.warn("Failed to clean up ungenerated trip", cleanupError);
  }
}
function buildImportedRoutePayload(trip: Trip, t: Translate) {
  if (!trip.id.startsWith("imported-")) return null;
  const firstDay = trip.days[0];
  const coordinates = firstDay?.routeGeometry?.coordinates ?? [];
  if (coordinates.length < 2) return null;
  return {
    title: tripDisplayName(trip, t) ?? t("New Trip"),
    source_format: trip.importSourceFormat ?? "gpx",
    geometry: coordinates.flatMap(([lng, lat]) =>
      lng !== undefined && lat !== undefined ? [{ lng, lat }] : [],
    ),
    waypoints: (firstDay?.waypoints ?? []).map((waypoint) => {
      const payload: {
        lat: number;
        lng: number;
        name?: string;
        type?: "via" | "fuel" | "rest" | "photo";
      } = {
        lat: waypoint.location.lat,
        lng: waypoint.location.lng,
      };
      // Every non-blank imported label is source data. Do not run the legacy
      // generated-role matcher here: a GPX/KML place may genuinely be named
      // "Start", "End", "Via 1", or another former planner placeholder.
      if (waypoint.name?.trim()) payload.name = waypoint.name;
      if (IMPORTABLE_WAYPOINT_TYPES.has(waypoint.type)) {
        payload.type = waypoint.type as "via" | "fuel" | "rest" | "photo";
      }
      return payload;
    }),
  };
}
const EMPTY_LEG_PREFS: LegPref[] = [];

const SPINE_ROLE_COLORS: Record<string, string> = {
  start: "#1F8A5B",
  via: "#1FA6B8",
  end: "#FF6A1A",
};

// Fixed 7-member Waypoint["type"] union — typed so `t()` enforces every
// role label is a registered catalog key (was a `tDynamic(role)` escape
// hatch that hid "fuel"/"rest"/"accommodation" from the compiler).
const WAYPOINT_ROLE_LABEL = {
  start: "start",
  via: "via",
  end: "finish",
  fuel: "fuel",
  rest: "rest",
  photo: "photo",
  accommodation: "accommodation",
} satisfies Record<Waypoint["type"], EnglishMessageKey>;

function WaypointEditor({
  waypoints,
  legPrefs = [],
  tripPreference = "direct",
  onChangeLegPref,
  onRemove,
  onReorder,
  onRelocate,
  onAddVia,
  onCreateEndpoint,
}: {
  waypoints: Array<{
    id: string;
    name?: string | undefined;
    type: Waypoint["type"];
  }>;
  /** Per-leg road filters (revision 3 §C), keyed by waypoint identity. */
  legPrefs?: LegPref[];
  tripPreference?: RoadPreference;
  onChangeLegPref?: (
    fromWaypointId: string,
    preference: LegPref["preference"],
  ) => void;
  /** Remove a waypoint from the spine (roles re-derive from position). */
  onRemove?: (waypointId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRelocate?: (waypointId: string, result: GeoResult) => void;
  onAddVia?: (result: GeoResult) => void;
  onCreateEndpoint?: (role: "start" | "end", result: GeoResult) => void;
}) {
  const t = useTranslation();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [addingVia, setAddingVia] = useState(false);
  // Which leg's road-type picker is expanded (fromWaypointId), if any.
  const [openLegFrom, setOpenLegFrom] = useState<string | null>(null);
  const hasStart = waypoints.some((w) => w.type === "start");
  const hasFinish = waypoints.some(
    (w, index) =>
      w.type === "end" ||
      (w.type === "accommodation" && index === waypoints.length - 1),
  );
  return (
    <div className="space-y-2">
      {/* Empty endpoint rows: the spine always shows START and FINISH so
          the rider can fill them by typing a place here OR by clicking
          the map — whichever comes first. */}
      {!hasStart && onCreateEndpoint ? (
        <div className="relative flex items-center gap-2.5 rounded-[10px] border border-line bg-cream px-3 py-2.5">
          <span
            aria-hidden="true"
            className="h-[9px] w-[9px] shrink-0 rounded-full"
            style={{ background: SPINE_ROLE_COLORS.start }}
          />
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("start")}
            </span>
            <GeocodeSearchField
              placeholder={t("Type a place or click the map…")}
              ariaLabel={t("Search location for start waypoint")}
              onSelect={(result) => onCreateEndpoint("start", result)}
              clearOnSelect
            />
          </div>
        </div>
      ) : null}
      {waypoints.map((waypoint, index) => {
        const role = WAYPOINT_ROLE_LABEL[waypoint.type];
        const displayName = waypointDisplayName(waypoint, t);
        const dotColor = SPINE_ROLE_COLORS[waypoint.type] ?? "#A89D8B";
        // Thin LEG row between consecutive routing waypoints (revision 3
        // §C): its road-type control overrides the trip-wide preference
        // for just that stretch.
        const legAfter = legPrefs.find(
          (leg) => leg.fromWaypointId === waypoint.id,
        );
        return (
          <Fragment key={waypoint.id}>
            <div
              draggable
              onDragStart={() => {
                setDragIndex(index);
              }}
              onDragOver={(event) => {
                if (dragIndex === null) return;
                event.preventDefault();
              }}
              onDrop={() => {
                if (dragIndex === null || dragIndex === index) {
                  setDragIndex(null);
                  return;
                }
                onReorder(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              // `relative` so the spine geocode dropdown anchors to this whole
              // field wrapper (matching its width) rather than the inner input.
              className="relative flex items-center gap-2.5 rounded-[10px] border border-line bg-cream px-3 py-2.5"
            >
              <GripVertical
                size={13}
                className="shrink-0 cursor-grab text-fg-mute"
              />
              <span
                aria-hidden="true"
                className="h-[9px] w-[9px] shrink-0 rounded-full"
                style={{ background: dotColor }}
              />
              <div className="min-w-0 flex-1">
                <span className="block font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
                  {t(role)}
                </span>
                {onRelocate ? (
                  // The name line is a typed geocode search: the current
                  // name is the placeholder, so the row reads like a label
                  // until the rider types a new place.
                  <GeocodeSearchField
                    variant="spine"
                    placeholder={displayName}
                    ariaLabel={t("Search location for {role} waypoint", {
                      role: t(role),
                    })}
                    onSelect={(result) => onRelocate(waypoint.id, result)}
                  />
                ) : (
                  <span className="block truncate text-[13px] font-bold text-ink">
                    {displayName}
                  </span>
                )}
              </div>
              {onRemove ? (
                <button
                  type="button"
                  aria-label={t("Remove {name}", {
                    name: displayName,
                  })}
                  onClick={() => onRemove(waypoint.id)}
                  className="shrink-0 rounded p-0.5 text-fg-mute transition hover:text-quality-q1"
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
            {legAfter && onChangeLegPref ? (
              <div className="relative pl-[21px]">
                <div
                  aria-hidden="true"
                  className="absolute bottom-[-6px] left-[8.5px] top-[-6px] w-px bg-line-strong"
                />
                <button
                  type="button"
                  aria-expanded={openLegFrom === legAfter.fromWaypointId}
                  aria-label={t("Road type for this leg")}
                  onClick={() =>
                    setOpenLegFrom((current) =>
                      current === legAfter.fromWaypointId
                        ? null
                        : legAfter.fromWaypointId,
                    )
                  }
                  className={`my-[3px] flex w-full items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left transition ${
                    legAfter.preference === "inherit"
                      ? "border-transparent bg-paper"
                      : "border-accent/50 bg-accent/10"
                  }`}
                >
                  <MoveRight size={12} className="shrink-0 text-fg-mute" />
                  <span className="shrink-0 font-mono text-[8.5px] text-fg-mute">
                    {t("LEG")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-fg-dim">
                    {legAfter.preference === "inherit"
                      ? t("Trip default")
                      : t(ROAD_PREFERENCE_LABELS[legAfter.preference])}
                  </span>
                  {legAfter.preference !== "inherit" ? (
                    <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.4px] text-accent">
                      {t("CUSTOM")}
                    </span>
                  ) : null}
                  <ChevronDown
                    size={12}
                    className={`shrink-0 text-fg-mute transition-transform ${
                      openLegFrom === legAfter.fromWaypointId
                        ? "rotate-180"
                        : ""
                    }`}
                  />
                </button>
                {openLegFrom === legAfter.fromWaypointId ? (
                  <div className="mb-1.5 flex flex-col gap-1 rounded-[8px] border border-line bg-cream p-1.5">
                    {(
                      [
                        ["inherit", t("Trip default")] as const,
                        ...POINT_TO_POINT_PREFERENCES.map(
                          (preference) =>
                            [
                              preference,
                              t(ROAD_PREFERENCE_LABELS[preference]),
                            ] as const,
                        ),
                      ] as ReadonlyArray<[LegPref["preference"], string]>
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={legAfter.preference === value}
                        onClick={() => {
                          onChangeLegPref(legAfter.fromWaypointId, value);
                          setOpenLegFrom(null);
                        }}
                        className={`rounded-[6px] px-2.5 py-1.5 text-left text-[11.5px] font-semibold transition ${
                          legAfter.preference === value
                            ? "bg-ink text-cream"
                            : "text-fg-dim hover:bg-paper hover:text-ink"
                        }`}
                      >
                        {value === "inherit"
                          ? t("{label} · {preference}", {
                              label,
                              preference: t(
                                ROAD_PREFERENCE_LABELS[tripPreference],
                              ),
                            })
                          : label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Fragment>
        );
      })}
      {!hasFinish && onCreateEndpoint ? (
        <div className="relative flex items-center gap-2.5 rounded-[10px] border border-line bg-cream px-3 py-2.5">
          <span
            aria-hidden="true"
            className="h-[9px] w-[9px] shrink-0 rounded-full"
            style={{ background: SPINE_ROLE_COLORS.end }}
          />
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[8.5px] font-bold uppercase tracking-[1.2px] text-fg-mute">
              {t("finish")}
            </span>
            <GeocodeSearchField
              placeholder={t("Type a place or click the map…")}
              ariaLabel={t("Search location for finish waypoint")}
              onSelect={(result) => onCreateEndpoint("end", result)}
              clearOnSelect
            />
          </div>
        </div>
      ) : null}
      {onAddVia && waypoints.length >= 2 ? (
        addingVia ? (
          <div className="relative flex items-center gap-2.5 rounded-[10px] border border-dashed border-line-strong bg-transparent px-3 py-2.5">
            <span
              aria-hidden="true"
              className="h-[9px] w-[9px] shrink-0 rounded-full"
              style={{ background: SPINE_ROLE_COLORS.via }}
            />
            <GeocodeSearchField
              placeholder={t("Search a place…")}
              ariaLabel={t("Search location for a new via point")}
              autoFocus
              clearOnSelect
              onSelect={(result) => {
                onAddVia(result);
                setAddingVia(false);
              }}
            />
            <button
              type="button"
              aria-label={t("Cancel adding via point")}
              onClick={() => setAddingVia(false)}
              className="shrink-0 font-mono text-[10px] font-bold text-fg-mute transition hover:text-ink"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingVia(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong bg-transparent px-3 py-2.5 text-[12.5px] font-bold text-fg-dim transition hover:border-ink hover:text-ink"
          >
            <Plus size={13} />
            {t("Add via point")}
          </button>
        )
      ) : null}
    </div>
  );
}
