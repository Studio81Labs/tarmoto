"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Check,
  Copy,
  Gauge,
  GripVertical,
  Loader2,
  MapPin,
  Plus,
  Route as RouteIcon,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useUserTrips } from "@/hooks/useUserTrips";
import { useUserRides, type UserRide } from "@/hooks/useUserRides";
import {
  ApiError,
  routeCollectionsApi,
  type RouteCollectionVisibility,
} from "@/lib/api";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import {
  mapDetailToView,
  moveItem,
  reorderPayload,
  type CollectionRideRef,
  type CollectionTripRef,
  type RouteCollectionView,
} from "@/lib/route-collections";
import { tripDistanceKmOrNull } from "@/lib/trip-filters";
import { buildRoutePreview, type RoutePoint } from "@/lib/ride-detail";
import { formatDistance, formatRelativeTime } from "@/lib/utils";
import type { Trip, TripDay } from "@/lib/types";
type LoadState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      collection: RouteCollectionView;
    }
  | {
      phase: "not-found";
    }
  | {
      phase: "error";
      message: string;
    };
/**
 * Owner-only detail page. Lives under the `(dashboard)` route group, which
 * gates auth, and pulls from `GET /collections/:id` — the backend deliberately
 * 404s that endpoint for non-owners (id existence isn't a side channel for
 * unlisted collections). Non-owner viewing happens through the public
 * `/community/collections/shared/[slug]` route, not this page.
 */
export default function CollectionDetailPage() {
  const { collectionId } = useParams<{
    collectionId: string;
  }>();
  const router = useRouter();
  const {
    trips,
    tripById,
    loading: loadingTrips,
    error: tripsError,
  } = useUserTrips();
  const {
    rides,
    rideById,
    loading: loadingRides,
    error: ridesError,
  } = useUserRides();
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [showPicker, setShowPicker] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (id: string) => {
    try {
      const { data } = await routeCollectionsApi.get(id);
      setLoad({ phase: "ready", collection: mapDetailToView(data) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLoad({ phase: "not-found" });
        return;
      }
      setLoad({
        phase: "error",
        message:
          err instanceof Error ? err.message : "Failed to load collection",
      });
    }
  }, []);
  useEffect(() => {
    if (!collectionId) return;
    setLoad({ phase: "loading" });
    void reload(collectionId);
  }, [collectionId, reload]);
  const collection = load.phase === "ready" ? load.collection : null;
  const handleAddItems = async (input: {
    tripIds: string[];
    rideIds: string[];
  }) => {
    if (!collection) return;
    if (input.tripIds.length === 0 && input.rideIds.length === 0) return;
    setActionError(null);
    setBusy(true);
    try {
      // Sequential adds: the backend assigns position via MAX(position)+1
      // inside a per-collection txn, so concurrent adds against the same
      // collection can collide on the same position value. Serialising here
      // keeps the resulting order deterministic. Trips first, then rides —
      // matches picker tab order so users see the items appear in the order
      // they selected them.
      for (const tid of input.tripIds) {
        await routeCollectionsApi.addItem(collection.id, { trip_id: tid });
      }
      for (const rid of input.rideIds) {
        await routeCollectionsApi.addItem(collection.id, { ride_id: rid });
      }
      await reload(collection.id);
      setShowPicker(false);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to add routes",
      );
    } finally {
      setBusy(false);
    }
  };
  const handleReorder = async (
    section: "trips" | "rides",
    fromIndex: number,
    toIndex: number,
  ) => {
    if (!collection) return;
    if (fromIndex === toIndex) return;
    const sourceRefs =
      section === "trips" ? collection.tripRefs : collection.rideRefs;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= sourceRefs.length ||
      toIndex >= sourceRefs.length
    ) {
      return;
    }
    // Optimistic: rebuild the view with the new in-section order so the row
    // animates to its new spot immediately. The server is the source of
    // truth for `position`; we only renumber locally on success (after the
    // refetch from `reorderItems`).
    const optimistic: RouteCollectionView =
      section === "trips"
        ? (() => {
            const nextRefs: CollectionTripRef[] = moveItem(
              collection.tripRefs,
              fromIndex,
              toIndex,
            );
            return {
              ...collection,
              tripRefs: nextRefs,
              tripIds: nextRefs.map((r) => r.tripId),
            };
          })()
        : (() => {
            const nextRefs: CollectionRideRef[] = moveItem(
              collection.rideRefs,
              fromIndex,
              toIndex,
            );
            return {
              ...collection,
              rideRefs: nextRefs,
              rideIds: nextRefs.map((r) => r.rideId),
            };
          })();
    setLoad({ phase: "ready", collection: optimistic });
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await routeCollectionsApi.reorderItems(
        collection.id,
        reorderPayload(optimistic),
      );
      setLoad({ phase: "ready", collection: mapDetailToView(data) });
    } catch (err) {
      // Roll back to the pre-reorder snapshot — the user sees the row snap
      // back to its original position so they know the change didn't take.
      setLoad({ phase: "ready", collection });
      setActionError(
        err instanceof Error ? err.message : "Failed to reorder routes",
      );
    } finally {
      setBusy(false);
    }
  };
  const handleRemoveItem = async (itemId: string) => {
    if (!collection) return;
    setActionError(null);
    setBusy(true);
    try {
      await routeCollectionsApi.removeItem(collection.id, itemId);
      await reload(collection.id);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to remove route",
      );
    } finally {
      setBusy(false);
    }
  };
  const handleVisibilityChange = async (next: RouteCollectionVisibility) => {
    if (!collection) return;
    // Clicking the already-selected chip would otherwise fire a PATCH that
    // changes nothing and briefly freezes every other action (Share, Add
    // routes) for a network round trip. Bail before touching busy/error.
    if (next === collection.visibility) return;
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await routeCollectionsApi.update(collection.id, {
        visibility: next,
      });
      setLoad({ phase: "ready", collection: mapDetailToView(data) });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to update visibility",
      );
    } finally {
      setBusy(false);
    }
  };
  if (load.phase === "loading") {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading collection\u2026")}
        </div>
      </div>
    );
  }
  if (load.phase === "not-found") {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <Link
          href="/community/collections"
          className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Collections")}
        </Link>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
          <RouteIcon size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-200 font-medium mb-1">
            {t("Collection not found")}
          </p>
          <p className="text-sm text-slate-500">
            {t(
              "This collection may have been deleted, or it's private and you don't own it. ",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <Link
          href="/community/collections"
          className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Collections")}
        </Link>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-10 text-center">
          <p className="text-amber-200 font-medium mb-1">
            {t("Couldn't load this collection")}
          </p>
          <p className="text-sm text-slate-500 mb-4">{load.message}</p>
          <button
            type="button"
            onClick={() => collectionId && void reload(collectionId)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
          >
            {t("Retry")}
          </button>
        </div>
      </div>
    );
  }
  // ready
  const presentTrips = collection!.tripRefs
    .map((ref) => tripById.get(ref.tripId))
    .filter((trip): trip is Trip => trip != null);
  const presentRides = collection!.rideRefs
    .map((ref) => rideById.get(ref.rideId))
    .filter((r): r is UserRide => r != null);
  // Distance covers both trips (planner geometry) and rides (recorded distance).
  // Trip distance is computed from per-day route geometry; ride distance comes
  // straight from the backend `distance_km` field.
  //
  // `presentTrips` is sourced from `useUserTrips()` which currently returns
  // TripSummaryDto[] (no `days`, no per-day distances). We exclude those
  // unhydrated trips from the aggregate rather than letting their 0s pull the
  // total down to a confidently-wrong number; the total below renders the
  // partial sum and `tripsWithUnknownDistance` powers a "+N trips, distance
  // pending" annotation on the stat card. Pending #541 (TripSummary type
  // split) — once the list endpoint or its consumer carries a known total,
  // these unhydrated trips contribute to the sum like rides do.
  const tripDistances = presentTrips.map((trip) => tripDistanceKmOrNull(trip));
  const tripsWithUnknownDistance = tripDistances.filter(
    (d) => d === null,
  ).length;
  const knownTripDistanceKm = tripDistances.reduce<number>(
    (sum, d) => sum + (d ?? 0),
    0,
  );
  const totalDistance =
    knownTripDistanceKm +
    presentRides.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  // Riding days only counts trip days — recorded rides are point-in-time, not
  // multi-day plans. A separate "Rides" stat surfaces recorded-ride count
  // alongside the planner-day count.
  // `presentTrips` is fed by `useUserTrips()` which surfaces
  // TripSummaryDto[] from the list endpoint — `days` is undefined there,
  // so prefer `num_days`. Falls back to `days.length` for any detail-
  // hydrated entries.
  const totalDays = presentTrips.reduce(
    (sum, trip) => sum + (trip.num_days ?? trip.days?.length ?? 0),
    0,
  );
  const totalMissing =
    collection!.tripRefs.length -
    presentTrips.length +
    (collection!.rideRefs.length - presentRides.length);
  const memberTripIds = new Set(collection!.tripIds);
  const memberRideIds = new Set(collection!.rideIds);
  const availableTrips = trips.filter((trip) => !memberTripIds.has(trip.id));
  const availableRides = rides.filter((r) => !memberRideIds.has(r.id));
  const totalRefs = collection!.tripRefs.length + collection!.rideRefs.length;
  const loadingMembers = loadingTrips || loadingRides;
  const memberLoadError = tripsError || ridesError;
  return (
    <div className="p-6 max-w-4xl mx-auto animate-fade-in">
      <Link
        href="/community/collections"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
      >
        <ArrowLeft size={16} />
        {t("Collections")}
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold break-words mb-1">
              {collection!.title}
            </h1>
            <RouteCollectionVisibilityPill
              visibility={collection!.visibility}
            />
          </div>
          <p className="text-xs text-slate-500">
            {t("Updated")}
            {formatRelativeTime(collection!.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ShareButton collection={collection!} />
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
          >
            <Plus size={14} />
            {t("Add routes")}
          </button>
        </div>
      </header>

      <VisibilitySelector
        value={collection!.visibility}
        onChange={(v) => void handleVisibilityChange(v)}
        disabled={busy}
      />

      {collection!.description && (
        <p className="text-sm text-slate-300 mt-3 max-w-2xl whitespace-pre-line">
          {collection!.description}
        </p>
      )}

      {actionError && (
        <p role="alert" className="mt-3 text-xs text-red-300">
          {actionError}
        </p>
      )}

      <section className="mt-6 grid grid-cols-3 gap-3">
        <Stat
          label="Routes"
          value={`${collection!.itemCount}`}
          hint={
            // "Unavailable" rolls up trips + rides whose owning record was
            // deleted (or hidden from the local cache). Suppress the badge
            // while either fetch is in flight or errored — a transient API
            // outage would otherwise look like everything was deleted.
            totalMissing > 0 && !loadingMembers && !memberLoadError
              ? `${totalMissing} unavailable`
              : undefined
          }
        />
        <Stat
          label="Total distance"
          value={
            loadingMembers || memberLoadError
              ? "—"
              : formatDistance(totalDistance)
          }
          hint={
            // List-endpoint trips don't carry per-day distances, so their
            // contribution is omitted from the aggregate rather than counted
            // as zero. Surface the omission so the user understands the
            // total isn't lying.
            !loadingMembers && !memberLoadError && tripsWithUnknownDistance > 0
              ? `+${tripsWithUnknownDistance} trip${tripsWithUnknownDistance === 1 ? "" : "s"} not counted`
              : undefined
          }
        />
        <Stat
          label="Riding days"
          value={loadingMembers || memberLoadError ? "—" : `${totalDays}`}
          hint={
            // Surface recorded-ride count separately so users see that ride
            // items contribute to the collection even though they don't roll
            // up into the multi-day "riding days" count.
            !loadingMembers && !memberLoadError && presentRides.length > 0
              ? `+${presentRides.length} ride${presentRides.length === 1 ? "" : "s"}`
              : undefined
          }
        />
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          {t("Routes")}
        </h2>
        {totalRefs === 0 ? (
          <EmptyRoutes onAdd={() => setShowPicker(true)} />
        ) : loadingMembers || memberLoadError ? (
          <>
            {memberLoadError && (
              <div
                role="alert"
                className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200"
              >
                {t(
                  "Couldn't load your routes right now. Try again in a moment. ",
                )}
              </div>
            )}
            <ul className="space-y-3">
              {collection!.tripRefs.map((ref) => (
                <LoadingTripRow key={`trip-${ref.itemId}`} />
              ))}
              {collection!.rideRefs.map((ref) => (
                <LoadingTripRow key={`ride-${ref.itemId}`} />
              ))}
            </ul>
          </>
        ) : (
          <>
            {collection!.tripRefs.length > 0 && (
              <SortableItemList
                ariaLabel="Trips in this collection. Drag handle to reorder."
                ids={collection!.tripRefs.map((r) => r.itemId)}
                disabled={busy || collection!.tripRefs.length < 2}
                onReorder={(from, to) => void handleReorder("trips", from, to)}
              >
                {collection!.tripRefs.map((ref) => {
                  const trip = tripById.get(ref.tripId);
                  return (
                    <SortableRow
                      key={ref.itemId}
                      id={ref.itemId}
                      disabled={busy || collection!.tripRefs.length < 2}
                    >
                      {trip ? (
                        <TripRow
                          trip={trip}
                          onRemove={() => void handleRemoveItem(ref.itemId)}
                        />
                      ) : (
                        <MissingItemRow
                          kind="trip"
                          onRemove={() => void handleRemoveItem(ref.itemId)}
                        />
                      )}
                    </SortableRow>
                  );
                })}
              </SortableItemList>
            )}
            {collection!.rideRefs.length > 0 && (
              <SortableItemList
                ariaLabel="Rides in this collection. Drag handle to reorder."
                ids={collection!.rideRefs.map((r) => r.itemId)}
                disabled={busy || collection!.rideRefs.length < 2}
                className={collection!.tripRefs.length > 0 ? "mt-3" : undefined}
                onReorder={(from, to) => void handleReorder("rides", from, to)}
              >
                {collection!.rideRefs.map((ref) => {
                  const ride = rideById.get(ref.rideId);
                  return (
                    <SortableRow
                      key={ref.itemId}
                      id={ref.itemId}
                      disabled={busy || collection!.rideRefs.length < 2}
                    >
                      {ride ? (
                        <RideRow
                          ride={ride}
                          onRemove={() => void handleRemoveItem(ref.itemId)}
                        />
                      ) : (
                        <MissingItemRow
                          kind="ride"
                          onRemove={() => void handleRemoveItem(ref.itemId)}
                        />
                      )}
                    </SortableRow>
                  );
                })}
              </SortableItemList>
            )}
          </>
        )}
      </section>

      {showPicker && (
        <RoutePickerModal
          trips={availableTrips}
          rides={availableRides}
          loadingTrips={loadingTrips}
          loadingRides={loadingRides}
          tripsError={tripsError}
          ridesError={ridesError}
          hasAnyTrips={trips.length > 0}
          hasAnyRides={rides.length > 0}
          onClose={() => setShowPicker(false)}
          onAdd={(input) => void handleAddItems(input)}
          onPlanTrip={() => router.push("/trips/planner")}
        />
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────
function VisibilitySelector({
  value,
  onChange,
  disabled,
}: {
  value: RouteCollectionVisibility;
  onChange: (next: RouteCollectionVisibility) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">{t("Visibility")}</span>
      {(["private", "unlisted", "public"] as const).map((v) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 rounded-full border transition disabled:opacity-50 ${
            v === value
              ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/10 text-tarmoto-cyan"
              : "border-slate-800 bg-slate-900 text-slate-400 hover:text-white"
          }`}
        >
          {v === "public"
            ? "Public"
            : v === "unlisted"
              ? "Unlisted"
              : "Private"}
        </button>
      ))}
    </div>
  );
}
function ShareButton({ collection }: { collection: RouteCollectionView }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);
  const sharable = collection.visibility !== "private";
  const url =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/community/collections/shared/${collection.slug}`;
  const handle = async () => {
    if (!sharable) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  return (
    <button
      type="button"
      onClick={() => void handle()}
      disabled={!sharable}
      title={
        sharable
          ? "Copy share link"
          : "Make this collection unlisted or public to share"
      }
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
        !sharable
          ? "bg-slate-900 border border-slate-800 text-slate-500 cursor-not-allowed"
          : copyState === "copied"
            ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
            : "bg-slate-900 border border-slate-800 text-slate-200 hover:border-slate-700"
      }`}
    >
      {copyState === "copied" ? (
        <>
          <Check size={14} />
          {t("Copied")}
        </>
      ) : copyState === "error" ? (
        <>
          <Copy size={14} />
          {t("Copy failed")}
        </>
      ) : (
        <>
          <Share2 size={14} />
          {t("Share")}
        </>
      )}
    </button>
  );
}
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-[11px] uppercase tracking-widest text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-amber-400">{hint}</p>}
    </div>
  );
}
/**
 * Wraps a list of `SortableRow` children in dnd-kit's `DndContext` +
 * `SortableContext`. The component is intentionally generic — it doesn't
 * know whether the rows are trips or rides, only that each child carries an
 * `id` matching one of the `ids` prop entries. The owner page uses two
 * separate instances (one for trips, one for rides) so each section
 * reorders independently and the public-page positions stay grouped by
 * kind, mirroring the on-screen layout.
 */
function SortableItemList({
  ariaLabel,
  ids,
  disabled,
  className,
  onReorder,
  children,
}: {
  ariaLabel: string;
  ids: readonly string[];
  disabled: boolean;
  className?: string;
  onReorder: (fromIndex: number, toIndex: number) => void;
  children: React.ReactNode;
}) {
  // Pointer threshold of 5px stops a click on the drag handle from being
  // treated as a drag — without it the handle's `cursor: grab` UX is
  // useless because every accidental jiggle starts a drag-and-drop.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={disabled ? undefined : handleDragEnd}
    >
      <SortableContext
        items={ids as string[]}
        strategy={verticalListSortingStrategy}
      >
        <ul aria-label={ariaLabel} className={`space-y-3 ${className ?? ""}`}>
          {children}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
/**
 * One sortable row. Renders a drag handle on the left and the row body to
 * its right. The handle (not the whole row) carries the drag listeners so
 * inner `<Link>` clicks for navigation keep working.
 */
function SortableRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Lift the dragged row above its neighbours and dim the rest so the
    // drop target is visually obvious. `touchAction: none` on the handle
    // (below) keeps mobile scrolling intact while still allowing drag.
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  return (
    <li ref={setNodeRef} style={style} className="flex items-stretch gap-2">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={t("Reorder")}
        className={`shrink-0 self-stretch flex items-center px-1 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-slate-800/50 disabled:opacity-30 disabled:cursor-not-allowed transition ${disabled ? "" : "cursor-grab active:cursor-grabbing"}`}
        style={{ touchAction: "none" }}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  );
}
function EmptyRoutes({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-dashed border-slate-800 p-10 text-center">
      <RouteIcon size={40} className="mx-auto text-slate-600 mb-3" />
      <p className="text-slate-400 mb-1">
        {t("No routes in this collection yet")}
      </p>
      <p className="text-sm text-slate-500 mb-5">
        {t("Add routes from your planned or completed trips.")}
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
      >
        <Plus size={16} />
        {t("Add routes")}
      </button>
    </div>
  );
}
function TripRow({ trip, onRemove }: { trip: Trip; onRemove: () => void }) {
  // List-endpoint trips arrive without `days` (TripSummaryDto): the route
  // preview silently degrades to no-line, and `distance === null` hides
  // the distance pill below rather than showing "0 km" for a value we
  // don't actually know.
  const days = trip.days ?? [];
  const dayCount = trip.num_days ?? days.length;
  const points = useMemo(() => combineTripRoutePoints(days), [days]);
  const preview = useMemo(() => buildRoutePreview(points, 200, 6), [points]);
  const distance = tripDistanceKmOrNull(trip);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 hover:border-slate-700 transition">
      <div className="flex items-stretch gap-0">
        <Link
          href={`/trips/${trip.id}`}
          className="flex-1 flex items-center gap-4 p-4 min-w-0 group"
        >
          <div className="hidden sm:flex shrink-0 w-24 h-16 items-center justify-center rounded-lg bg-slate-950 border border-slate-800">
            {preview ? (
              <svg
                viewBox={preview.viewBox}
                className="h-full w-full"
                role="img"
                aria-label={`${trip.name} route preview`}
              >
                <path
                  d={preview.path}
                  fill="none"
                  stroke="#0ED3CF"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <RouteIcon size={20} className="text-slate-600" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-white group-hover:text-tarmoto-cyan transition truncate">
              {trip.name}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Calendar size={12} />
                {dayCount === 1
                  ? t("1 day")
                  : t("{count} days", { count: dayCount })}
              </span>
              {distance !== null && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} />
                  {formatDistance(distance)}
                </span>
              )}
              <span className="text-[11px] text-slate-600 uppercase tracking-widest">
                {trip.status}
              </span>
            </div>
          </div>
        </Link>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${trip.name} from collection`}
          className="px-3 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
function RideRow({ ride, onRemove }: { ride: UserRide; onRemove: () => void }) {
  const displayName =
    ride.name ?? `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 hover:border-slate-700 transition">
      <div className="flex items-stretch gap-0">
        <Link
          href={`/rides/${ride.id}`}
          className="flex-1 flex items-center gap-4 p-4 min-w-0 group"
        >
          <div className="hidden sm:flex shrink-0 w-24 h-16 items-center justify-center rounded-lg bg-slate-950 border border-slate-800">
            <Gauge size={20} className="text-slate-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-white group-hover:text-tarmoto-cyan transition truncate">
              {displayName}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Calendar size={12} />
                {new Date(ride.started_at).toLocaleDateString()}
              </span>
              {ride.distance_km != null && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} />
                  {formatDistance(ride.distance_km)}
                </span>
              )}
              {ride.avg_road_quality != null && (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                  {t("Quality {quality}", {
                    quality: ride.avg_road_quality.toFixed(1),
                  })}
                </span>
              )}
              <span className="text-[11px] text-slate-600 uppercase tracking-widest">
                {ride.ride_type}
              </span>
            </div>
          </div>
        </Link>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${displayName} from collection`}
          className="px-3 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
function MissingItemRow({
  kind,
  onRemove,
}: {
  kind: "trip" | "ride";
  onRemove: () => void;
}) {
  const label = kind === "trip" ? "Trip" : "Ride";
  return (
    <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-slate-400">
          {t("{label} no longer available", { label })}
        </p>
        <p className="text-[11px] text-slate-600">
          {t("The route may have been deleted or belongs to another account.")}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition"
      >
        <X size={12} />
        {t("Remove")}
      </button>
    </div>
  );
}
function LoadingTripRow() {
  return (
    <li className="rounded-2xl border border-slate-800 bg-slate-900 p-4 flex items-center gap-4 animate-pulse">
      <div className="hidden sm:block shrink-0 w-24 h-16 rounded-lg bg-slate-800" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-3.5 w-1/2 rounded bg-slate-800" />
        <div className="h-2.5 w-1/3 rounded bg-slate-800" />
      </div>
    </li>
  );
}
// ─────────────────────────────────────────────────────────
// Route picker modal — segmented "Trips | Rides" tabs.
// Each tab maintains its own selection set so switching back and forth
// doesn't accidentally drop the user's choices on the other side.
// ─────────────────────────────────────────────────────────
type PickerTab = "trips" | "rides";
function RoutePickerModal({
  trips,
  rides,
  loadingTrips,
  loadingRides,
  tripsError,
  ridesError,
  hasAnyTrips,
  hasAnyRides,
  onClose,
  onAdd,
  onPlanTrip,
}: {
  trips: Trip[];
  rides: UserRide[];
  loadingTrips: boolean;
  loadingRides: boolean;
  tripsError: boolean;
  ridesError: boolean;
  hasAnyTrips: boolean;
  hasAnyRides: boolean;
  onClose: () => void;
  onAdd: (input: { tripIds: string[]; rideIds: string[] }) => void;
  onPlanTrip: () => void;
}) {
  const [tab, setTab] = useState<PickerTab>("trips");
  const [selectedTrips, setSelectedTrips] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedRides, setSelectedRides] = useState<Set<string>>(
    () => new Set(),
  );
  const [search, setSearch] = useState("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Reset the search box on tab switch — search state is per-tab in spirit
  // (different placeholder, different fields searched), and carrying it over
  // would surface confusing "no results" messages when the active text
  // doesn't match the new tab's data.
  useEffect(() => {
    setSearch("");
  }, [tab]);
  const visibleTrips = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return trips;
    return trips.filter((trip) =>
      `${trip.name} ${trip.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [trips, search]);
  const visibleRides = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rides;
    return rides.filter((r) => {
      const fallbackName = `Ride on ${new Date(r.started_at).toLocaleDateString()}`;
      const haystack = `${r.name ?? fallbackName} ${r.ride_type}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [rides, search]);
  const toggle = (kind: PickerTab, id: string) => {
    if (kind === "trips") {
      setSelectedTrips((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSelectedRides((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  };
  const totalSelected = selectedTrips.size + selectedRides.size;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">
            {t("Add routes")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X size={14} />
          </button>
        </div>

        <div
          role="tablist"
          aria-label={t("Add routes from")}
          className="mb-3 flex gap-1 rounded-lg bg-slate-950 border border-slate-800 p-1"
        >
          <PickerTabButton
            active={tab === "trips"}
            onClick={() => setTab("trips")}
            label="Trips"
            count={selectedTrips.size}
          />
          <PickerTabButton
            active={tab === "rides"}
            onClick={() => setTab("rides")}
            label="Rides"
            count={selectedRides.size}
          />
        </div>

        <input
          type="text"
          placeholder={
            tab === "trips" ? "Search your trips…" : "Search your rides…"
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-tarmoto-cyan mb-3"
        />

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {tab === "trips" ? (
            <TripPickerList
              trips={trips}
              visibleTrips={visibleTrips}
              loading={loadingTrips}
              error={tripsError}
              hasAnyTrips={hasAnyTrips}
              selected={selectedTrips}
              onToggle={(id) => toggle("trips", id)}
              onPlanTrip={onPlanTrip}
            />
          ) : (
            <RidePickerList
              rides={rides}
              visibleRides={visibleRides}
              loading={loadingRides}
              error={ridesError}
              hasAnyRides={hasAnyRides}
              selected={selectedRides}
              onToggle={(id) => toggle("rides", id)}
            />
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">
            {t("{count} selected", { count: totalSelected })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white transition"
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              disabled={totalSelected === 0}
              onClick={() =>
                onAdd({
                  tripIds: Array.from(selectedTrips),
                  rideIds: Array.from(selectedRides),
                })
              }
              className="px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {t("Add")}
              {totalSelected > 0 ? ` (${totalSelected})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
function PickerTabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition ${
        active
          ? "bg-slate-800 text-white"
          : "text-slate-400 hover:text-white hover:bg-slate-900"
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 rounded-full text-[10px] ${
            active
              ? "bg-tarmoto-cyan/20 text-tarmoto-cyan"
              : "bg-slate-800 text-slate-300"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
function TripPickerList({
  trips,
  visibleTrips,
  loading,
  error,
  hasAnyTrips,
  selected,
  onToggle,
  onPlanTrip,
}: {
  trips: Trip[];
  visibleTrips: Trip[];
  loading: boolean;
  error: boolean;
  hasAnyTrips: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onPlanTrip: () => void;
}) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-slate-500">
        <Loader2
          size={16}
          className="animate-spin inline-block mr-2 align-[-3px]"
        />
        {t("Loading your trips\u2026")}
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-6 text-center text-sm text-amber-200"
      >
        {t(
          "Couldn't load your trips right now. Close this and try again in a moment. ",
        )}
      </div>
    );
  }
  if (trips.length === 0) {
    return hasAnyTrips ? (
      <div className="py-8 text-center">
        <p className="text-sm text-slate-400 mb-1">
          {t("All your trips are already in this collection")}
        </p>
        <p className="text-xs text-slate-500">
          {t("Plan another trip to add it here.")}
        </p>
      </div>
    ) : (
      <div className="py-8 text-center">
        <p className="text-sm text-slate-400 mb-1">
          {t("You don't have any trips yet")}
        </p>
        <p className="text-xs text-slate-500 mb-4">
          {t("Plan a trip first and it will show up here.")}
        </p>
        <button
          type="button"
          onClick={onPlanTrip}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs hover:bg-slate-700 transition"
        >
          <Plus size={14} />
          {t("New trip")}
        </button>
      </div>
    );
  }
  if (visibleTrips.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {t("No trips match your search.")}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {visibleTrips.map((trip) => {
        const checked = selected.has(trip.id);
        // `distance === null` ⇒ summary-only; drop the distance segment from
        // the meta line rather than rendering "0 km".
        const distance = tripDistanceKmOrNull(trip);
        const dayCount = trip.num_days ?? trip.days?.length ?? 0;
        const dayLabel =
          dayCount === 1 ? t("1 day") : t("{count} days", { count: dayCount });
        const metaParts = [dayLabel];
        if (distance !== null) metaParts.push(formatDistance(distance));
        metaParts.push(trip.status);
        return (
          <li key={trip.id}>
            <label
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition ${
                checked
                  ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
                  : "border-slate-800 bg-slate-950 hover:border-slate-700"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(trip.id)}
                className="accent-tarmoto-cyan"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">
                  {trip.name}
                </p>
                <p className="text-[11px] text-slate-500">
                  {metaParts.join(" · ")}
                </p>
              </div>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
function RidePickerList({
  rides,
  visibleRides,
  loading,
  error,
  hasAnyRides,
  selected,
  onToggle,
}: {
  rides: UserRide[];
  visibleRides: UserRide[];
  loading: boolean;
  error: boolean;
  hasAnyRides: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-slate-500">
        <Loader2
          size={16}
          className="animate-spin inline-block mr-2 align-[-3px]"
        />
        {t("Loading your rides\u2026")}
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-6 text-center text-sm text-amber-200"
      >
        {t(
          "Couldn't load your rides right now. Close this and try again in a moment. ",
        )}
      </div>
    );
  }
  if (rides.length === 0) {
    return hasAnyRides ? (
      <div className="py-8 text-center">
        <p className="text-sm text-slate-400 mb-1">
          {t("All your rides are already in this collection")}
        </p>
        <p className="text-xs text-slate-500">
          {t("Record another ride to add it here.")}
        </p>
      </div>
    ) : (
      <div className="py-8 text-center">
        <p className="text-sm text-slate-400 mb-1">
          {t("You don't have any rides yet")}
        </p>
        <p className="text-xs text-slate-500">
          {t("Record a ride from the mobile app and it will show up here.")}
        </p>
      </div>
    );
  }
  if (visibleRides.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {t("No rides match your search.")}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {visibleRides.map((ride) => {
        const checked = selected.has(ride.id);
        const displayName =
          ride.name ??
          `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
        return (
          <li key={ride.id}>
            <label
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition ${
                checked
                  ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
                  : "border-slate-800 bg-slate-950 hover:border-slate-700"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(ride.id)}
                className="accent-tarmoto-cyan"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">
                  {displayName}
                </p>
                <p className="text-[11px] text-slate-500">
                  {new Date(ride.started_at).toLocaleDateString()}
                  {ride.distance_km != null
                    ? ` · ${formatDistance(ride.distance_km)}`
                    : ""}
                  {" · "}
                  {ride.ride_type}
                </p>
              </div>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
// ─────────────────────────────────────────────────────────
// Route geometry helpers
// ─────────────────────────────────────────────────────────
function combineTripRoutePoints(days: readonly TripDay[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const day of days) {
    const coords = day.routeGeometry?.coordinates;
    if (!coords) continue;
    for (const [lng, lat] of coords) {
      if (typeof lng === "number" && typeof lat === "number") {
        out.push({ lat, lng });
      }
    }
  }
  return out;
}
