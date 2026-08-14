"use client";

import { useI18n, useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { notFound as renderNotFound, useParams } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Button,
  Card,
  CopyField,
  Input,
  MetricTile,
  Mono,
  QualityBars,
  SegmentedControl,
  SkeletonDashboard,
  SkeletonPageHeader,
  Stamp,
  Tooltip,
} from "@tarmoto/ui";
import {
  ArrowLeft,
  Calendar,
  Check,
  GripVertical,
  Loader2,
  Plus,
  Route as RouteIcon,
  Search,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  formatRelativeTimeLabel,
  normalizeForLocaleSearch,
} from "@tarmoto/shared";
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
import { useUserRides, type UserRide } from "@/hooks/useUserRides";
import {
  ApiError,
  routeCollectionsApi,
  type RouteCollectionVisibility,
} from "@/lib/api";
import {
  COLLECTION_VISIBILITY_LABELS,
  RouteCollectionVisibilityPill,
} from "@/components/RouteCollectionVisibilityPill";
import { UserAvatar } from "@/components/UserAvatar";
import {
  RouteThumb,
  StatusPill,
} from "@/components/community/collection-route-atoms";
import {
  mapDetailToView,
  moveItem,
  reorderPayload,
  type CollectionRideRef,
  type RouteCollectionView,
} from "@/lib/route-collections";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
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
  const t = useTranslation();
  const format = useFormat();
  const { collectionId } = useParams<{
    collectionId: string;
  }>();
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
  const reload = useCallback(
    async (id: string) => {
      try {
        const { data } = await routeCollectionsApi.get(id);
        setLoad({ phase: "ready", collection: mapDetailToView(data) });
      } catch (err) {
        // 400 = malformed id in the URL — same dead link as a missing
        // collection; both land on the 404 screen.
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 400)
        ) {
          setLoad({ phase: "not-found" });
          return;
        }
        setLoad({
          phase: "error",
          message: getUserFacingErrorMessage(
            err,
            t("Failed to load collection"),
          ),
        });
      }
    },
    [t],
  );
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
  const showLoader = useDelayedLoading(load.phase === "loading");
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
  const handleAddItems = async (input: { rideIds: string[] }) => {
    if (!collection) return;
    if (input.rideIds.length === 0) return;
    setActionError(null);
    setBusy(true);
    try {
      // Sequential adds: the backend assigns position via MAX(position)+1
      // inside a per-collection txn, so concurrent adds against the same
      // collection can collide on the same position value. Serialising here
      // keeps the resulting order deterministic so users see the rides appear
      // in the order they selected them.
      for (const rid of input.rideIds) {
        await routeCollectionsApi.addItem(collection.id, { ride_id: rid });
      }
      await reload(collection.id);
      setShowPicker(false);
    } catch (err) {
      setActionError(getUserFacingErrorMessage(err, t("Failed to add routes")));
    } finally {
      setBusy(false);
    }
  };
  const handleReorder = async (fromIndex: number, toIndex: number) => {
    if (!collection) return;
    if (fromIndex === toIndex) return;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= collection.rideRefs.length ||
      toIndex >= collection.rideRefs.length
    ) {
      return;
    }
    // Optimistic: rebuild the view with the new order so the row animates to
    // its new spot immediately. The server is the source of truth for
    // `position`; we only renumber locally on success (after the refetch from
    // `reorderItems`).
    const nextRefs: CollectionRideRef[] = moveItem(
      collection.rideRefs,
      fromIndex,
      toIndex,
    );
    const optimistic: RouteCollectionView = {
      ...collection,
      rideRefs: nextRefs,
      rideIds: nextRefs.map((r) => r.rideId),
    };
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
        getUserFacingErrorMessage(err, t("Failed to reorder routes")),
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
        getUserFacingErrorMessage(err, t("Failed to remove route")),
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
        getUserFacingErrorMessage(err, t("Failed to update visibility")),
      );
    } finally {
      setBusy(false);
    }
  };
  if (load.phase === "loading") {
    // Debounced skeleton: warm loads render a blank shell, never a flash.
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7">
        {showLoader && (
          <>
            <SkeletonPageHeader />
            <SkeletonDashboard label={t("Loading collection\u2026")} />
          </>
        )}
      </div>
    );
  }
  // Deleted / private collections render the app-level v2 404 screen.
  if (load.phase === "not-found") renderNotFound();
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
          <p className="text-amber-700 font-medium mb-1">
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
  const presentRides = collection!.rideRefs
    .map((ref) => rideById.get(ref.rideId))
    .filter((r): r is UserRide => r != null);
  // Recorded-ride distance comes straight from the backend `distance_km` field.
  const totalDistance = presentRides.reduce(
    (sum, r) => sum + (r.distance_km ?? 0),
    0,
  );
  const totalMissing = collection!.rideRefs.length - presentRides.length;
  const memberRideIds = new Set(collection!.rideIds);
  const availableRides = rides.filter((r) => !memberRideIds.has(r.id));
  const totalRefs = collection!.rideRefs.length;
  const loadingMembers = loadingRides;
  const memberLoadError = ridesError;
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
              label={t(COLLECTION_VISIBILITY_LABELS[collection!.visibility])}
            />
            <span className="text-fg-mute">·</span>
            <span className="inline-flex items-center gap-1.5">
              <UserAvatar
                name={user?.displayName ?? t("Rider")}
                size={20}
                fontSize={10}
                accent
              />
              {t("You")}
            </span>
            <span className="text-fg-mute">·</span>
            <Mono className="text-[11px] text-fg-mute">
              {t("Updated {time}", {
                time: formatRelativeTimeLabel(
                  collection!.updatedAt,
                  { format },
                  t,
                ),
              })}
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
        <p role="alert" className="mt-3 text-xs text-red-700">
          {actionError}
        </p>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        <MetricTile
          variant="ink"
          accentNumber
          label={t("Routes")}
          value={collection!.itemCount}
          formatValue={format.integer}
          delta={
            // "Unavailable" rolls up rides whose owning record was deleted (or
            // hidden from the local cache). Suppressed while the fetch is in
            // flight or errored so a transient outage doesn't look like
            // everything was deleted.
            totalMissing > 0 && !loadingMembers && !memberLoadError
              ? t(
                  "{count, plural, one {# unavailable route} other {# unavailable routes}}",
                  { count: totalMissing },
                )
              : undefined
          }
        />
        <MetricTile
          label={t("Total distance")}
          value={
            loadingMembers || memberLoadError
              ? "—"
              : format.distanceKm(totalDistance)
          }
        />
        <MetricTile
          label={t("Followers")}
          value={collection!.followerCount}
          formatValue={format.integer}
        />
      </section>

      <Card padded={false} className="mt-[18px] overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-4">
          <div className="flex items-center gap-2.5">
            <RouteIcon size={18} className="text-accent" aria-hidden="true" />
            <div>
              <Stamp>{t("Routes")}</Stamp>
              <div className="mt-0.5 font-sans text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
                {t("{count, plural, one {# route} other {# routes}}", {
                  count: collection!.itemCount,
                })}
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
                className="mb-3 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700"
              >
                {t(
                  "Couldn't load your routes right now. Try again in a moment.",
                )}
              </div>
            )}
            <ul className="space-y-3">
              {collection!.rideRefs.map((ref) => (
                <LoadingTripRow key={`ride-${ref.itemId}`} />
              ))}
            </ul>
          </div>
        ) : (
          <SortableItemList
            ariaLabel={t("Rides in this collection. Drag handle to reorder.")}
            ids={collection!.rideRefs.map((r) => r.itemId)}
            disabled={busy || collection!.rideRefs.length < 2}
            onReorder={(from, to) => void handleReorder(from, to)}
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
                      onRemove={() => void handleRemoveItem(ref.itemId)}
                    />
                  )}
                </SortableRow>
              );
            })}
          </SortableItemList>
        )}
      </Card>

      {showPicker && (
        <RoutePickerModal
          rides={availableRides}
          loadingRides={loadingRides}
          ridesError={ridesError}
          hasAnyRides={rides.length > 0}
          onClose={() => setShowPicker(false)}
          onAdd={(input) => void handleAddItems(input)}
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
  const t = useTranslation();
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
            { value: "private", label: t("Private") },
            { value: "unlisted", label: t("Unlisted") },
            { value: "public", label: t("Public") },
          ]}
        />
      </div>
      <span className="text-[12px] text-fg-dim">{description}</span>
    </Card>
  );
}
function ShareButton({ collection }: { collection: RouteCollectionView }) {
  const t = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [fallbackOpen, setFallbackOpen] = useState(false);
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
      // Clipboard rejects on insecure origins / denied permission. Surface a
      // visible "Copy failed" and fall back to an app dialog showing the
      // *share* URL (system prompts are disallowed) — the page URL is the
      // owner-only `/collections/:id` route, so telling the owner to copy
      // the browser address would hand recipients a 404.
      setState("failed");
      setFallbackOpen(true);
    }
  };
  return (
    <>
      <ConfirmDialog
        open={fallbackOpen}
        title={t("Copy this share link")}
        message={t(
          "Automatic copying was blocked — select and copy the link below.",
        )}
        confirmLabel={t("Done")}
        hideCancel
        onCancel={() => setFallbackOpen(false)}
        onConfirm={() => setFallbackOpen(false)}
      >
        <CopyField value={url} ariaLabel={t("Share link")} />
      </ConfirmDialog>
      <Tooltip
        content={
          sharable
            ? state === "failed"
              ? t("Couldn't copy automatically — link shown so you can copy it")
              : t("Copy share link")
            : t("Make this collection unlisted or public to share")
        }
      >
        <Button
          variant="secondary"
          uppercase
          disabled={!sharable}
          leftIcon={
            state === "copied" ? <Check size={14} /> : <Share2 size={14} />
          }
          onClick={() => void handle()}
        >
          {state === "copied"
            ? t("Copied")
            : state === "failed"
              ? t("Copy failed")
              : t("Share")}
        </Button>
      </Tooltip>
    </>
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
 * `SortableContext`. Each child carries an `id` matching one of the `ids`
 * prop entries; reordering emits the from/to indices into that list.
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
      {...(disabled ? {} : { onDragEnd: handleDragEnd })}
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
  const t = useTranslation();
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
  const t = useTranslation();
  return (
    <div className="px-6 py-12 text-center">
      <RouteIcon size={40} className="mx-auto mb-3 text-fg-mute" />
      <p className="mb-1 font-bold text-ink">
        {t("No routes in this collection yet")}
      </p>
      <p className="mb-5 text-sm text-fg-dim">
        {t("Add routes from your recorded rides.")}
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
/** Exported for regression coverage of the `road_quality_overlay` gate below.
 *  Next treats only specific named exports from a page module as special
 *  (`metadata`, `dynamic`, `generateStaticParams`, …), so this is inert to the
 *  router. The page is 1100+ lines with drag-and-drop and its own fetches; a
 *  full harness to reach one conditional would be worse than this. */
export function RideRow({
  ride,
  lines,
  onRemove,
}: {
  ride: UserRide;
  lines: number[][][] | undefined;
  onRemove: () => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  // Read the kill in the row that renders it — this is a client component with
  // no early return above, and gating here means no caller has to remember.
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const displayName =
    ride.name ?? t("Ride on {date}", { date: format.date(ride.started_at) });
  return (
    <div className="flex items-center gap-3">
      <Link
        href={`/rides/${ride.id}`}
        className="group flex min-w-0 flex-1 items-center gap-3"
      >
        <RouteThumb lines={lines} label={displayName} t={t} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold text-ink transition group-hover:text-accent">
            {displayName}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-dim">
            <span className="inline-flex items-center gap-1 text-fg-mute">
              <Calendar size={13} aria-hidden="true" />
              {format.date(ride.started_at)}
            </span>
            <span className="text-fg-mute">·</span>
            <span className="truncate">{t("You")}</span>
            {qualityEnabled && ride.avg_road_quality != null && (
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
          {format.distanceKm(ride.distance_km)}
        </Mono>
      )}
      <StatusPill status={ride.status} t={t} />
      <RemoveRouteButton
        onClick={onRemove}
        label={t("Remove {name} from collection", { name: displayName })}
      />
    </div>
  );
}
function MissingItemRow({ onRemove }: { onRemove: () => void }) {
  const t = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-bold text-fg-dim">
          {t("Ride no longer available")}
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
// Route picker modal — add recorded rides to the collection.
// ─────────────────────────────────────────────────────────
function RoutePickerModal({
  rides,
  loadingRides,
  ridesError,
  hasAnyRides,
  onClose,
  onAdd,
}: {
  rides: UserRide[];
  loadingRides: boolean;
  ridesError: boolean;
  hasAnyRides: boolean;
  onClose: () => void;
  onAdd: (input: { rideIds: string[] }) => void;
}) {
  const { t } = useI18n();
  const format = useFormat();
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
  const visibleRides = useMemo(() => {
    const needle = normalizeForLocaleSearch(search, format.locale);
    if (!needle) return rides;
    return rides.filter((r) => {
      const fallbackName = t("Ride on {date}", {
        date: format.date(r.started_at),
      });
      const haystack = normalizeForLocaleSearch(
        `${r.name ?? fallbackName} ${r.ride_type}`,
        format.locale,
      );
      return haystack.includes(needle);
    });
  }, [rides, search, format, t]);
  const toggle = (id: string) => {
    setSelectedRides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const totalSelected = selectedRides.size;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-paper/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-cream shadow-[0_32px_80px_rgba(14,14,16,0.3)]"
      >
        <div className="flex items-start justify-between px-[22px] pt-5">
          <div>
            <Stamp>{t("Collection")}</Stamp>
            <h2 className="mt-1 font-sans text-[22px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
              {t("Add routes")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-fg-mute transition hover:bg-paper hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-[22px] pb-3.5 pt-4">
          <Input
            value={search}
            onChange={setSearch}
            ariaLabel={t("Search your rides")}
            placeholder={t("Search your rides…")}
            tone="cream"
            leadingIcon={<Search size={14} />}
          />
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto px-[22px]">
          <RidePickerList
            rides={rides}
            visibleRides={visibleRides}
            loading={loadingRides}
            error={ridesError}
            hasAnyRides={hasAnyRides}
            selected={selectedRides}
            onToggle={toggle}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-[22px] py-3.5">
          <Mono className="text-[12px] font-bold text-fg-mute">
            {t("{count} selected", { count: totalSelected })}
          </Mono>
          <div className="flex gap-2">
            <Button variant="secondary" uppercase onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              uppercase
              disabled={totalSelected === 0}
              leftIcon={<Plus size={14} />}
              onClick={() => onAdd({ rideIds: Array.from(selectedRides) })}
            >
              {t("Add")}
              {totalSelected > 0 ? ` ${format.integer(totalSelected)}` : ""}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
/**
 * One selectable row in the add-routes picker: custom checkbox, a route-glyph
 * thumbnail (the picker lists every owned ride and has no per-item geometry,
 * so the thumb is a placeholder rather than a real preview), the name, a mono
 * meta line, and a status pill.
 */
function PickerRow({
  checked,
  onToggle,
  name,
  meta,
  status,
}: {
  checked: boolean;
  onToggle: () => void;
  name: string;
  meta: string;
  status: string;
}) {
  const t = useTranslation();
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-3 rounded-[11px] border px-3 py-2.5 transition ${
          checked
            ? "border-accent bg-accent/5"
            : "border-line bg-cream hover:border-line-strong"
        }`}
      >
        {/* eslint-disable-next-line no-restricted-syntax -- sr-only checkbox
            inside a rich ride-picker row (thumbnail + stats); the ui Checkbox
            can't host the card layout, semantics stay native. */}
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="peer sr-only"
        />
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 ${
            checked
              ? "border-accent bg-accent text-ink"
              : "border-line-strong text-transparent"
          }`}
        >
          <Check size={13} strokeWidth={3} aria-hidden="true" />
        </span>
        <span className="flex h-9 w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[7px] border border-line bg-paper text-fg-mute">
          <RouteIcon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-bold text-ink">
            {name}
          </span>
          <Mono className="mt-0.5 block text-[10.5px] uppercase text-fg-mute">
            {meta}
          </Mono>
        </span>
        <StatusPill status={status} t={t} />
      </label>
    </li>
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
  const t = useTranslation();
  const format = useFormat();
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
        className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-6 text-center text-sm text-amber-700"
      >
        {t(
          "Couldn't load your rides right now. Close this and try again in a moment.",
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
    <ul className="flex flex-col gap-2 pb-1">
      {visibleRides.map((ride) => {
        const displayName =
          ride.name ??
          t("Ride on {date}", { date: format.date(ride.started_at) });
        const date = format.date(ride.started_at);
        const meta =
          ride.distance_km != null
            ? `${date} · ${format.distanceKm(ride.distance_km)}`
            : date;
        return (
          <PickerRow
            key={ride.id}
            checked={selected.has(ride.id)}
            onToggle={() => onToggle(ride.id)}
            name={displayName}
            meta={meta}
            status={ride.status}
          />
        );
      })}
    </ul>
  );
}
