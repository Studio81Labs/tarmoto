"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import {
  Button,
  Card,
  MetricTile,
  Mono,
  QualityBars,
  SegmentedControl,
  Stamp,
} from "@tarmoto/ui";
import {
  ArrowLeft,
  Calendar,
  Check,
  GripVertical,
  Loader2,
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
import { type RoutePoint } from "@/lib/ride-detail";
import { formatDistance, formatRelativeTime } from "@/lib/utils";
import type { TripDay, TripSummary } from "@/lib/types";
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
  // Gate the detail fetch on AuthSync hydrating the access token —
  // without it the cold-load race 401s and the page never recovers.
  // Same pattern as the rides pages.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (!collectionId || !authReady) return;
    setLoad({ phase: "loading" });
    void reload(collectionId);
  }, [collectionId, authReady, reload]);
  const collection = load.phase === "ready" ? load.collection : null;
  // Per-item route geometry (simplified polylines) for the row thumbnails,
  // keyed by collection item id. Fetched from the owner-only preview endpoint
  // and refreshed whenever the item set changes (add/remove bumps the
  // collection's `updatedAt`). Reorder keeps the same items, so the map stays
  // valid across a drag without a refetch.
  const [previewsByItem, setPreviewsByItem] = useState<
    Map<string, number[][][]>
  >(new Map());
  const itemSetKey = collection
    ? `${collection.itemCount}:${collection.updatedAt}`
    : null;
  useEffect(() => {
    if (!collectionId || !authReady || itemSetKey === null) return;
    let cancelled = false;
    void routeCollectionsApi
      .getPreviewById(collectionId)
      .then(({ data }) => {
        if (cancelled) return;
        const next = new Map<string, number[][][]>();
        for (const route of data.routes) next.set(route.item_id, route.lines);
        setPreviewsByItem(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collectionId, authReady, itemSetKey]);
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
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <div className="flex items-center gap-2 text-fg-dim text-sm">
          <Loader2 size={16} className="animate-spin" />
          {t("Loading collection\u2026")}
        </div>
      </div>
    );
  }
  if (load.phase === "not-found") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <Link
          href="/community/collections"
          className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Collections")}
        </Link>
        <div className="rounded-2xl border border-line bg-cream p-10 text-center">
          <RouteIcon size={40} className="mx-auto text-fg-mute mb-3" />
          <p className="text-ink font-medium mb-1">
            {t("Collection not found")}
          </p>
          <p className="text-sm text-fg-dim">
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
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <Link
          href="/community/collections"
          className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
        >
          <ArrowLeft size={16} />
          {t("Collections")}
        </Link>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-10 text-center">
          <p className="text-amber-200 font-medium mb-1">
            {t("Couldn't load this collection")}
          </p>
          <p className="text-sm text-fg-dim mb-4">{load.message}</p>
          <Button
            variant="secondary"
            onClick={() => collectionId && void reload(collectionId)}
          >
            {t("Retry")}
          </Button>
        </div>
      </div>
    );
  }
  // ready
  const presentTrips = collection!.tripRefs
    .map((ref) => tripById.get(ref.tripId))
    .filter((trip): trip is TripSummary => trip != null);
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
  // `TripSummary[]` — the list endpoint only carries `num_days`.
  const totalDays = presentTrips.reduce((sum, trip) => sum + trip.num_days, 0);
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <Link
        href="/community/collections"
        className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-ink mb-4 transition"
      >
        <ArrowLeft size={16} />
        {t("Collections")}
      </Link>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="font-sans text-[32px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink break-words">
            {collection!.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-fg-dim">
            <RouteCollectionVisibilityPill
              visibility={collection!.visibility}
            />
            <span className="text-fg-mute">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-extrabold text-ink">
                {(user?.displayName ?? "Y").trim().charAt(0).toUpperCase()}
              </span>
              {t("You")}
            </span>
            <span className="text-fg-mute">·</span>
            <Mono className="text-[11px] text-fg-mute">
              {t("Updated")} {formatRelativeTime(collection!.updatedAt)}
            </Mono>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ShareButton collection={collection!} />
          <Button
            variant="primary"
            uppercase
            disabled={busy}
            leftIcon={<Plus size={14} />}
            onClick={() => setShowPicker(true)}
          >
            {t("Add routes")}
          </Button>
        </div>
      </header>

      <VisibilitySelector
        value={collection!.visibility}
        onChange={(v) => void handleVisibilityChange(v)}
        disabled={busy}
      />

      {collection!.description && (
        <p className="text-sm text-ink mt-3 max-w-2xl whitespace-pre-line">
          {collection!.description}
        </p>
      )}

      {actionError && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {actionError}
        </p>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <MetricTile
          variant="ink"
          accentNumber
          label={t("Routes")}
          value={collection!.itemCount}
          delta={
            // "Unavailable" rolls up trips + rides whose owning record was
            // deleted (or hidden from the local cache). Suppressed while either
            // fetch is in flight or errored so a transient outage doesn't look
            // like everything was deleted.
            totalMissing > 0 && !loadingMembers && !memberLoadError
              ? `${totalMissing} unavailable`
              : undefined
          }
        />
        <MetricTile
          label={t("Total distance")}
          value={
            loadingMembers || memberLoadError
              ? "—"
              : formatDistance(totalDistance)
          }
          delta={
            // List-endpoint trips don't carry per-day distances, so their
            // contribution is omitted from the aggregate rather than counted as
            // zero. Surface the omission so the total isn't silently lying.
            !loadingMembers && !memberLoadError && tripsWithUnknownDistance > 0
              ? `+${tripsWithUnknownDistance} trip${tripsWithUnknownDistance === 1 ? "" : "s"} not counted`
              : undefined
          }
        />
        <MetricTile
          label={t("Riding days")}
          value={loadingMembers || memberLoadError ? "—" : totalDays}
          delta={
            // Recorded rides contribute to the collection but don't roll up
            // into the multi-day "riding days" count — surface them separately.
            !loadingMembers && !memberLoadError && presentRides.length > 0
              ? `+${presentRides.length} ride${presentRides.length === 1 ? "" : "s"}`
              : undefined
          }
        />
        <MetricTile label={t("Followers")} value={collection!.followerCount} />
      </section>

      <Card padded={false} className="mt-[18px] overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-4">
          <div className="flex items-center gap-2.5">
            <RouteIcon size={18} className="text-accent" aria-hidden="true" />
            <div>
              <Stamp>{t("Routes")}</Stamp>
              <div className="mt-0.5 font-sans text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
                {collection!.itemCount === 1
                  ? t("1 route")
                  : t("{count} routes", { count: collection!.itemCount })}
              </div>
            </div>
          </div>
          {totalRefs > 0 && (
            <Button
              variant="secondary"
              size="sm"
              uppercase
              disabled={busy}
              leftIcon={<Plus size={14} />}
              onClick={() => setShowPicker(true)}
            >
              {t("Add routes")}
            </Button>
          )}
        </div>
        {totalRefs === 0 ? (
          <EmptyRoutes onAdd={() => setShowPicker(true)} />
        ) : loadingMembers || memberLoadError ? (
          <div className="p-[18px]">
            {memberLoadError && (
              <div
                role="alert"
                className="mb-3 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400"
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
          </div>
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
                          lines={previewsByItem.get(ref.itemId)}
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
                          lines={previewsByItem.get(ref.itemId)}
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
      </Card>

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
  const description =
    value === "private"
      ? t("Only you can see this collection.")
      : value === "unlisted"
        ? t("Anyone with the link can view it — not listed publicly.")
        : t("Listed publicly — other riders can follow it.");
  return (
    <Card
      padded={false}
      className="mb-4 flex flex-wrap items-center justify-between gap-4 px-[18px] py-3.5"
    >
      <div className="flex items-center gap-3.5">
        <Stamp>{t("Visibility")}</Stamp>
        <SegmentedControl
          ariaLabel={t("Visibility")}
          disabled={disabled}
          value={value}
          onChange={onChange}
          options={[
            { value: "private", label: "Private" },
            { value: "unlisted", label: "Unlisted" },
            { value: "public", label: "Public" },
          ]}
        />
      </div>
      <span className="text-[12px] text-fg-dim">{description}</span>
    </Card>
  );
}
function ShareButton({ collection }: { collection: RouteCollectionView }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timeoutId = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [state]);
  const sharable = collection.visibility !== "private";
  const url =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/community/collections/shared/${collection.slug}`;
  const handle = async () => {
    if (!sharable) return;
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      // Clipboard rejects on insecure origins / denied permission — surface a
      // visible "Copy failed" so the user knows sharing didn't take rather
      // than seeing the button do nothing.
      setState("failed");
    }
  };
  return (
    <Button
      variant="secondary"
      uppercase
      disabled={!sharable}
      leftIcon={state === "copied" ? <Check size={14} /> : <Share2 size={14} />}
      title={
        sharable
          ? state === "failed"
            ? t("Couldn't copy — copy the URL from your browser instead")
            : t("Copy share link")
          : t("Make this collection unlisted or public to share")
      }
      onClick={() => void handle()}
    >
      {state === "copied"
        ? t("Copied")
        : state === "failed"
          ? t("Copy failed")
          : t("Share")}
    </Button>
  );
}
// Map a single simplified polyline ([lng,lat][]) to an SVG path inside the
// 200×120 thumbnail box (north up). Mirrors `CollectionsDiscover.linePath`.
function thumbPath(line: number[][]): string {
  const xs = line.map((p) => p[0] ?? 0);
  const ys = line.map((p) => p[1] ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX || 1;
  const h = Math.max(...ys) - minY || 1;
  return (
    "M " +
    line
      .map(([lng, lat]) => {
        const x = (((lng ?? 0) - minX) / w) * 180 + 10;
        const y = (1 - ((lat ?? 0) - minY) / h) * 100 + 10;
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" L ")
  );
}

/** 58×40 route-preview thumbnail; falls back to a route glyph with no geometry. */
function RouteThumb({
  lines,
  label,
}: {
  lines: number[][][] | undefined;
  label: string;
}) {
  const line = lines?.find((l) => l && l.length >= 2);
  return (
    <div className="hidden h-10 w-[58px] shrink-0 overflow-hidden rounded-lg border border-line bg-paper sm:block">
      {line ? (
        <svg
          viewBox="0 0 200 120"
          preserveAspectRatio="xMidYMid slice"
          className="h-full w-full"
          role="img"
          aria-label={`${label} route preview`}
        >
          <path
            d={thumbPath(line)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center text-fg-mute">
          <RouteIcon size={16} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/** Status chip (planned / completed / shared / …) coloured like the design. */
function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "completed"
      ? "border-[#1f8a5b]/40 text-[#1f8a5b]"
      : s === "shared"
        ? "border-[#b06a38]/40 text-[#b06a38]"
        : s === "active"
          ? "border-accent/45 text-accent"
          : "border-line-strong text-ink";
  return (
    <span
      className={`hidden shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.2px] sm:inline-block ${tone}`}
    >
      {status}
    </span>
  );
}

function RemoveRouteButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line-strong text-fg-mute transition hover:border-quality-q1 hover:text-quality-q1"
    >
      <Trash2 size={16} />
    </button>
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
        <ul aria-label={ariaLabel} className={className}>
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
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 border-b border-line px-[18px] py-3 transition-colors last:border-b-0 hover:bg-paper/40"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={t("Reorder")}
        className={`shrink-0 rounded-md text-fg-mute transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 ${disabled ? "" : "cursor-grab active:cursor-grabbing"}`}
        style={{ touchAction: "none" }}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
function EmptyRoutes({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <RouteIcon size={40} className="mx-auto mb-3 text-fg-mute" />
      <p className="mb-1 font-bold text-ink">
        {t("No routes in this collection yet")}
      </p>
      <p className="mb-5 text-sm text-fg-dim">
        {t("Add routes from your planned or completed trips.")}
      </p>
      <Button
        variant="primary"
        size="sm"
        uppercase
        leftIcon={<Plus size={16} />}
        onClick={onAdd}
      >
        {t("Add routes")}
      </Button>
    </div>
  );
}
function TripRow({
  trip,
  lines,
  onRemove,
}: {
  trip: TripSummary;
  lines: number[][][] | undefined;
  onRemove: () => void;
}) {
  // List-endpoint trips (TripSummary) don't carry per-day distances, so the
  // distance is hidden when unknown — `null` rather than a confidently-wrong
  // `0 km`. Geometry comes from the collection preview endpoint via `lines`.
  const dayCount = trip.num_days;
  const distance = tripDistanceKmOrNull(trip);
  return (
    <div className="flex items-center gap-3">
      <Link
        href={`/trips/${trip.id}`}
        className="group flex min-w-0 flex-1 items-center gap-3"
      >
        <RouteThumb lines={lines} label={trip.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold text-ink transition group-hover:text-accent">
            {trip.name}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-dim">
            <span className="inline-flex items-center gap-1 text-fg-mute">
              <Calendar size={13} aria-hidden="true" />
              {dayCount}d
            </span>
            <span className="text-fg-mute">·</span>
            <span className="truncate">{t("You")}</span>
          </div>
        </div>
      </Link>
      {distance !== null && (
        <Mono className="shrink-0 text-[13px] font-bold text-ink">
          {formatDistance(distance)}
        </Mono>
      )}
      <StatusPill status={trip.status} />
      <RemoveRouteButton
        onClick={onRemove}
        label={`Remove ${trip.name} from collection`}
      />
    </div>
  );
}
function RideRow({
  ride,
  lines,
  onRemove,
}: {
  ride: UserRide;
  lines: number[][][] | undefined;
  onRemove: () => void;
}) {
  const displayName =
    ride.name ?? `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;
  return (
    <div className="flex items-center gap-3">
      <Link
        href={`/rides/${ride.id}`}
        className="group flex min-w-0 flex-1 items-center gap-3"
      >
        <RouteThumb lines={lines} label={displayName} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold text-ink transition group-hover:text-accent">
            {displayName}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-dim">
            <span className="inline-flex items-center gap-1 text-fg-mute">
              <Calendar size={13} aria-hidden="true" />
              {new Date(ride.started_at).toLocaleDateString()}
            </span>
            <span className="text-fg-mute">·</span>
            <span className="truncate">{t("You")}</span>
            {ride.avg_road_quality != null && (
              <>
                <span className="text-fg-mute">·</span>
                <QualityBars q={ride.avg_road_quality} size={5} />
              </>
            )}
          </div>
        </div>
      </Link>
      {ride.distance_km != null && (
        <Mono className="shrink-0 text-[13px] font-bold text-ink">
          {formatDistance(ride.distance_km)}
        </Mono>
      )}
      <StatusPill status="completed" />
      <RemoveRouteButton
        onClick={onRemove}
        label={`Remove ${displayName} from collection`}
      />
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
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-bold text-fg-dim">
          {t("{label} no longer available", { label })}
        </p>
        <p className="text-[11px] text-fg-mute">
          {t("The route may have been deleted or belongs to another account.")}
        </p>
      </div>
      <RemoveRouteButton onClick={onRemove} label={t("Remove")} />
    </div>
  );
}
function LoadingTripRow() {
  return (
    <li className="rounded-2xl border border-line bg-cream p-4 flex items-center gap-4 animate-pulse">
      <div className="hidden sm:block shrink-0 w-24 h-16 rounded-lg bg-paper" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-3.5 w-1/2 rounded bg-paper" />
        <div className="h-2.5 w-1/3 rounded bg-paper" />
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
  trips: TripSummary[];
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
    // `description` isn't on `TripSummaryDto` — search only matches
    // `name`, which is what the wire actually carries here.
    return trips.filter((trip) => trip.name.toLowerCase().includes(needle));
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-paper/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] rounded-2xl border border-line bg-cream p-5 shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink">{t("Add routes")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            className="p-1.5 rounded-lg text-fg-dim hover:text-ink hover:bg-paper transition"
          >
            <X size={14} />
          </button>
        </div>

        <div
          role="tablist"
          aria-label={t("Add routes from")}
          className="mb-3 inline-flex gap-1 rounded-[10px] border border-line bg-paper p-1"
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
          className="w-full px-3 py-2 rounded-lg bg-paper border border-line text-ink text-sm placeholder:text-fg-mute focus:outline-none focus:border-accent mb-3"
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
          <p className="text-[11px] text-fg-dim">
            {t("{count} selected", { count: totalSelected })}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              variant="accent"
              size="sm"
              uppercase
              disabled={totalSelected === 0}
              onClick={() =>
                onAdd({
                  tripIds: Array.from(selectedTrips),
                  rideIds: Array.from(selectedRides),
                })
              }
            >
              {t("Add")}
              {totalSelected > 0 ? ` (${totalSelected})` : ""}
            </Button>
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
      className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-bold transition-colors ${
        active
          ? "bg-ink text-cream"
          : "bg-transparent text-fg-dim hover:text-ink"
      }`}
    >
      <span>{label}</span>
      {count > 0 && (
        <Mono
          className={`text-[10px] ${active ? "text-cream/70" : "text-fg-mute"}`}
        >
          · {count}
        </Mono>
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
  trips: TripSummary[];
  visibleTrips: TripSummary[];
  loading: boolean;
  error: boolean;
  hasAnyTrips: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onPlanTrip: () => void;
}) {
  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-fg-dim">
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
        <p className="text-sm text-fg-dim mb-1">
          {t("All your trips are already in this collection")}
        </p>
        <p className="text-xs text-fg-dim">
          {t("Plan another trip to add it here.")}
        </p>
      </div>
    ) : (
      <div className="py-8 text-center">
        <p className="text-sm text-fg-dim mb-1">
          {t("You don't have any trips yet")}
        </p>
        <p className="text-xs text-fg-dim mb-4">
          {t("Plan a trip first and it will show up here.")}
        </p>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Plus size={14} />}
          onClick={onPlanTrip}
        >
          {t("New trip")}
        </Button>
      </div>
    );
  }
  if (visibleTrips.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-fg-dim">
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
        const dayCount = trip.num_days;
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
                  ? "border-accent/40 bg-accent/5"
                  : "border-line bg-paper hover:border-line-strong"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(trip.id)}
                className="accent-accent"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink truncate">
                  {trip.name}
                </p>
                <p className="text-[11px] text-fg-dim">
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
      <div className="py-10 text-center text-sm text-fg-dim">
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
        <p className="text-sm text-fg-dim mb-1">
          {t("All your rides are already in this collection")}
        </p>
        <p className="text-xs text-fg-dim">
          {t("Record another ride to add it here.")}
        </p>
      </div>
    ) : (
      <div className="py-8 text-center">
        <p className="text-sm text-fg-dim mb-1">
          {t("You don't have any rides yet")}
        </p>
        <p className="text-xs text-fg-dim">
          {t("Record a ride from the mobile app and it will show up here.")}
        </p>
      </div>
    );
  }
  if (visibleRides.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-fg-dim">
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
                  ? "border-accent/40 bg-accent/5"
                  : "border-line bg-paper hover:border-line-strong"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(ride.id)}
                className="accent-accent"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink truncate">
                  {displayName}
                </p>
                <p className="text-[11px] text-fg-dim">
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
