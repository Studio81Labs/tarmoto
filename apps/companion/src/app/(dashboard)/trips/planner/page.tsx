"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Checkbox, NumberField, Select } from "@tarmoto/ui";
import { useTripStore } from "@/stores/trip";
import {
  ArrowLeft,
  Save,
  Clock3,
  GripVertical,
  MapPin,
  Milestone,
  ShieldCheck,
  RotateCcw,
  RotateCw,
  Users,
  Upload,
  FileUp,
  Maximize2,
  Loader2,
} from "lucide-react";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { PassesPanel } from "@/components/PassesPanel";
import { TripPlannerMap } from "@/components/TripPlannerMap";
import type { TripPlannerMapHandle } from "@/components/TripPlannerMap";
import { TripStopsPanel } from "@/components/TripStopsPanel";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { TripExportMenu } from "@/components/TripExportMenu";
import { TripImportDialog } from "@/components/TripImportDialog";
import type { RegionDrawBbox } from "@/components/map/RegionDrawControl";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { usePlannerRouting } from "@/hooks/usePlannerRouting";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import { useAuthStore } from "@/stores/auth";
import { tripsApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { DEMO_TRIP } from "@/lib/demo-trip";
import { UNPAVED_SURFACES } from "@/lib/surface-preferences";
import {
  generatedOptionsFromResponse,
  selectedGeneratedOption,
  type GenerateTripResponse,
  type GeneratedTripOption,
  type TripGenerationOptionId,
} from "@/lib/trip-generation-options";
import { currentUtcMonth } from "@/lib/passes-summary";
import { filterRoutingWaypoints } from "@/lib/trip-routing";
import {
  findOwnerId,
  tripFromDetail,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import type { SurfaceType, Trip, TripParameters, Waypoint } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
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
  label: string;
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
  roadPreference: "mixed" as TripParameters["roadPreference"],
  surfacePreference: ["asphalt"] as SurfaceType[],
  minQuality: 3,
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
} as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const [importOpen, setImportOpen] = useState(false);
  const [collaborateOpen, setCollaborateOpen] = useState(false);
  // Controlled Advanced disclosure — starts open (Playwright e2es +
  // closures / route-builder warnings the rider relies on need the
  // children visible on first render) and respects subsequent user
  // toggles via the native `<details>` onToggle event. A hardcoded
  // `open` attribute would re-open the section on every parent
  // re-render, clobbering user collapses.
  const [advancedOpen, setAdvancedOpen] = useState(true);
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
  const router = useRouter();
  const [dailyKmTarget, setDailyKmTarget] = useState<number>(
    PLANNER_DEFAULTS.dailyKmTarget,
  );
  const [roadPreference, setRoadPreference] = useState<
    TripParameters["roadPreference"]
  >(PLANNER_DEFAULTS.roadPreference);
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
  // Stable selector identity — the store fn is recreated each call, but
  // we select the *day 0 waypoints array* so useMemo below only fires
  // when the waypoints array actually changes (reference equality).
  const activeDayWaypoints = useTripStore(
    (s) => s.activeTrip?.days[0]?.waypoints ?? null,
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
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const displayedTrip = activeTrip ?? selectedOption?.trip ?? null;
  // ── Live routing (Task 11) ────────────────────────────────────────
  // Memoize both inputs so the hook's effect only re-fires when the
  // actual data changes — not on every parent render.
  // We derive the routing waypoints directly from `activeDayWaypoints`
  // (the store selector above) so this memo is driven by the waypoints
  // array reference rather than by calling `getState()` inside render.
  const routingWaypoints = useMemo(() => {
    if (!activeDayWaypoints) return [] as { lat: number; lng: number }[];
    return filterRoutingWaypoints(activeDayWaypoints).map((w) => ({
      lat: w.location.lat,
      lng: w.location.lng,
    }));
  }, [activeDayWaypoints]);
  const routeOptions = useMemo(
    () => ({
      avoid_highways: avoidHighways,
      avoid_tolls: avoidTolls,
      avoid_unpaved: avoidUnpaved,
    }),
    [avoidHighways, avoidTolls, avoidUnpaved],
  );
  const { routing } = usePlannerRouting(
    routingWaypoints,
    routeOptions,
    applyRouteResult,
    (msg) => toast.error(msg),
  );
  // ── Collab session wiring (US-35) ─────────────────────────────────
  // `?tripId=<uuid>` on the URL activates the collab surface: the
  // socket joins `trip:<id>`, cursors + suggestions + activity start
  // flowing, and the Suggestions / Activity tabs in the modal light up.
  const [serverTripId, setServerTripId] = useState<string | null>(null);
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
    serverTripCallerRole === "admin";
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
      const hydrated = tripFromDetail(detail);
      setActiveTrip(hydrated);
      setServerTripOwnerId(findOwnerId(detail));
      setServerTripCallerRole(findCallerRole(detail, currentUserId));
      // Mirror the REST hydration path below: the planner's control
      // strip (days / dailyKmTarget / road preference / surfaces /
      // minQuality / avoid* toggles) is local React state, NOT
      // derived from `activeTrip`, so a remote regenerate that
      // changed `num_days` would otherwise leave the controls stuck
      // at their old values — and the next local Save would
      // re-serialize the stale controls back to the server, undoing
      // the collaborator's just-committed change.
      const params = hydrated.parameters;
      setDays(params.days);
      setDailyKmTarget(params.dailyKmTarget);
      setRoadPreference(params.roadPreference);
      setSurfacePreference(params.surfacePreference);
      setMinQuality(params.minQuality);
      setAvoidHighways(params.avoidHighways);
      setAvoidTolls(params.avoidTolls);
      setAvoidUnpaved(params.avoidUnpaved);
    },
    [currentUserId, serverTripId, setActiveTrip],
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
    // Read `?tripId=` in a client-only effect to keep the planner page
    // statically prerenderable. `useSearchParams` would pull the whole
    // tree into the dynamic render path.
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("tripId");
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
          setRoadPreference(params.roadPreference);
          setSurfacePreference(params.surfacePreference);
          setMinQuality(params.minQuality);
          setAvoidHighways(params.avoidHighways);
          setAvoidTolls(params.avoidTolls);
          setAvoidUnpaved(params.avoidUnpaved);
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
      roadPreference,
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
  const closureRoutes = useMemo(
    () => buildTripClosureRoutes(displayedTrip),
    [displayedTrip],
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
  const selectedDay = activeTrip?.days[selectedDayIndex] ?? null;
  type TimelineDayLike = {
    dayNumber: number;
    title?: string;
    distanceKm?: number;
    elevationGain?: number;
    durationMinutes?: number;
    overnightStop?: { name: string };
  };
  const timelineDays: TimelineDayLike[] = activeTrip?.days ?? [
    { dayNumber: 1 },
    { dayNumber: 2 },
    { dayNumber: 3 },
  ];
  const openImport = useCallback((file: File | null = null) => {
    setPendingImportFile(file);
    setImportOpen(true);
  }, []);
  useEffect(() => {
    if (!activeTrip) {
      setSelectedDayIndex(0);
      return;
    }
    if (selectedDayIndex > activeTrip.days.length - 1) {
      setSelectedDayIndex(Math.max(0, activeTrip.days.length - 1));
    }
  }, [activeTrip, selectedDayIndex]);
  const handleSave = useCallback(async () => {
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
      const importedRoutePayload = buildImportedRoutePayload(displayedTrip);
      if (displayedTrip.id.startsWith("imported-") && !importedRoutePayload) {
        toast.error(
          "Imported routes need at least two route points before saving.",
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
          "Select at least one paved surface or turn off Avoid unpaved roads before saving.",
        );
        setSaving(false);
        return;
      }
      // Generate the route using the first waypoint as start_location.
      const firstDay = displayedTrip.days[0];
      const startWp = firstDay?.waypoints[0];
      if (!startWp) {
        toast.error("Add a start waypoint before saving this trip.");
        setSaving(false);
        return;
      }
      const basePayload = buildTripMetadataPayload(displayedTrip, p);
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
      toast.error("Could not save this trip. Please try again.");
      console.warn("Failed to save trip", err);
      setSaving(false);
    }
  }, [
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
  // ── Save Route (Task 11) ─────────────────────────────────────────
  // Enabled only when the active draft has at least 2 routing waypoints
  // and the first day carries route geometry (i.e. the live hook already
  // resolved a route). Calls PUT /trips/:id/route — creates the server
  // trip on first save if one doesn't exist yet.
  const activeDayRouteGeometry = activeTrip?.days[0]?.routeGeometry ?? null;
  const canSaveRoute =
    routingWaypoints.length >= 2 && activeDayRouteGeometry !== null;
  const [savingRoute, setSavingRoute] = useState(false);
  const handleSaveRoute = useCallback(async () => {
    if (savingRoute || routing) return;
    // Resolve or lazily create the backend trip. Reuse the same pattern
    // as the existing handleSave so collab/deep-link trips are updated
    // in place rather than duplicated.
    const currentTrip = activeTripRef.current;
    const existingTripId = resolveExistingTripId(serverTripId, currentTrip);
    // Use the store's saveWaypoints() to derive the canonical waypoint list.
    // Calling getState() inside a click handler / useCallback is safe Zustand
    // pattern — it reads current state without subscribing to re-renders.
    const wps = useTripStore.getState().saveWaypoints();
    if (wps.length < 2) {
      toast.error(t("Add at least a start and end before saving."));
      return;
    }
    setSavingRoute(true);
    try {
      let tripId = existingTripId;
      if (!tripId) {
        // No server trip yet — create metadata first (same pattern as
        // handleSave) so we have a backend id to PUT the route against.
        const basePayload = currentTrip
          ? buildTripMetadataPayload(currentTrip, plannerParams)
          : buildTripMetadataPayload(
              { name: "New Trip" } as Parameters<
                typeof buildTripMetadataPayload
              >[0],
              plannerParams,
            );
        const { data: created } = await tripsApi.create(basePayload);
        tripId =
          (
            created as {
              id?: string;
            }
          ).id ?? null;
        if (!tripId) throw new Error("Trip creation did not return an id");
      }
      // The route endpoint only accepts "start" | "end" | "via" — map all
      // other waypoint types (fuel, rest, photo, accommodation) to "via".
      const routeWaypoints = wps.map((wp) => ({
        lat: wp.lat,
        lng: wp.lng,
        ...(wp.name ? { name: wp.name } : {}),
        type: (wp.type === "start" || wp.type === "end" ? wp.type : "via") as
          | "start"
          | "end"
          | "via",
      }));
      const { data } = await tripsApi.saveRoute(tripId, {
        waypoints: routeWaypoints,
        options: routeOptions,
      });
      const hydrated = tripFromDetail(
        data as unknown as Parameters<typeof tripFromDetail>[0],
      );
      setActiveTrip(hydrated);
      if (!existingTripId) {
        // First save — wire up collab + URL
        handlePromotedToServer(tripId);
      }
      toast.success(t("Route saved"));
    } catch {
      toast.error(t("Could not save the route. Please try again."));
    } finally {
      setSavingRoute(false);
    }
  }, [
    savingRoute,
    routing,
    serverTripId,
    plannerParams,
    routeOptions,
    setActiveTrip,
    handlePromotedToServer,
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
  const handleSurfaceToggle = useCallback((surface: SurfaceType) => {
    setSurfacePreference((current) => {
      if (current.includes(surface)) {
        return current.length === 1
          ? current
          : current.filter((value) => value !== surface);
      }
      return [...current, surface];
    });
  }, []);
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
    setRoadPreference(params.roadPreference);
    setSurfacePreference(params.surfacePreference);
    setMinQuality(params.minQuality);
    setAvoidHighways(params.avoidHighways);
    setAvoidTolls(params.avoidTolls);
    setAvoidUnpaved(params.avoidUnpaved);
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
        setRoadPreference(fromUrl.roadPreference);
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
      roadPreference,
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
    const validationError = validateGenerationInput(
      activeTripAtStart,
      plannerParams,
    );
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    generationLockRef.current = true;
    setGenerating(true);
    let createdTripId: string | null = null;
    try {
      if (!activeTripAtStart) return;
      const generationInputAtStart = buildGenerationInputSignature(
        activeTripAtStart,
        plannerParams,
        plannerRegion,
      );
      const existingTripId = resolveExistingTripId(
        serverTripId,
        activeTripAtStart,
      );
      const metadataPayload = buildTripMetadataPayload(
        activeTripAtStart,
        plannerParams,
      );
      const { data: saved } = existingTripId
        ? await tripsApi.update(existingTripId, metadataPayload)
        : await tripsApi.create(metadataPayload);
      const tripId =
        (
          saved as {
            id?: string;
          }
        ).id ?? existingTripId;
      if (!tripId) {
        throw new Error("Trip generation response did not include an id");
      }
      if (!existingTripId) createdTripId = tripId;
      const startWaypoint = findStartWaypoint(activeTripAtStart);
      if (!startWaypoint) {
        throw new Error("Missing start waypoint");
      }
      const { data } = await tripsApi.generate(
        tripId,
        buildGenerationPayload(plannerParams, startWaypoint, plannerRegion),
      );
      const latestTrip = activeTripRef.current;
      const latestTripId = latestTrip?.id ?? null;
      const latestTripMatchesRequest =
        latestTripId !== null &&
        (latestTripId === activeTripAtStart.id || latestTripId === tripId);
      const generationInputNow = buildGenerationInputSignature(
        latestTrip,
        plannerParams,
        plannerRegion,
      );
      if (
        !isMountedRef.current ||
        requestTokenRef.current !== requestToken ||
        !latestTripMatchesRequest ||
        generationInputNow !== generationInputAtStart
      ) {
        if (createdTripId) {
          await cleanupCreatedTrip(createdTripId);
        }
        return;
      }
      const response = data as GenerateTripResponse;
      const options = generatedOptionsFromResponse(response, plannerParams);
      const selected =
        selectedGeneratedOption(options, response.selected_option) ?? null;
      setGeneratedOptions(options);
      setGeneratedOptionsSignature(
        buildGenerationInputSignature(
          selected?.trip ?? null,
          plannerParams,
          plannerRegion,
        ),
      );
      setSelectedOptionId(selected?.id ?? null);
      setActiveTrip(selected?.trip ?? null);
      setFitRouteToken((t) => t + 1);
      setServerTripId(tripId);
      setServerTripOwnerId(currentUserId);
      setServerTripCallerRole("owner");
      writeServerTripIdToUrl(tripId);
    } catch {
      if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
        return;
      }
      if (createdTripId) {
        await cleanupCreatedTrip(createdTripId);
      }
      toast.error("Could not generate itinerary options right now.");
    } finally {
      if (requestTokenRef.current === requestToken) {
        generationLockRef.current = false;
        if (isMountedRef.current) {
          setGenerating(false);
        }
      }
    }
  }, [
    currentUserId,
    plannerParams,
    plannerRegion,
    serverTripId,
    setActiveTrip,
    setGenerating,
  ]);
  const handleSelectOption = useCallback(
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
        toast.error("Add a start waypoint before selecting this route.");
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
      } catch {
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        toast.error("Could not select this route option. Please try again.");
      } finally {
        if (requestTokenRef.current === requestToken) {
          generationLockRef.current = false;
          if (isMountedRef.current) {
            setGenerating(false);
          }
        }
      }
    },
    [plannerParams, plannerRegion, serverTripId, setActiveTrip, setGenerating],
  );
  const totalDistanceKm = useMemo(() => {
    if (!displayedTrip) return null;
    const sum = displayedTrip.days.reduce(
      (acc, day) => acc + (day.distanceKm ?? 0),
      0,
    );
    return sum > 0 ? Math.round(sum) : null;
  }, [displayedTrip]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-cream">
      {/* Slim top toolbar — keeps Save / Undo / Redo / Import / Export /
          Collaborate / Demo affordances. Generate moves to the right-
          column primary CTA per spec; Parameters / Segments toggles
          drop since both panels are always visible in the 3-col grid. */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur-sm">
        <h1 className="min-w-0 truncate text-sm font-semibold text-ink">
          {displayedTrip?.name ?? t("New Trip")}
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RotateCcw size={14} />}
            disabled={!canUndo}
            onClick={undo}
          >
            {t("Undo")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RotateCw size={14} />}
            disabled={!canRedo}
            onClick={redo}
          >
            {t("Redo")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Upload size={14} />}
            onClick={() => openImport()}
          >
            {t("Import GPX")}
          </Button>
          <TripExportMenu trip={displayedTrip} context="planner" />
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Users size={14} />}
            onClick={() => setCollaborateOpen(true)}
          >
            {t("Collaborate")}
          </Button>
          {routing && (
            <span className="flex items-center gap-1.5 text-[11px] text-fg-dim">
              <Loader2 size={12} className="animate-spin" />
              {t("Routing…")}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Maximize2 size={14} />}
            onClick={handleFitRoute}
            disabled={!activeTrip}
            title={t("Fit route")}
          >
            {t("Fit route")}
          </Button>
          {/* Save route — live routing path (Task 11). Enabled when the
              active draft has a routed geometry. */}
          <Button
            variant="accent"
            size="sm"
            uppercase
            loading={savingRoute}
            leftIcon={<Save size={14} />}
            disabled={!canSaveRoute || savingRoute || routing}
            onClick={handleSaveRoute}
          >
            {savingRoute ? t("Saving…") : t("Save route")}
          </Button>
          {!displayedTrip && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setGeneratedOptions([]);
                setGeneratedOptionsSignature(null);
                setSelectedOptionId(null);
                setActiveTrip(DEMO_TRIP);
              }}
            >
              {t("Load demo trip")}
            </Button>
          )}
        </div>
      </div>

      {/* Phase 2: multi-day option cards return here */}

      {/* 3-column grid — left legs, center map (+ floating footer card),
          right parameters. Spec: v2-pages.jsx Trip Planner. */}
      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr_340px]">
        {/* LEFT — back link + spec header + scrollable legs list */}
        <aside className="flex min-h-0 flex-col border-r border-line">
          <div className="border-b border-line px-5 pb-3 pt-[18px]">
            <Link
              href="/trips"
              className="mb-2.5 inline-flex items-center gap-1.5 text-[12px] text-fg-dim transition hover:text-ink"
            >
              <ArrowLeft size={14} />
              {t("Trips")}
            </Link>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
                {t("Route · Day {n} of {total}", {
                  n: selectedDayIndex + 1,
                  total: Math.max(1, timelineDays.length),
                })}
              </span>
              {displayedTrip?.status === "draft" && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold tracking-[0.2px] text-ink">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-ink"
                  />
                  {t("AI draft")}
                </span>
              )}
            </div>
            <h2 className="mt-2 font-sans text-[22px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
              {displayedTrip?.name ?? t("New Trip")}
            </h2>
            <div className="mt-2.5 flex flex-wrap gap-3.5 font-mono text-[12px] text-fg-dim">
              {totalDistanceKm !== null && (
                <span>
                  <span className="font-bold text-ink">{totalDistanceKm}</span>{" "}
                  {t("km")}
                </span>
              )}
              <span>
                <span className="font-bold text-ink">
                  {timelineDays.length}
                </span>{" "}
                {timelineDays.length === 1 ? t("day") : t("days")}
              </span>
            </div>
          </div>

          {/* Legs list (replaces bottom timeline strip). When no trip
              is loaded, render 3 disabled placeholder day chips so the
              existing test (`getByRole('button', { name: /Day 1/ })`)
              still resolves and stays non-interactive. */}
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-5 pt-3">
            {timelineDays.map((day, i) => {
              const isActive = !!activeTrip && selectedDayIndex === i;
              return (
                <button
                  key={day.dayNumber}
                  type="button"
                  onClick={() => {
                    if (!activeTrip) return;
                    setSelectedDayIndex(i);
                  }}
                  disabled={!activeTrip}
                  aria-pressed={isActive}
                  aria-label={`Day ${day.dayNumber}${day.title ? ` ${day.title}` : ""}`}
                  className={`rounded-[12px] border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    isActive
                      ? "border-ink bg-ink text-cream"
                      : "border-line bg-cream text-ink hover:border-line-strong"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div
                        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] font-mono text-[11px] font-bold ${
                          isActive
                            ? "bg-cream/15 text-cream"
                            : "bg-paper text-ink"
                        }`}
                      >
                        {String(day.dayNumber).padStart(2, "0")}
                      </div>
                      <div className="truncate text-[13px] font-bold">
                        {day.title ? day.title : `${t("Day")} ${day.dayNumber}`}
                      </div>
                    </div>
                  </div>
                  <div
                    className={`mt-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] ${
                      isActive ? "text-cream/70" : "text-fg-dim"
                    }`}
                  >
                    {day.distanceKm ? (
                      <span>{Math.round(day.distanceKm)} KM</span>
                    ) : null}
                    {day.elevationGain ? (
                      <span>↗ {Math.round(day.elevationGain)}M</span>
                    ) : null}
                    {day.durationMinutes ? (
                      <span>{formatDuration(day.durationMinutes)}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

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
              closuresData={closuresData}
              passesData={passesData}
              selectedDayNumber={selectedDay?.dayNumber ?? 1}
              onAddWaypoint={(location) =>
                appendPlannerWaypoint(selectedDayIndex, location, plannerParams)
              }
              onMoveWaypoint={(dayNumber, waypointId, location) =>
                moveWaypoint(dayNumber - 1, waypointId, location, plannerParams)
              }
              collaboratorCursors={collabSession.cursors}
              suggestions={collabSession.suggestions}
              onCursorMove={serverTripId ? collabSession.emitCursor : undefined}
              fitRouteToken={fitRouteToken}
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

          {/* Floating multi-day footer — only when we have real days
              from a loaded trip. The placeholder-day case (no trip)
              keeps the map fully clear. */}
          {activeTrip && activeTrip.days.length > 0 && (
            <div className="absolute bottom-4 left-4 right-4 z-10 rounded-[14px] border border-line-strong bg-cream p-3.5 shadow-[0_12px_32px_rgba(14,14,16,0.14)]">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
                  {t("Multi-day itinerary")}
                </span>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || isGenerating}
                  className="inline-flex items-center gap-1.5 rounded-full bg-ink px-2.5 py-1 text-[11px] font-bold tracking-[0.2px] text-cream transition hover:opacity-90 disabled:opacity-60"
                >
                  {/* Visible text stays static so the toolbar Save
                      button ("Saving…" in flight) keeps a unique
                      accessible name for selectors like
                      `getByRole({ name: "Saving…" })`. The disabled
                      state here conveys the in-flight feedback. */}
                  {t("Push to phone →")}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                {activeTrip.days.map((day, i) => {
                  const isActive = selectedDayIndex === i;
                  return (
                    <button
                      key={day.dayNumber}
                      type="button"
                      onClick={() => setSelectedDayIndex(i)}
                      aria-pressed={isActive}
                      className={`rounded-[10px] border p-2.5 text-left transition ${
                        isActive
                          ? "border-ink bg-ink text-cream"
                          : "border-line bg-paper text-ink hover:border-line-strong"
                      }`}
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span
                          className={`font-mono text-[10px] font-bold uppercase tracking-[1.6px] ${
                            isActive ? "text-accent" : "text-fg-dim"
                          }`}
                        >
                          {t("Day")} {day.dayNumber}
                        </span>
                      </div>
                      <div className="truncate text-[13px] font-bold">
                        {day.title ?? `${t("Day")} ${day.dayNumber}`}
                      </div>
                      <div
                        className={`mt-1.5 flex flex-wrap gap-2 font-mono text-[11px] ${
                          isActive ? "text-cream/70" : "text-fg-dim"
                        }`}
                      >
                        {day.distanceKm ? (
                          <span>{Math.round(day.distanceKm)} KM</span>
                        ) : null}
                        {day.waypoints?.length ? (
                          <span>{day.waypoints.length} STOPS</span>
                        ) : null}
                      </div>
                      {day.overnightStop?.name && (
                        <div
                          className={`mt-1.5 truncate font-mono text-[11px] ${
                            isActive ? "text-cream/55" : "text-fg-mute"
                          }`}
                        >
                          {t("Overnight ·")} {day.overnightStop.name}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — Parameters panel (always visible). Spec leads with
            Days segmented + Road preference radio cards; the existing
            advanced controls (daily km, surfaces, min quality, avoid
            flags, route builder, passes, closures, stops) live behind
            an Advanced disclosure so the spec idle visual stays clean
            while every test selector remains reachable. */}
        <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-line bg-paper px-5 py-[18px]">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
            {t("Parameters")}
          </span>
          <h2 className="mt-1.5 font-sans text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Tune the AI draft")}
          </h2>
          <p className="mb-[18px] mt-1 text-[12px] text-fg-dim">
            {t("Changes re-run Fun Zone discovery live.")}
          </p>

          <div className="flex flex-col gap-[18px]">
            {/* Days segmented control — full 1..14 supported range so a
                persisted `days=1` or `days=10` trip lands on a visible
                selected segment instead of leaving the control with no
                highlighted option. Spec shows 2..8; we cover the full
                state range to keep the visible control and submitted
                value consistent. */}
            <div>
              <div className="mb-2 flex justify-between">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
                  {t("Days")}
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-accent">
                  {days}
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDays(n)}
                    aria-label={`Set days to ${n}`}
                    className={`rounded-[6px] border py-2 text-center font-mono text-[12px] font-bold transition ${
                      days === n
                        ? "border-ink bg-ink text-cream"
                        : "border-line bg-cream text-fg-dim hover:text-ink"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {/* sr-only semantic input keeps `getByLabelText("Number of
                  days")` resolvable for the existing tests; changes
                  fire through the same setDays handler. `tabIndex={-1}`
                  removes it from sequential focus so keyboard users
                  don't land on an invisible control. */}
              <label htmlFor="trip-planner-days" className="sr-only">
                {t("Number of days")}
              </label>
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
            </div>

            {/* Road preference radio cards — includes a "Balanced" card
                for the `mixed` planner default so the visible UI and
                submitted payload stay in sync. Spec's 3-card design
                doesn't surface `mixed`, but it's the default planner
                state and a persisted trip can carry it; hiding it
                would leave the control with nothing selected. */}
            <div>
              <label
                htmlFor="trip-planner-road-preference"
                className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim"
              >
                {t("Road preference")}
              </label>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    {
                      value: "curvy",
                      label: t("Maximum twisty"),
                      sub: t("Fun-factor first, chain passes"),
                    },
                    {
                      value: "scenic",
                      label: t("Scenic balance"),
                      sub: t("Views + curves mixed"),
                    },
                    {
                      value: "mixed",
                      label: t("Balanced"),
                      sub: t("All-rounder default"),
                    },
                    {
                      value: "direct",
                      label: t("Efficient loop"),
                      sub: t("Minimize backtracking"),
                    },
                  ] as const
                ).map((opt) => {
                  const selected = roadPreference === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setRoadPreference(
                          opt.value as TripParameters["roadPreference"],
                        )
                      }
                      aria-pressed={selected}
                      className={`rounded-[8px] border px-3 py-2.5 text-left transition ${
                        selected
                          ? "border-ink bg-cream"
                          : "border-line bg-transparent hover:bg-cream/50"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className={`flex h-[14px] w-[14px] items-center justify-center rounded-full border-[1.5px] ${
                            selected ? "border-ink" : "border-fg-mute"
                          }`}
                        >
                          {selected && (
                            <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                          )}
                        </span>
                        <span className="text-[13px] font-semibold text-ink">
                          {opt.label}
                        </span>
                      </div>
                      <p className="ml-6 mt-1 text-[11px] text-fg-mute">
                        {opt.sub}
                      </p>
                    </button>
                  );
                })}
              </div>
              {/* sr-only select keeps `getByLabelText("Road preference")`
                  + `fireEvent.change` resolvable; carries the full
                  4-option enum so tests that select `mixed` still
                  reach a real value. `tabIndex={-1}` removes it from
                  sequential focus so keyboard users don't land on an
                  invisible control. */}
              <select
                id="trip-planner-road-preference"
                value={roadPreference}
                tabIndex={-1}
                onChange={(event) =>
                  setRoadPreference(
                    event.target.value as TripParameters["roadPreference"],
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

            {/* Advanced — every legacy control lives here so the rider
                still has access to surfaces, daily km, min quality,
                avoid flags, route builder, and passes / closures
                without cluttering the spec's two-control simplicity. */}
            {/* Phase A keeps the Advanced disclosure open by default —
                closures / passes / route-builder warnings are content
                the rider relies on, and existing Playwright e2es
                assert `toBeVisible()` on text rendered inside this
                group. A follow-up phase B can collapse the disclosure
                once those surfaces are reshaped for the spec's
                minimal idle visual. The state is controlled
                explicitly so user collapses survive subsequent
                parent re-renders. */}
            <details
              className="border-t border-line pt-[14px]"
              open={advancedOpen}
              onToggle={(event) =>
                setAdvancedOpen((event.target as HTMLDetailsElement).open)
              }
            >
              <summary className="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim hover:text-ink">
                {t("Advanced")}
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <div>
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
                </div>

                <div>
                  <p className="mb-2 block text-xs text-fg-dim">
                    {t("Surface preference")}
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {SURFACE_OPTIONS.map((surface) => (
                      <Checkbox
                        key={surface.value}
                        checked={surfacePreference.includes(surface.value)}
                        onChange={() => handleSurfaceToggle(surface.value)}
                        label={surface.label}
                        ariaLabel={surface.label}
                        className="py-1"
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="trip-planner-min-quality"
                    className="mb-1 block text-xs text-fg-dim"
                  >
                    {t("Minimum road quality")}
                  </label>
                  <Select
                    id="trip-planner-min-quality"
                    value={minQuality}
                    onChange={(value) => setMinQuality(Number(value))}
                    tone="cream"
                  >
                    <option value="1">{t("Any condition")}</option>
                    <option value="2">{t("Fair or better")}</option>
                    <option value="3">{t("Good or better")}</option>
                    <option value="4">{t("Excellent only")}</option>
                  </Select>
                </div>

                <div className="flex flex-col items-start gap-2 pt-2">
                  <Checkbox
                    checked={avoidHighways}
                    onChange={setAvoidHighways}
                    label={t("Avoid highways")}
                  />
                  <Checkbox
                    checked={avoidTolls}
                    onChange={setAvoidTolls}
                    label={t("Avoid tolls")}
                  />
                  <Checkbox
                    checked={avoidUnpaved}
                    onChange={setAvoidUnpaved}
                    label={t("Avoid unpaved roads")}
                  />
                </div>

                <div className="space-y-3 border-t border-line pt-2">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <MapPin size={14} className="text-accent" />
                    {t("Route builder")}
                  </div>
                  {selectedDay ? (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        <PlannerStat
                          label="Distance"
                          value={`${selectedDay.distanceKm.toFixed(1)} km`}
                          icon={Milestone}
                        />
                        <PlannerStat
                          label="Ride time"
                          value={`${selectedDay.durationMinutes} min`}
                          icon={Clock3}
                        />
                        <PlannerStat
                          label="Quality"
                          value={
                            selectedDay.avgQuality
                              ? selectedDay.avgQuality.toFixed(1)
                              : "—"
                          }
                          icon={ShieldCheck}
                        />
                      </div>
                      <WaypointEditor
                        dayNumber={selectedDay.dayNumber}
                        waypoints={selectedDay.waypoints}
                        onReorder={(fromIndex, toIndex) =>
                          reorderWaypoints(selectedDayIndex, fromIndex, toIndex)
                        }
                      />
                    </>
                  ) : (
                    <p className="text-xs text-fg-dim">
                      {t(
                        "Click the map to place a start point for Day 1. The planner will add the finish on the second click, then insert extra via points before the end. ",
                      )}
                    </p>
                  )}
                </div>

                <PassesPanel
                  month={travelMonth}
                  onMonthChange={setTravelMonth}
                  routes={closureRoutes}
                  data={passesData}
                />
                <ClosuresPanel
                  month={travelMonth}
                  routes={closureRoutes}
                  data={closuresData}
                />
                <TripStopsPanel trip={displayedTrip} />
              </div>
            </details>
          </div>
        </aside>
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
    </div>
  );
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
function buildTripMetadataPayload(trip: Trip, params: TripParameters) {
  const dailyKmTarget = normalizeBackendDailyKm(params.dailyKmTarget);
  return {
    title: trip.name,
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
  return {
    start_location: {
      lat: startWaypoint.location.lat,
      lng: startWaypoint.location.lng,
    },
    bbox: drawnRegion ? formatBboxParam(drawnRegion) : undefined,
    option,
    avoid_highways: params.avoidHighways,
    avoid_tolls: params.avoidTolls,
    avoid_unpaved: params.avoidUnpaved,
    surfaces: surfaces.length ? surfaces : undefined,
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
function validateGenerationInput(
  trip: Trip | null,
  params: TripParameters,
): string | null {
  if (params.surfacePreference.length === 0) {
    return "Select at least one surface type to generate a trip.";
  }
  if (generationSurfaces(params).length === 0) {
    return "Select at least one paved surface or turn off Avoid unpaved roads before generating.";
  }
  if (!findStartWaypoint(trip)) {
    return "Add a start waypoint before generating this trip.";
  }
  return null;
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
function buildImportedRoutePayload(trip: Trip) {
  if (!trip.id.startsWith("imported-")) return null;
  const firstDay = trip.days[0];
  const coordinates = firstDay?.routeGeometry?.coordinates ?? [];
  if (coordinates.length < 2) return null;
  return {
    title: trip.name,
    source_format: trip.importSourceFormat ?? "gpx",
    geometry: coordinates.map(([lng, lat]) => ({ lng, lat })),
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
      if (waypoint.name) payload.name = waypoint.name;
      if (IMPORTABLE_WAYPOINT_TYPES.has(waypoint.type)) {
        payload.type = waypoint.type as "via" | "fuel" | "rest" | "photo";
      }
      return payload;
    }),
  };
}
function PlannerStat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Clock3;
}) {
  return (
    <div className="rounded-lg border border-line bg-cream/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-fg-dim">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Icon size={12} className="text-fg-dim" />
        {value}
      </div>
    </div>
  );
}
function WaypointEditor({
  dayNumber,
  waypoints,
  onReorder,
}: {
  dayNumber: number;
  waypoints: Array<{
    id: string;
    name?: string;
    type: string;
  }>;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  if (waypoints.length === 0) {
    return (
      <p className="text-xs text-fg-dim">
        {t("No waypoints yet for Day ")}
        {dayNumber}
        {t(". Click the map to begin the route. ")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-dim">
        {t("Drag via points to reorder them. Start and finish stay pinned. ")}
      </p>
      {waypoints.map((waypoint, index) => {
        const draggable = waypoint.type !== "start" && waypoint.type !== "end";
        return (
          <div
            key={waypoint.id}
            draggable={draggable}
            onDragStart={() => {
              if (!draggable) return;
              setDragIndex(index);
            }}
            onDragOver={(event) => {
              if (dragIndex === null || !draggable) return;
              event.preventDefault();
            }}
            onDrop={() => {
              if (dragIndex === null || dragIndex === index || !draggable) {
                setDragIndex(null);
                return;
              }
              onReorder(dragIndex, index);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
              draggable
                ? "border-line bg-cream/70 text-ink"
                : "border-line bg-paper text-fg-dim"
            }`}
          >
            <GripVertical
              size={14}
              className={draggable ? "text-fg-dim" : "text-fg-faint"}
            />
            <span className="min-w-12 text-xs uppercase tracking-wide text-fg-dim">
              {waypoint.type}
            </span>
            <span>{waypoint.name ?? `Waypoint ${index + 1}`}</span>
          </div>
        );
      })}
    </div>
  );
}
