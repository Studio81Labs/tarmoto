"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BedDouble,
  Calendar,
  Check,
  Crown,
  Edit,
  Gauge,
  Loader2,
  MapPin,
  Mountain,
  Route,
  Share2,
  Shield,
  Trash2,
  User,
} from "lucide-react";
import { ApiError, tripsApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuthStore } from "@/stores/auth";
import { useTripStore } from "@/stores/trip";
import { useClosures } from "@/hooks/useClosures";
import { usePasses } from "@/hooks/usePasses";
import { useTripCollabSession } from "@/hooks/useTripCollabSession";
import { TripPlannerMap } from "@/components/TripPlannerMap";
import { UserAvatar } from "@/components/UserAvatar";
import { SegmentSidebar } from "@/components/SegmentSidebar";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { TripExportMenu } from "@/components/TripExportMenu";
import { buildTripClosureRoutes } from "@/lib/closures-summary";
import { currentUtcMonth } from "@/lib/passes-summary";
import {
  findOwnerId,
  tripFromDetail,
  type TripDetailMember,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import { formatDistance, formatDuration } from "@/lib/utils";
import { Button, Card, Heading, Stamp } from "@tarmoto/ui";
type RightTab = "days" | "members" | "collaborate";
interface LoadedTrip {
  detail: TripDetailResponse;
  members: TripDetailMember[];
}
export default function TripDetailPage() {
  const { tripId } = useParams<{
    tripId: string;
  }>();
  const router = useRouter();
  const [loaded, setLoaded] = useState<LoadedTrip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [collaborateOpen, setCollaborateOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RightTab>("days");
  const [travelMonth, setTravelMonth] = useState<number>(() =>
    currentUtcMonth(),
  );
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const setActiveTrip = useTripStore((s) => s.setActiveTrip);
  // Memoise the local Trip projection so referential equality doesn't
  // churn on every render — `TripPlannerMap` and `SegmentSidebar`
  // re-derive their overlays whenever `trip` changes identity.
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
  const canManageInvites = callerRole === "owner" || callerRole === "admin";
  const closureRoutes = useMemo(() => buildTripClosureRoutes(trip), [trip]);
  const closuresData = useClosures(travelMonth, closureRoutes);
  const passesData = usePasses(travelMonth, closureRoutes);
  // Activate the trip in the store so SegmentSidebar (which is
  // store-driven) renders the correct day/segment list. Reset on
  // unmount so navigating to the planner doesn't inherit a stale trip.
  useEffect(() => {
    setActiveTrip(trip);
    return () => {
      setActiveTrip(null);
    };
  }, [trip, setActiveTrip]);
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
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError("Couldn't load this trip. Check your connection.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, router, authReady]);
  const collabSession = useTripCollabSession(loaded ? loaded.detail.id : null);
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
          ? "This trip no longer exists."
          : "Couldn't delete the trip. Try again.";
      setDeleteError(message);
      setDeleting(false);
    }
  }, [loaded, router]);
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-fg-dim">
        <Loader2 size={20} className="mr-2 animate-spin" />
        {t("Loading trip\u2026 ")}
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl animate-fade-in p-4 md:p-7">
        <Link
          href="/trips"
          className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-fg-dim transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          {t("Back to trips ")}
        </Link>
        <Card padded={false} className="p-10 text-center">
          <Route size={36} className="mx-auto mb-3 text-fg-mute" />
          <Heading size="md" as="h2">
            {t("Trip not found")}
          </Heading>
          <p className="mt-2 text-sm text-fg-dim">
            {t("The trip may have been deleted, or the link may be wrong. ")}
          </p>
        </Card>
      </div>
    );
  }
  if (error || !loaded || !trip) {
    return (
      <div className="mx-auto max-w-2xl animate-fade-in p-4 md:p-7">
        <Link
          href="/trips"
          className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-fg-dim transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          {t("Back to trips ")}
        </Link>
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-6 text-sm text-red-400">
          {error ?? "Unknown error loading trip."}
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
      {/* Header / action bar */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <Link
            href="/trips"
            aria-label={t("Back to trips")}
            className="mt-1 rounded-lg p-1.5 text-fg-dim hover:bg-paper hover:text-ink transition"
          >
            <ArrowLeft size={16} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-ink">
                {loaded.detail.title}
              </h1>
              <StatusBadge status={loaded.detail.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-dim">
              <span className="inline-flex items-center gap-1">
                <Calendar size={11} />{" "}
                {t(trip.days.length === 1 ? "{count} day" : "{count} days", {
                  count: trip.days.length,
                })}
              </span>
              <span className="inline-flex items-center gap-1">
                <Route size={11} /> {formatDistance(totalDistance)}
              </span>
              {totalDuration > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Gauge size={11} /> {formatDuration(totalDuration)}
                </span>
              )}
              {totalElevation > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Mountain size={11} />{" "}
                  {t("{elevation} m gain", {
                    elevation: Math.round(totalElevation),
                  })}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <User size={11} />{" "}
                {t(
                  loaded.members.length === 1
                    ? "{count} member"
                    : "{count} members",
                  {
                    count: loaded.members.length,
                  },
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="accent"
            size="sm"
            uppercase
            leftIcon={<Edit size={16} />}
            renderLink={({ className, children }) => (
              <Link
                href={`/trips/${loaded.detail.id}/edit`}
                className={className}
              >
                {children}
              </Link>
            )}
          >
            {t("Edit ")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Share2 size={14} />}
            onClick={() => setCollaborateOpen(true)}
          >
            {t("Share ")}
          </Button>
          <TripExportMenu trip={trip} />
          {isOwner && (
            <Button
              variant="danger"
              size="sm"
              loading={deleting}
              leftIcon={<Trash2 size={14} />}
              aria-label={t("Delete trip")}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              {t("Delete ")}
            </Button>
          )}
        </div>
      </header>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("Delete this trip?")}
        message={t(
          '"{name}" and all its days, waypoints, and collaboration history are permanently removed. This cannot be undone. ',
          { name: loaded.detail.title },
        )}
        tone="danger"
        confirmLabel={t("Delete permanently")}
        busy={deleting}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />

      {deleteError && (
        <div
          role="alert"
          className="border-b border-quality-q1/30 bg-quality-q1/10 px-4 py-2 text-xs text-red-400"
        >
          {deleteError}
        </div>
      )}

      {/* Main split: map | right column */}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex-1 bg-cream">
          <TripPlannerMap
            trip={trip}
            month={travelMonth}
            closuresData={closuresData}
            passesData={passesData}
            collaboratorCursors={collabSession.cursors}
            suggestions={collabSession.suggestions}
          />
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-paper/80 px-2.5 py-1 text-[11px] text-ink backdrop-blur-sm">
            <label className="pointer-events-auto inline-flex items-center gap-2">
              {t("Travel month ")}
              <select
                value={travelMonth}
                onChange={(e) => setTravelMonth(Number(e.target.value))}
                className="rounded border border-line-strong bg-cream px-1.5 py-0.5 text-[11px] text-ink"
                aria-label={t("Travel month")}
              >
                {MONTHS.map((label, idx) => (
                  <option key={idx} value={idx + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <aside
          aria-label={t("Trip detail panel")}
          className="hidden w-96 shrink-0 flex-col border-l border-line bg-paper lg:flex"
        >
          <nav
            role="tablist"
            aria-label={t("Trip detail tabs")}
            className="flex shrink-0 border-b border-line"
          >
            <TabButton
              id="days"
              label="Days"
              active={activeTab === "days"}
              onSelect={setActiveTab}
            />
            <TabButton
              id="members"
              label={`Members (${loaded.members.length})`}
              active={activeTab === "members"}
              onSelect={setActiveTab}
            />
            <TabButton
              id="collaborate"
              label="Collaborate"
              active={activeTab === "collaborate"}
              onSelect={setActiveTab}
            />
          </nav>

          <div className="flex-1 overflow-y-auto">
            {activeTab === "days" && (
              <div className="p-4 space-y-4">
                <DaysList trip={trip} />
                <SegmentSidebarSection />
              </div>
            )}
            {activeTab === "members" && (
              <MembersList
                members={loaded.members}
                inviteCode={loaded.detail.invite_code}
                canInvite={canManageInvites}
                onShareLinkClick={() => {
                  setCollaborateOpen(true);
                }}
              />
            )}
            {activeTab === "collaborate" && (
              <CollaborateTabSummary
                onOpenModal={() => setCollaborateOpen(true)}
                suggestionsCount={collabSession.suggestions.length}
              />
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
    </div>
  );
}
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function StatusBadge({ status }: { status: string }) {
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
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {status}
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
      className={`flex-1 px-3 py-3 text-xs font-medium transition ${
        active
          ? "border-b-2 border-accent text-ink"
          : "border-b-2 border-transparent text-fg-dim hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
function DaysList({
  trip,
}: {
  trip: NonNullable<ReturnType<typeof tripFromDetail>>;
}) {
  if (trip.days.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-cream/40 p-4 text-xs text-fg-dim">
        {t(
          "This trip has no days yet. Open it in the planner to generate the itinerary. ",
        )}
      </p>
    );
  }
  return (
    <section className="space-y-2">
      <Stamp as="h2">{t("Day-by-day ")}</Stamp>
      <ul className="space-y-2">
        {trip.days.map((day) => (
          <li
            key={day.dayNumber}
            className="rounded-lg border border-line bg-cream/60 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">
                {t("Day ")}
                {day.dayNumber}
                {day.title ? (
                  <span className="ml-1 font-normal text-fg-dim">
                    · {day.title}
                  </span>
                ) : null}
              </h3>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <Stat label="Distance" value={formatDistance(day.distanceKm)} />
              <Stat
                label="Ride time"
                value={
                  day.durationMinutes > 0
                    ? formatDuration(day.durationMinutes)
                    : "—"
                }
              />
              <Stat
                label="Elevation"
                value={
                  day.elevationGain > 0
                    ? `${Math.round(day.elevationGain)} m`
                    : "—"
                }
              />
            </dl>
            {day.overnightStop && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-dim">
                <BedDouble size={11} className="text-fg-dim" />
                {t("Overnight: ")}
                {day.overnightStop.name}
              </p>
            )}
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-dim">
              <MapPin size={11} />
              {t("{count} {waypointLabel}", {
                count: day.waypoints.length,
                waypointLabel:
                  day.waypoints.length === 1 ? "waypoint" : "waypoints",
              })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-paper/60 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-fg-dim">
        {label}
      </dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}
function SegmentSidebarSection() {
  // Only show the Road Preview Cards header when the planner has populated
  // segments. Backend-loaded trips currently arrive without segments, so
  // showing an empty card list here would be noise — `SegmentSidebar`
  // handles the empty case itself.
  return (
    <section className="-mx-4 -mb-4 border-t border-line">
      <SegmentSidebar />
    </section>
  );
}
function MembersList({
  members,
  inviteCode,
  canInvite,
  onShareLinkClick,
}: {
  members: TripDetailMember[];
  inviteCode: string;
  canInvite: boolean;
  onShareLinkClick: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard write may fail silently in unsupported browsers */
    }
  };
  return (
    <div className="space-y-4 p-4">
      <section>
        <Stamp as="h2">{t("Members ")}</Stamp>
        <ul className="mt-2 space-y-2">
          {members.length === 0 ? (
            <li className="text-xs text-fg-dim">{t("No members yet.")}</li>
          ) : (
            members.map((m) => <MemberRow key={m.user_id} member={m} />)
          )}
        </ul>
      </section>

      {canInvite && (
        <section className="rounded-lg border border-line bg-cream/40 p-3">
          <h3 className="text-xs font-semibold text-ink">
            {t("Invite riders")}
          </h3>
          <p className="mt-1 text-[11px] text-fg-dim">
            {t(
              "Share the invite code for mobile riders, or copy a web link that lets signed-in riders join the group planner. ",
            )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-line-strong bg-paper px-2 py-1.5 text-xs font-mono text-accent">
              {inviteCode}
            </code>
            <button
              type="button"
              onClick={handleCopyCode}
              className="inline-flex items-center gap-1 rounded-md bg-paper px-2.5 py-1.5 text-[11px] text-ink hover:bg-paper-2 transition"
            >
              {copied ? <Check size={12} /> : null} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={onShareLinkClick}
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-accent hover:underline"
          >
            <Share2 size={11} />
            {t("Or share a group link ")}
          </button>
        </section>
      )}
    </div>
  );
}
function MemberRow({ member }: { member: TripDetailMember }) {
  const roleStyle =
    member.role === "owner"
      ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
      : member.role === "admin"
        ? "bg-blue-500/10 text-blue-300 border-blue-500/30"
        : "bg-paper text-ink border-line-strong";
  const RoleIcon =
    member.role === "owner" ? Crown : member.role === "admin" ? Shield : User;
  return (
    <li className="flex items-center gap-3 rounded-lg border border-line bg-cream/60 p-2.5">
      <UserAvatar name={member.display_name} size={32} fontSize={12} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{member.display_name}</p>
        <p className="text-[10px] text-fg-dim">
          {t("Joined ")}
          {formatJoinedDate(member.joined_at)}
        </p>
      </div>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${roleStyle}`}
      >
        <RoleIcon size={10} /> {member.role}
      </span>
    </li>
  );
}
function CollaborateTabSummary({
  onOpenModal,
  suggestionsCount,
}: {
  onOpenModal: () => void;
  suggestionsCount: number;
}) {
  return (
    <div className="p-4 space-y-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-widest text-fg-dim">
        {t("Collaborate ")}
      </h2>
      <p className="text-xs text-fg-dim">
        {t(
          "Invite riders, propose route tweaks, vote on suggestions, and follow the activity log \u2014 all in one place. ",
        )}
      </p>
      <div className="rounded-lg border border-line bg-cream/60 p-3">
        <p className="text-xs text-ink">
          {suggestionsCount}
          {t("open suggestion ")}
          {suggestionsCount === 1 ? "" : "s"}
        </p>
        <Button
          variant="accent"
          size="sm"
          uppercase
          className="mt-2"
          onClick={onOpenModal}
        >
          {t("Open collaboration panel ")}
        </Button>
      </div>
    </div>
  );
}
function formatJoinedDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "recently";
  }
}
