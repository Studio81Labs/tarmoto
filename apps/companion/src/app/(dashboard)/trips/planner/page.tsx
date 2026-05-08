"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTripStore } from "@/stores/trip";
import {
  Loader2,
  Save,
  Clock3,
  GripVertical,
  Layers,
  Milestone,
  MapPin,
  ShieldCheck,
  RotateCcw,
  RotateCw,
  Sliders,
  Users,
  Upload,
  Sparkles,
  ChevronRight,
  FileUp,
  BedDouble,
  Gauge,
  Mountain,
  RefreshCw,
  Route,
} from "lucide-react";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { PassesPanel } from "@/components/PassesPanel";
import { SegmentSidebar } from "@/components/SegmentSidebar";
import { TripPlannerMap } from "@/components/TripPlannerMap";
import { TripStopsPanel } from "@/components/TripStopsPanel";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { TripExportMenu } from "@/components/TripExportMenu";
import { TripImportDialog } from "@/components/TripImportDialog";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import { useAuthStore } from "@/stores/auth";
import { tripsApi } from "@/lib/api";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { DEMO_TRIP } from "@/lib/demo-trip";
import { UNPAVED_SURFACES } from "@/lib/surface-preferences";
import {
  generateTripOptions,
  regenerateTripDay,
  type GeneratedTripOption,
} from "@/lib/trip-itinerary-generator";
import { currentUtcMonth } from "@/lib/passes-summary";
import {
  findOwnerId,
  tripFromDetail,
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
} as const;
export default function TripPlannerPage() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paramsOpen, setParamsOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [collaborateOpen, setCollaborateOpen] = useState(false);
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
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generatedOptions, setGeneratedOptions] = useState<
    GeneratedTripOption[]
  >([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const generationLockRef = useRef(false);
  const requestTokenRef = useRef(0);
  const isMountedRef = useRef(true);
  const activeTripRef = useRef<Trip | null>(null);
  const generatedOptionsRef = useRef<GeneratedTripOption[]>([]);
  const selectedOptionIdRef = useRef<string | null>(null);
  const syncedControlsTripIdRef = useRef<string | null>(null);
  const activeTrip = useTripStore((s) => s.activeTrip);
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  const isGenerating = useTripStore((s) => s.isGenerating);
  const setGenerating = useTripStore((s) => s.setGenerating);
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
  // ── Collab session wiring (US-35) ─────────────────────────────────
  // `?tripId=<uuid>` on the URL activates the collab surface: the
  // socket joins `trip:<id>`, cursors + suggestions + activity start
  // flowing, and the Suggestions / Activity tabs in the modal light up.
  const [serverTripId, setServerTripId] = useState<string | null>(null);
  const [serverTripOwnerId, setServerTripOwnerId] = useState<string | null>(
    null,
  );
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
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
    [serverTripId, setActiveTrip],
  );
  const handleRemoteTripDeleted = useCallback(() => {
    // Owner deleted the trip out from under everyone. Drop local trip
    // state and the collab session so the planner falls back to a
    // blank canvas — any further interaction would 404 anyway.
    setActiveTrip(null);
    setServerTripId(null);
    setServerTripOwnerId(null);
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
    // Skip the no-op null→null setState on first mount so we don't
    // burn an extra render cycle through the planner's downstream
    // data hooks (useClosures/usePasses).
    if (fromUrl) setServerTripId(fromUrl);
  }, []);
  useEffect(() => {
    if (!serverTripId) {
      setServerTripOwnerId(null);
      return;
    }
    // Mirrors the gate on `/trips/:id` and `/settings/subscription`:
    // wait for the auth store to carry a token so the trip fetch on
    // a hard navigation to `/trips/planner?tripId=...` doesn't race
    // AuthSync and silently land as a 401 (the catch swallows errors
    // and the canvas would render empty).
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await tripsApi.get(serverTripId);
        if (cancelled) return;
        const detail = data as unknown as TripDetailResponse;
        setServerTripOwnerId(findOwnerId(detail));
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
  }, [serverTripId, authReady, setActiveTrip]);
  const handlePromotedToServer = useCallback((newServerTripId: string) => {
    setServerTripId(newServerTripId);
    // Push the id into the URL so a reload preserves the live session.
    // history.replaceState avoids depending on the Next router, keeping
    // the page prerenderable (see comment on the URL read above).
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tripId", newServerTripId);
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }
  }, []);
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
  const canRegenerate =
    displayedTrip != null &&
    selectedOption != null &&
    displayedTrip.id === selectedOption.trip.id;
  const closuresData = useClosures(travelMonth, closureRoutes);
  const passesData = usePasses(travelMonth, closureRoutes);
  const selectedDay = activeTrip?.days[selectedDayIndex] ?? null;
  const timelineDays = activeTrip?.days ?? [
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
    if (!displayedTrip || saving) return;
    setSaving(true);
    try {
      setGenerationError(null);
      const p = plannerParams;
      // Prefer a known serverTripId from collaboration/deep links. Promoted
      // drafts keep local in-memory ids, but their suggestions and activity
      // already belong to the promoted backend trip.
      const existingTripId =
        serverTripId ??
        (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          displayedTrip.id,
        )
          ? displayedTrip.id
          : null);
      const importedRoutePayload = buildImportedRoutePayload(displayedTrip);
      if (displayedTrip.id.startsWith("imported-") && !importedRoutePayload) {
        setGenerationError(
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
      // "direct" is the planner's term; the backend uses "fast".
      const roadPreference =
        p.roadPreference === "direct" ? "fast" : p.roadPreference;
      const dailyKmTarget = normalizeBackendDailyKm(p.dailyKmTarget);
      const generationSurfaces = p.avoidUnpaved
        ? p.surfacePreference.filter(
            (surface) => !UNPAVED_SURFACES.has(surface),
          )
        : p.surfacePreference;
      if (p.surfacePreference.length > 0 && generationSurfaces.length === 0) {
        setGenerationError(
          "Select at least one paved surface or turn off Avoid unpaved roads before saving.",
        );
        setSaving(false);
        return;
      }
      // Generate the route using the first waypoint as start_location.
      const firstDay = displayedTrip.days[0];
      const startWp = firstDay?.waypoints[0];
      if (!startWp) {
        setGenerationError("Add a start waypoint before saving this trip.");
        setSaving(false);
        return;
      }
      const basePayload = {
        title: displayedTrip.name,
        num_days: p.days,
        min_quality: p.minQuality,
        road_preference: roadPreference,
        daily_km_min: dailyKmTarget,
        daily_km_max: dailyKmTarget,
      };
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
      const shouldGenerate =
        selectedOptionId !== null ||
        !existingTripId ||
        displayedTrip.id !== existingTripId;
      if (shouldGenerate) {
        try {
          await tripsApi.generate(tripId, {
            start_location: {
              lat: startWp.location.lat,
              lng: startWp.location.lng,
            },
            option: selectedOptionId || undefined,
            avoid_highways: p.avoidHighways,
            avoid_tolls: p.avoidTolls,
            avoid_unpaved: p.avoidUnpaved,
            surfaces: generationSurfaces.length
              ? generationSurfaces
              : undefined,
          });
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
      setGenerationError("Could not save this trip. Please try again.");
      console.warn("Failed to save trip", err);
      setSaving(false);
    }
  }, [
    displayedTrip,
    plannerParams,
    router,
    saving,
    selectedOptionId,
    serverTripId,
  ]);
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
    setGenerationError(null);
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
    generatedOptionsRef.current = generatedOptions;
  }, [generatedOptions]);
  useEffect(() => {
    selectedOptionIdRef.current = selectedOptionId;
  }, [selectedOptionId]);
  useEffect(() => {
    if (!activeTrip) {
      if (selectedOptionId !== null) setSelectedOptionId(null);
      return;
    }
    const matchingOption = generatedOptionsRef.current.find(
      (option) => option.trip.id === activeTrip.id,
    );
    if (!matchingOption) {
      if (selectedOptionId !== null) setSelectedOptionId(null);
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
  }, [activeTrip, selectedOptionId]);
  const handleGenerate = useCallback(async () => {
    if (surfacePreference.length === 0) {
      setGenerationError(
        "Select at least one surface type to generate a trip.",
      );
      return;
    }
    if (generationLockRef.current) return;
    const activeTripAtStart = activeTripRef.current;
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setGenerationError(null);
    generationLockRef.current = true;
    setGenerating(true);
    try {
      await delay(180);
      if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
        return;
      }
      const options = generateTripOptions(plannerParams);
      if (
        !isMountedRef.current ||
        requestTokenRef.current !== requestToken ||
        activeTripRef.current !== activeTripAtStart
      ) {
        return;
      }
      setGeneratedOptions(options);
      setSelectedOptionId(options[0]?.id ?? null);
      setActiveTrip(options[0]?.trip ?? null);
    } catch (error) {
      if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : "Could not generate itinerary options right now.";
      setGenerationError(message);
    } finally {
      if (requestTokenRef.current === requestToken) {
        generationLockRef.current = false;
        if (isMountedRef.current) {
          setGenerating(false);
        }
      }
    }
  }, [plannerParams, setActiveTrip, setGenerating, surfacePreference.length]);
  const handleSelectOption = useCallback(
    (option: GeneratedTripOption) => {
      if (generationLockRef.current) return;
      setSelectedOptionId(option.id);
      setActiveTrip(option.trip);
      setGenerationError(null);
    },
    [setActiveTrip],
  );
  const handleRegenerateDay = useCallback(
    async (dayNumber: number) => {
      if (!canRegenerate || !displayedTrip || !selectedOptionId) return;
      if (generationLockRef.current) return;
      const regeneratingOptionId = selectedOptionId;
      const requestToken = requestTokenRef.current + 1;
      requestTokenRef.current = requestToken;
      setGenerationError(null);
      generationLockRef.current = true;
      setGenerating(true);
      try {
        await delay(120);
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        const latestTrip = activeTripRef.current;
        if (!latestTrip || latestTrip.id !== displayedTrip.id) {
          return;
        }
        const regeneratedTrip = regenerateTripDay(latestTrip, dayNumber);
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        setGeneratedOptions((current) =>
          current.map((option) =>
            option.id === regeneratingOptionId
              ? { ...option, trip: regeneratedTrip }
              : option,
          ),
        );
        if (selectedOptionIdRef.current === regeneratingOptionId) {
          setActiveTrip(regeneratedTrip);
        }
      } catch (error) {
        if (!isMountedRef.current || requestTokenRef.current !== requestToken) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Could not regenerate this day.";
        setGenerationError(message);
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
      canRegenerate,
      displayedTrip,
      selectedOptionId,
      setActiveTrip,
      setGenerating,
    ],
  );
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold mr-4">
            {displayedTrip?.name ?? "New Trip"}
          </h1>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition disabled:opacity-60 disabled:cursor-wait"
            aria-label={t("Generate itinerary")}
          >
            <Sparkles size={14} />
            {isGenerating ? "Generating…" : "Generate"}
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw size={14} />
            {t("Undo ")}
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCw size={14} />
            {t("Redo ")}
          </button>
          <button
            type="button"
            onClick={() => openImport()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <Upload size={14} />
            {t("Import GPX ")}
          </button>
          <TripExportMenu trip={displayedTrip} context="planner" />
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !displayedTrip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition disabled:opacity-60"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            {saving ? "Saving…" : "Save"}
          </button>
          {!displayedTrip && (
            <button
              type="button"
              onClick={() => {
                setGeneratedOptions([]);
                setSelectedOptionId(null);
                setActiveTrip(DEMO_TRIP);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 text-sm hover:text-white hover:border-slate-500 transition"
            >
              {t("Load demo trip ")}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setParamsOpen(!paramsOpen)}
            aria-pressed={paramsOpen}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition ${
              paramsOpen
                ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <Sliders size={14} />
            {t("Parameters ")}
          </button>
          <button
            type="button"
            onClick={() => setCollaborateOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <Users size={14} />
            {t("Collaborate ")}
          </button>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-pressed={sidebarOpen}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition ${
              sidebarOpen
                ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <Layers size={14} />
            {t("Segments ")}
          </button>
        </div>
      </div>

      {(generatedOptions.length > 0 || generationError) && (
        <div className="border-b border-slate-800 bg-slate-950/80 px-4 py-3">
          {generationError ? (
            <p
              role="alert"
              className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-300"
            >
              {generationError}
            </p>
          ) : null}

          {generatedOptions.length > 0 && (
            <div
              className={`grid gap-3 lg:grid-cols-3 ${generationError ? "mt-3" : ""}`}
            >
              {generatedOptions.map((option) => {
                const totalDistance = option.trip.days.reduce(
                  (sum, day) => sum + day.distanceKm,
                  0,
                );
                const totalDuration = option.trip.days.reduce(
                  (sum, day) => sum + day.durationMinutes,
                  0,
                );
                const averageQuality =
                  option.trip.days.length > 0
                    ? option.trip.days.reduce(
                        (sum, day) => sum + day.avgQuality,
                        0,
                      ) / option.trip.days.length
                    : 0;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleSelectOption(option)}
                    disabled={isGenerating}
                    className={`rounded-2xl border px-4 py-3 text-left transition ${
                      option.id === selectedOptionId
                        ? "border-tarmoto-cyan bg-tarmoto-cyan/10"
                        : "border-slate-800 bg-slate-900/60 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {option.label}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {option.summary}
                        </p>
                      </div>
                      {option.id === selectedOptionId && (
                        <span className="rounded-full bg-tarmoto-cyan/20 px-2 py-0.5 text-[11px] font-medium text-tarmoto-cyan">
                          {t("Active")}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300">
                      <div className="rounded-lg bg-slate-950/70 px-2 py-2">
                        <p className="text-slate-500">{t("Distance")}</p>
                        <p className="mt-1 font-medium text-white">
                          {Math.round(totalDistance)}
                          {t("km ")}
                        </p>
                      </div>
                      <div className="rounded-lg bg-slate-950/70 px-2 py-2">
                        <p className="text-slate-500">{t("Ride time")}</p>
                        <p className="mt-1 font-medium text-white">
                          {formatDuration(totalDuration)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-slate-950/70 px-2 py-2">
                        <p className="text-slate-500">{t("Avg quality")}</p>
                        <p className="mt-1 font-medium text-white">
                          {averageQuality.toFixed(1)}/5
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Parameters panel (left, collapsible) */}
        {paramsOpen && (
          <div className="w-72 border-r border-slate-800 bg-slate-950 overflow-y-auto p-4 space-y-4 animate-slide-in-right">
            <h3 className="text-sm font-semibold text-slate-300">
              {t("Trip parameters ")}
            </h3>

            <div>
              <label
                htmlFor="trip-planner-days"
                className="block text-xs text-slate-500 mb-1"
              >
                {t("Number of days ")}
              </label>
              <input
                id="trip-planner-days"
                type="number"
                min={1}
                max={14}
                value={days}
                onChange={(event) =>
                  setDays(clampNumberInput(event.target.value, 1, 14, 3))
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              />
            </div>

            <div>
              <label
                htmlFor="trip-planner-daily-km"
                className="block text-xs text-slate-500 mb-1"
              >
                {t("Daily km target ")}
              </label>
              <input
                id="trip-planner-daily-km"
                type="number"
                min={100}
                max={500}
                step={25}
                value={dailyKmTarget}
                onChange={(event) =>
                  setDailyKmTarget(
                    clampNumberInput(event.target.value, 100, 500, 250),
                  )
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              />
            </div>

            <div>
              <label
                htmlFor="trip-planner-road-preference"
                className="block text-xs text-slate-500 mb-1"
              >
                {t("Road preference ")}
              </label>
              <select
                id="trip-planner-road-preference"
                value={roadPreference}
                onChange={(event) =>
                  setRoadPreference(
                    event.target.value as TripParameters["roadPreference"],
                  )
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              >
                <option value="curvy">{t("Maximum curviness")}</option>
                <option value="scenic">{t("Scenic roads")}</option>
                <option value="mixed">{t("Mixed (balanced)")}</option>
                <option value="direct">{t("Direct / efficient")}</option>
              </select>
            </div>

            <div>
              <p className="block text-xs text-slate-500 mb-2">
                {t("Surface preference ")}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SURFACE_OPTIONS.map((surface) => (
                  <label
                    key={surface.value}
                    className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-300"
                  >
                    <input
                      type="checkbox"
                      aria-label={surface.label}
                      checked={surfacePreference.includes(surface.value)}
                      onChange={() => handleSurfaceToggle(surface.value)}
                      className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                    />
                    {surface.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="trip-planner-min-quality"
                className="block text-xs text-slate-500 mb-1"
              >
                {t("Minimum road quality ")}
              </label>
              <select
                id="trip-planner-min-quality"
                value={minQuality}
                onChange={(event) => setMinQuality(Number(event.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-tarmoto-cyan transition"
              >
                <option value="1">{t("Any condition")}</option>
                <option value="2">{t("Fair or better")}</option>
                <option value="3">{t("Good or better")}</option>
                <option value="4">{t("Excellent only")}</option>
              </select>
            </div>

            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  checked={avoidHighways}
                  onChange={(event) => setAvoidHighways(event.target.checked)}
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                {t("Avoid highways ")}
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  checked={avoidTolls}
                  onChange={(event) => setAvoidTolls(event.target.checked)}
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                {t("Avoid tolls ")}
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  checked={avoidUnpaved}
                  onChange={(event) => setAvoidUnpaved(event.target.checked)}
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                {t("Avoid unpaved roads ")}
              </label>
            </div>
            <div className="space-y-3 pt-2 border-t border-slate-800">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
                <MapPin size={14} className="text-slate-500" />
                {t("Route builder ")}
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
                <p className="text-xs text-slate-500">
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
        )}

        {/* Map canvas */}
        <div
          className="flex-1 relative bg-slate-900"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <TripPlannerMap
            trip={displayedTrip}
            month={travelMonth}
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
          />

          {/* Drop overlay */}
          {isDragOver && (
            <div
              aria-hidden
              className="absolute inset-4 rounded-2xl border-2 border-dashed border-tarmoto-cyan bg-tarmoto-cyan/10 flex items-center justify-center pointer-events-none z-10"
            >
              <div className="text-center">
                <FileUp size={40} className="mx-auto text-tarmoto-cyan mb-2" />
                <p className="text-tarmoto-cyan font-semibold">
                  {t("Drop to import GPX or KML ")}
                </p>
              </div>
            </div>
          )}

          {/* Generating overlay */}
          {isGenerating && (
            <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-20">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-4 border-2 border-tarmoto-cyan/30 border-t-tarmoto-cyan rounded-full animate-spin" />
                <p className="text-white font-medium">
                  {t("Generating your route... ")}
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  {t("Finding the best roads for you ")}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Segment sidebar (right, collapsible) — Road Preview Cards (US-33) */}
        {sidebarOpen && <SegmentSidebar />}
      </div>

      {/* Timeline strip */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/90 overflow-x-auto">
        {timelineDays.map(
          (day: {
            dayNumber: number;
            distanceKm?: number;
            durationMinutes?: number;
            elevationGain?: number;
            overnightStop?: {
              name: string;
            };
            title?: string;
          }) => (
            <div
              key={day.dayNumber}
              className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 whitespace-nowrap transition"
            >
              <button
                type="button"
                onClick={() => {
                  if (!activeTrip) return;
                  setSelectedDayIndex(day.dayNumber - 1);
                }}
                disabled={!activeTrip}
                aria-pressed={selectedDayIndex === day.dayNumber - 1}
                className="flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>
                  <span className="block font-medium text-white">
                    {t("Day ")}
                    {day.dayNumber}
                    {day.title ? ` · ${day.title}` : ""}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    {day.distanceKm ? (
                      <span className="inline-flex items-center gap-1">
                        <Route size={12} />
                        {day.distanceKm}
                        {t("km ")}
                      </span>
                    ) : null}
                    {day.durationMinutes ? (
                      <span className="inline-flex items-center gap-1">
                        <Gauge size={12} />
                        {formatDuration(day.durationMinutes)}
                      </span>
                    ) : null}
                    {day.elevationGain ? (
                      <span className="inline-flex items-center gap-1">
                        <Mountain size={12} />
                        {Math.round(day.elevationGain)}
                        {t("m ")}
                      </span>
                    ) : null}
                    {day.overnightStop?.name ? (
                      <span className="inline-flex items-center gap-1">
                        <BedDouble size={12} />
                        {day.overnightStop.name}
                      </span>
                    ) : null}
                  </span>
                </span>
                <ChevronRight size={14} className="text-slate-500" />
              </button>
              {canRegenerate && (
                <button
                  type="button"
                  onClick={() => handleRegenerateDay(day.dayNumber)}
                  disabled={isGenerating}
                  className="rounded-md border border-slate-700 p-2 text-slate-400 transition hover:border-tarmoto-cyan hover:text-tarmoto-cyan disabled:cursor-wait disabled:opacity-50"
                  aria-label={`Regenerate day ${day.dayNumber}`}
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </div>
          ),
        )}
        <button className="px-3 py-2 rounded-lg border border-dashed border-slate-700 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition">
          {t("+ Add day ")}
        </button>
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
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-slate-100">
        <Icon size={12} className="text-slate-500" />
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
      <p className="text-xs text-slate-500">
        {t("No waypoints yet for Day ")}
        {dayNumber}
        {t(". Click the map to begin the route. ")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
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
                ? "border-slate-800 bg-slate-900/70 text-slate-200"
                : "border-slate-800 bg-slate-950 text-slate-400"
            }`}
          >
            <GripVertical
              size={14}
              className={draggable ? "text-slate-500" : "text-slate-700"}
            />
            <span className="min-w-12 text-xs uppercase tracking-wide text-slate-500">
              {waypoint.type}
            </span>
            <span>{waypoint.name ?? `Waypoint ${index + 1}`}</span>
          </div>
        );
      })}
    </div>
  );
}
