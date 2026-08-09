"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  notFound as renderNotFound,
  useParams,
  useRouter,
} from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  Edit,
  Layers,
  Lightbulb,
  LogOut,
  MapPin,
  Maximize2,
  Trash2,
  Users,
} from "lucide-react";
import { ApiError, roadsApi, tripsApi } from "@/lib/api";
import { tripCollabApi } from "@/lib/api/trip-collab";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { useRouteQualityHydration } from "@/hooks/useRouteQualityHydration";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import {
  TripPlannerMap,
  type TripPlannerMapHandle,
} from "@/components/TripPlannerMap";
import {
  SegmentDetailSidebar,
  type SegmentDetailPanelState,
} from "@/components/roads/SegmentDetailSidebar";
import { InspectTab } from "@/components/planner/InspectTab";
import { SectionStamp } from "@/components/planner/PlannerPanel";
import { PassesPanel } from "@/components/PassesPanel";
import { ClosuresPanel } from "@/components/ClosuresPanel";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { TripExportButton } from "@/components/TripExportButton";
import {
  DayByDayList,
  TileStat,
  qualityTierOf,
} from "@/components/trips/DayByDayList";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { currentUtcMonth } from "@/lib/passes-summary";
import {
  findOwnerId,
  tripFromDetail,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import { useFormat } from "@/format/FormatProvider";
import { translateKnownLabel, TRIP_STATUS_LABELS } from "@/i18n/domainLabels";
import {
  Button,
  Heading,
  QualityBars,
  Skeleton,
  Stamp,
  Tooltip,
} from "@tarmoto/ui";
type RightTab = "route" | "inspect" | "conditions";
interface LoadedTrip {
  detail: TripDetailResponse;
  members: TripDetailMember[];
}

// Persisted trips carry a UUID id; in-memory planner drafts are `planner-*` /
// `imported-*`. Used to avoid clobbering an unsaved draft in the shared store.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TripDetailPage() {
  const t = useTranslation();
  const format = useFormat();
  const { tripId } = useParams<{
    tripId: string;
  }>();
  const router = useRouter();
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const [loaded, setLoaded] = useState<LoadedTrip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [collaborateOpen, setCollaborateOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RightTab>("route");
  const [inspectDayIndex, setInspectDayIndex] = useState(0);
  const [travelMonth, setTravelMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  const mapRef = useRef<TripPlannerMapHandle>(null);
  const selectedPlannerSegmentId = useTripStore(
    (s) => s.selectedPlannerSegmentId,
  );
  const selectPlannerSegment = useTripStore((s) => s.selectPlannerSegment);
  const activeTrip = useTripStore((s) => s.activeTrip);
  const applyRouteQuality = useTripStore((s) => s.applyRouteQuality);
  // INSPECT card → map: same select + fly interaction as the planner. Opens
  // the on-route Road Preview popover; the full history+reviews drawer is
  // reached from that popover or by tapping an off-route mapped segment.
  const handleInspectSegment = useCallback(
    (segmentId: string) => {
      selectPlannerSegment(segmentId);
      mapRef.current?.flyToSegment(segmentId);
    },
    [selectPlannerSegment],
  );
  // Road-segment detail drawer (quality history + reviews), shared with the
  // road explorer and the planner. Opens for an off-route mapped segment tap,
  // or the Road Preview popover's "Full history & reviews" action.
  const [selectedRoadSegmentIdChoice, setSelectedRoadSegmentId] = useState<
    string | null
  >(null);
  // Effective, so the switch reaches BOTH the drawer's render and the effect
  // that fetches it: collapsing the id to null runs the effect's existing
  // teardown, which aborts the in-flight `getSegmentDetail` and returns the
  // panel to idle. The rider's selection is kept, so restoring the switch
  // reopens what they had.
  const selectedRoadSegmentId = qualityOverlayEnabled
    ? selectedRoadSegmentIdChoice
    : null;
  const [segmentDetailState, setSegmentDetailState] =
    useState<SegmentDetailPanelState>({ status: "idle" });
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
        if (!cancelled) {
          setSegmentDetailState({ status: "ready", segment: data });
        }
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
  // Day-by-day card → map: selecting a day dims the other days' lines
  // (`selectedDayNumber`) and fits its bounds; reselecting clears back
  // to the whole route.
  const [selectedDayNumber, setSelectedDayNumber] = useState<number | null>(
    null,
  );
  const handleSelectDay = useCallback(
    (dayNumber: number) => {
      const next = selectedDayNumber === dayNumber ? null : dayNumber;
      setSelectedDayNumber(next);
      if (next != null) mapRef.current?.fitDay(next);
      else mapRef.current?.fitRoute();
    },
    [selectedDayNumber],
  );
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  // Memoise the local Trip projection so referential equality doesn't
  // churn on every render — `TripPlannerMap` re-derives its overlays
  // whenever `trip` changes identity.
  const trip = useMemo(
    () => (loaded ? tripFromDetail(loaded.detail) : null),
    [loaded],
  );
  const ownerId = loaded ? findOwnerId(loaded.detail) : null;
  const callerRole =
    currentUserId && loaded
      ? (loaded.members.find((m) => m.user_id === currentUserId)?.role ?? null)
      : null;
  const isOwner = callerRole === "owner";
  const canManageInvites = callerRole === "owner" || callerRole === "editor";
  // Only the owner may edit metadata/route and delete; editors can edit but
  // not delete; viewers can do neither. Non-owner members leave rather than
  // manage collaborators, and reach suggestions through their own button.
  const canEdit = callerRole === "owner" || callerRole === "editor";
  const isCollaborator = callerRole === "editor" || callerRole === "viewer";
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const handleLeave = useCallback(async () => {
    if (!loaded) return;
    setConfirmLeaveOpen(false);
    setLeaving(true);
    setLeaveError(null);
    try {
      await tripCollabApi.leaveTrip(loaded.detail.id);
      router.replace("/trips");
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 404
          ? t("You're no longer a member of this trip.")
          : t("Couldn't leave the trip. Try again.");
      setLeaveError(message);
      setLeaving(false);
    }
  }, [t, loaded, router]);
  const closureRoutes = useMemo(
    () => buildTripClosureRoutes(trip, t),
    [t, trip],
  );
  const closuresData = useClosures(travelMonth, closureRoutes);
  const passesData = usePasses(travelMonth, closureRoutes);
  // Activate the trip in the store so the map's store-driven overlays
  // (quality segments, segment focus) resolve against this trip. Reset
  // on unmount so navigating to the planner doesn't inherit stale state.
  // The planner keeps an unsaved draft (`planner-*`/`imported-*`) as the shared
  // activeTrip across navigation; overwriting + clearing it here would destroy
  // the rider's working state just for viewing a saved trip. Stash a
  // non-persisted previous trip once and restore it on unmount instead of
  // clobbering the planner store (a lingering persisted UUID trip is still
  // cleared, matching prior behaviour).
  const stashedDraftRef = useRef<
    ReturnType<typeof tripFromDetail> | null | undefined
  >(undefined);
  // Capture the unsaved draft present before this view activates (once, on the
  // first render — activeTrip is still the planner's working state here). null
  // means there was no draft to preserve.
  if (stashedDraftRef.current === undefined) {
    stashedDraftRef.current =
      activeTrip && !UUID_RE.test(activeTrip.id) ? activeTrip : null;
  }
  useEffect(() => {
    setActiveTrip(trip);
    return () => {
      setActiveTrip(stashedDraftRef.current ?? null);
    };
  }, [trip, setActiveTrip]);
  // Hydrate real per-segment quality for this saved trip's routed days (#862),
  // the same way the planner does, so a covered trip shows real surface quality
  // instead of the no_data baseline. Runs once this trip is the active store
  // trip (set above); the map/Inspect render from that hydrated copy.
  const storeTrip = activeTrip?.id === trip?.id ? activeTrip : null;
  const displayedTrip = storeTrip ?? trip;
  useRouteQualityHydration(storeTrip, applyRouteQuality);
  useEffect(() => {
    if (!tripId) return;
    // Gate on the auth store carrying a token — without this the fetch
    // races AuthSync on a hard navigation to `/trips/:id` and lands as
    // a 401, surfacing as a generic "Couldn't load this trip" banner.
    if (!authReady) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    tripsApi
      .get(tripId)
      .then(({ data }) => {
        if (cancelled) return;
        const detail = data as unknown as TripDetailResponse;
        setLoaded({ detail, members: detail.members ?? [] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          // Permission errors fold into the trips list per the spec —
          // we don't surface a denied-access page since the backend
          // already 404s non-members for trip detail. 403 only happens
          // on a few collab endpoints that get stricter checks.
          //
          // Flip `cancelled` first so the `.finally()` below doesn't
          // setLoading(false) and briefly flash the generic error
          // banner before the router-driven unmount lands.
          cancelled = true;
          router.replace("/trips");
          return;
        }
        // 400 = malformed trip id in the URL — same dead link as a
        // missing trip; both land on the 404 screen.
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 400)
        ) {
          setNotFound(true);
          return;
        }
        setError(t("Couldn't load this trip. Check your connection."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, tripId, router, authReady]);
  const collabSession = useTripCollabSession(loaded ? loaded.detail.id : null);
  const showLoader = useDelayedLoading(loading);
  // Deleting confirms through the app dialog — system dialogs are
  // disallowed.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const handleDelete = useCallback(async () => {
    if (!loaded) return;
    setConfirmDeleteOpen(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      await tripsApi.delete(loaded.detail.id);
      router.replace("/trips");
    } catch (err) {
      // Backend deliberately folds non-owners into 404 to avoid role
      // enumeration, so 403 isn't a path the delete endpoint produces.
      const message =
        err instanceof ApiError && err.status === 404
          ? t("This trip no longer exists.")
          : t("Couldn't delete the trip. Try again.");
      setDeleteError(message);
      setDeleting(false);
    }
  }, [t, loaded, router]);
  if (loading) {
    // Debounced skeleton mirroring the page chrome (toolbar / map / panel);
    // warm loads render a blank shell instead of flashing it.
    return (
      <div className="flex h-full flex-col">
        {showLoader && (
          <>
            <span role="status" className="sr-only">
              {t("Loading trip…")}
            </span>
            <div
              aria-hidden="true"
              className="flex items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-2"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-[10px]" />
                <span className="h-[22px] w-px shrink-0 bg-line" />
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-44" />
                  <Skeleton className="h-2.5 w-60" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-24 rounded-[10px]" />
                <Skeleton className="h-8 w-8 rounded-[10px]" />
              </div>
            </div>
            <div aria-hidden="true" className="flex flex-1 overflow-hidden">
              <div className="relative flex-1 bg-cream">
                <Skeleton className="absolute inset-0 rounded-none" />
              </div>
              <div className="hidden w-[370px] shrink-0 flex-col gap-3 border-l border-line bg-paper px-5 pt-4 lg:flex">
                <Skeleton className="h-[9px] w-[70px] rounded-[4px]" />
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="mt-2 h-[72px] w-full rounded-[10px]" />
                <Skeleton className="h-[72px] w-full rounded-[10px]" />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  // Deleted trips / dead links render the app-level v2 404 screen.
  if (notFound) renderNotFound();
  if (error || !loaded || !trip) {
    return (
      <div className="mx-auto max-w-2xl animate-fade-in p-4 md:p-7">
        <Link
          href="/trips"
          className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-fg-dim transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          {t("Back to trips")}
        </Link>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-6 text-sm text-red-700">
          {error ?? t("Unknown error loading trip.")}
        </div>
      </div>
    );
  }
  const totalDistance = trip.days.reduce((sum, d) => sum + d.distanceKm, 0);
  const totalDuration = trip.days.reduce(
    (sum, d) => sum + d.durationMinutes,
    0,
  );
  const totalElevation = trip.days.reduce((sum, d) => sum + d.elevationGain, 0);
  return (
    <div className="flex flex-col h-full">
      {/* Header / action bar — same chrome as the planner's top toolbar:
          square back button + divider + compact identity block, and the
          planner's button language on the right (uppercase labels, icon-only
          danger delete behind a divider). Day count shows only for multi-day
          routes; the member count always stays. */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur-sm">
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
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-[15px] font-extrabold leading-tight tracking-[-0.3px] text-ink">
                {loaded.detail.title}
              </h1>
              <StatusBadge status={loaded.detail.status} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap text-[11px] text-fg-dim">
              {trip.days.length > 1 && (
                <span className="inline-flex items-center gap-1">
                  <Layers size={11} aria-hidden className="text-fg-faint" />
                  {t("{count, plural, one {# day} other {# days}}", {
                    count: trip.days.length,
                  })}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} aria-hidden className="text-fg-faint" />{" "}
                {format.distanceKm(totalDistance)}
              </span>
              {totalDuration > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Clock size={11} aria-hidden className="text-fg-faint" />{" "}
                  {`~${format.duration(totalDuration)}`}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Users size={11} aria-hidden className="text-fg-faint" />{" "}
                {t("{count, plural, one {# member} other {# members}}", {
                  count: loaded.members.length,
                })}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TripExportButton trip={trip} />
          <Tooltip content={t("Fit route")} placement="below">
            <Button
              iconOnly
              variant="secondary"
              size="sm"
              aria-label={t("Fit route")}
              onClick={() => {
                // Fit means the whole route — drop any day focus first so
                // the dimming matches the framed geometry.
                setSelectedDayNumber(null);
                mapRef.current?.fitRoute();
              }}
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
          {isOwner ? (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              collapseLabel
              leftIcon={<Users size={14} />}
              onClick={() => setCollaborateOpen(true)}
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
          {canEdit && (
            <Button
              variant="accent"
              size="sm"
              uppercase
              collapseLabel
              leftIcon={<Edit size={14} />}
              renderLink={({ className, children }) => (
                <Link
                  href={`/trips/${loaded.detail.id}/edit`}
                  className={className}
                >
                  {children}
                </Link>
              )}
            >
              {t("Edit")}
            </Button>
          )}
          {isOwner && (
            <>
              <span
                aria-hidden="true"
                className="h-[22px] w-px shrink-0 bg-line"
              />
              <Tooltip content={t("Delete trip")} placement="below">
                <Button
                  iconOnly
                  variant="danger"
                  size="sm"
                  loading={deleting}
                  aria-label={t("Delete trip")}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  <Trash2 size={15} />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </header>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("Delete this trip?")}
        message={t(
          '"{name}" and all its days, waypoints, and collaboration history are permanently removed. This cannot be undone.',
          { name: loaded.detail.title },
        )}
        tone="danger"
        confirmLabel={t("Delete permanently")}
        busy={deleting}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />

      <ConfirmDialog
        open={confirmLeaveOpen}
        title={t("Leave this trip?")}
        message={t(
          'You\'ll lose access to "{name}" and return to your trips. The owner can re-invite you later.',
          { name: loaded.detail.title },
        )}
        tone="danger"
        confirmLabel={t("Leave trip")}
        busy={leaving}
        onCancel={() => setConfirmLeaveOpen(false)}
        onConfirm={() => void handleLeave()}
      />

      {(deleteError || leaveError) && (
        <div
          role="alert"
          className="border-b border-quality-q1/30 bg-quality-q1/10 px-4 py-2 text-xs text-red-700"
        >
          {deleteError ?? leaveError}
        </div>
      )}

      {/* Main split: map | right column */}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex-1 bg-cream">
          <TripPlannerMap
            ref={mapRef}
            trip={displayedTrip}
            month={travelMonth}
            closuresData={closuresData}
            passesData={passesData}
            collaboratorCursors={collabSession.cursors}
            collaboratorProfiles={collabSession.members}
            // Suggestions are text-only (collaborate modal); not fed to the map
            // — they were only ever a dot auto-anchored to the start.
            searchAndPois
            // Emit the viewer's own cursor here too — without it, anyone on the
            // read-only preview was visible to no one (they rendered others'
            // cursors but never broadcast their own), so cursor awareness was
            // one-directional between the preview and the planner.
            onCursorMove={collabSession.emitCursor}
            {...(selectedDayNumber != null ? { selectedDayNumber } : {})}
            selectedRoadSegmentId={selectedRoadSegmentId}
            onOpenSegmentDetail={setSelectedRoadSegmentId}
          />
          <SegmentDetailSidebar
            state={segmentDetailState}
            onClose={() => setSelectedRoadSegmentId(null)}
            anchor="viewport"
          />
        </div>

        <aside
          aria-label={t("Trip detail panel")}
          className="hidden w-[370px] shrink-0 flex-col border-l border-line bg-paper lg:flex"
        >
          {/* Same panel chrome as the planner's "Plan & inspect" column. */}
          <div className="shrink-0 px-5 pt-4">
            <Stamp>{t("Trip preview")}</Stamp>
            <Heading size="md" as="h2" className="mt-1.5 text-[20px]">
              {t("Route & inspect")}
            </Heading>
            <p className="mt-1 text-[12px] leading-snug text-fg-dim">
              {t(
                "Crowdsourced road quality on every metre — no Street View detours.",
              )}
            </p>
            <div
              role="tablist"
              aria-label={t("Trip detail tabs")}
              className="mt-4 flex gap-0.5 border-b border-line"
            >
              <TabButton
                id="route"
                label={t("Route")}
                active={activeTab === "route"}
                onSelect={setActiveTab}
              />
              <TabButton
                id="inspect"
                label={t("Inspect")}
                active={activeTab === "inspect"}
                onSelect={setActiveTab}
              />
              <TabButton
                id="conditions"
                label={t("Conditions")}
                active={activeTab === "conditions"}
                onSelect={setActiveTab}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-9 pt-5">
            {activeTab === "route" && (
              <div className="space-y-4">
                <TripSummaryCard
                  trip={trip}
                  totalDistance={totalDistance}
                  totalDuration={totalDuration}
                  totalElevation={totalElevation}
                  // The summary's quality average is road-quality data like
                  // any other; `null` renders the same as a trip that has none.
                  qualityAvg={
                    qualityOverlayEnabled
                      ? (loaded.detail.quality_avg ?? null)
                      : null
                  }
                />
                {trip.days.length > 1 && (
                  <DayByDayList
                    days={trip.days}
                    selectedDayNumber={selectedDayNumber}
                    onSelectDay={handleSelectDay}
                  />
                )}
              </div>
            )}
            {activeTab === "inspect" && (
              <div>
                {trip.days.length > 1 && (
                  <div
                    role="group"
                    aria-label={t("Inspect day")}
                    className="mb-4 flex flex-wrap gap-1.5"
                  >
                    {trip.days.map((day, index) => {
                      const active = index === inspectDayIndex;
                      return (
                        <button
                          key={day.dayNumber}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setInspectDayIndex(index)}
                          className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.6px] transition ${
                            active
                              ? "border-ink bg-ink text-cream"
                              : "border-line bg-cream text-fg-dim hover:border-ink"
                          }`}
                        >
                          {t("Day {day}", { day: day.dayNumber })}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Same readout as the planner's INSPECT tab, read-only:
                    no onRerouteSegment, so flagged cards offer INSPECT. */}
                <InspectTab
                  day={
                    (displayedTrip ?? trip).days[
                      Math.min(
                        inspectDayIndex,
                        Math.max(0, (displayedTrip ?? trip).days.length - 1),
                      )
                    ] ?? null
                  }
                  selectedSegmentId={selectedPlannerSegmentId}
                  onInspectSegment={handleInspectSegment}
                />
              </div>
            )}
            {activeTab === "conditions" && (
              <div className="flex flex-col gap-6">
                {/* Same panels as the planner's CONDITIONS tab, read-only:
                    no onReroute* callbacks, so cards only focus the map. */}
                <div>
                  <SectionStamp n={1}>{t("Seasonal passes")}</SectionStamp>
                  <PassesPanel
                    month={travelMonth}
                    onMonthChange={setTravelMonth}
                    routes={closureRoutes}
                    data={passesData}
                    showRegionalList={false}
                    onFocusPass={(pass) =>
                      mapRef.current?.openConditionPopover({
                        kind: "pass",
                        id: pass.id,
                      })
                    }
                  />
                </div>
                <div>
                  <SectionStamp n={2}>{t("Closures & roadworks")}</SectionStamp>
                  <ClosuresPanel
                    month={travelMonth}
                    routes={closureRoutes}
                    data={closuresData}
                    showRegionalList={false}
                    onFocusClosure={(closure) =>
                      mapRef.current?.openConditionPopover({
                        kind: "closure",
                        id: closure.id,
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <TripCollaborateModal
        open={collaborateOpen}
        trip={trip}
        serverTripId={loaded.detail.id}
        ownerId={ownerId}
        currentUserId={currentUserId}
        canCreateInviteLink={canManageInvites}
        suggestions={collabSession.suggestions}
        onSuggestionsChange={collabSession.setSuggestions}
        suggestionsError={collabSession.suggestionsError}
        onClose={() => setCollaborateOpen(false)}
      />

      {/* Non-owner members reach suggestions through their own button —
          the same modal in suggestions-only mode. */}
      <TripCollaborateModal
        open={suggestionsOpen}
        mode="suggestions"
        trip={trip}
        serverTripId={loaded.detail.id}
        ownerId={ownerId}
        currentUserId={currentUserId}
        suggestions={collabSession.suggestions}
        onSuggestionsChange={collabSession.setSuggestions}
        suggestionsError={collabSession.suggestionsError}
        onClose={() => setSuggestionsOpen(false)}
      />
    </div>
  );
}
function StatusBadge({ status }: { status: string }) {
  const t = useTranslation();
  // Mirrors the canonical STATUS_PILL map in /trips/page.tsx — the
  // four trip statuses span q3 (planned) → accent (active) → q5
  // (completed), with paper/fg-dim/line for drafts and anything else.
  // Every tone keeps text-ink for ≥4.5:1 contrast on the 10px label.
  const tone =
    status === "active"
      ? "bg-accent text-ink"
      : status === "completed"
        ? "bg-quality-q5/40 text-ink"
        : status === "planned"
          ? "bg-quality-q3/50 text-ink"
          : "bg-paper text-fg-dim border border-line";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide ${tone}`}
    >
      {translateKnownLabel(status, TRIP_STATUS_LABELS, t)}
    </span>
  );
}
function TabButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: RightTab;
  label: string;
  active: boolean;
  onSelect: (id: RightTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={`relative flex-1 cursor-pointer pb-2.5 text-center font-mono text-[10.5px] font-bold uppercase tracking-[0.3px] transition ${
        active ? "text-accent" : "text-fg-mute hover:text-ink"
      }`}
    >
      {label}
      {active ? (
        <span className="absolute -bottom-px left-1.5 right-1.5 h-0.5 rounded bg-accent" />
      ) : null}
    </button>
  );
}
/** Clamp a fractional 0–5 quality score to the 1–5 tier QualityBars takes. */
function TripSummaryCard({
  trip,
  totalDistance,
  totalDuration,
  totalElevation,
  qualityAvg,
}: {
  trip: NonNullable<ReturnType<typeof tripFromDetail>>;
  totalDistance: number;
  totalDuration: number;
  totalElevation: number;
  qualityAvg: number | null;
}) {
  const t = useTranslation();
  const format = useFormat();
  // Backend rows may not carry quality_avg yet — fall back to the mean of
  // the measured day qualities so the row still reflects real data.
  const dayQualities = trip.days.map((d) => d.avgQuality).filter((q) => q > 0);
  const avg =
    qualityAvg ??
    (dayQualities.length > 0
      ? dayQualities.reduce((sum, q) => sum + q, 0) / dayQualities.length
      : null);
  return (
    <section className="rounded-xl border border-line bg-cream/60 p-4">
      <Stamp as="h2" className="mb-3 block">
        {t("Trip summary")}
      </Stamp>
      <div className="grid grid-cols-2 gap-3">
        <TileStat
          label={t("Distance")}
          value={format.distanceKm(totalDistance)}
        />
        <TileStat
          label={t("Ride time")}
          value={totalDuration > 0 ? format.duration(totalDuration) : "—"}
        />
        <TileStat label={t("Days")} value={format.integer(trip.days.length)} />
        <TileStat
          label={t("Elevation")}
          value={totalElevation > 0 ? format.elevation(totalElevation) : "—"}
          accent
        />
      </div>
      {avg != null && avg > 0 && (
        <div className="mt-3.5 flex items-center gap-2 border-t border-line pt-3">
          <span className="text-xl font-extrabold tracking-[-0.5px] text-accent">
            {format.decimal(avg, 1)}
          </span>
          <div className="flex-1">
            <QualityBars q={qualityTierOf(avg)} size={5} />
            <span className="mt-0.5 block font-mono text-[9.5px] uppercase tracking-[0.5px] text-fg-mute">
              {t("Avg route quality")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
