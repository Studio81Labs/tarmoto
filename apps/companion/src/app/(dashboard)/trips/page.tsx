"use client";

import { useI18n, useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  FileUp,
  Plus,
  Route,
  MapPin,
  Search,
  Folder,
  MoreVertical,
  Copy,
  Trash2,
  FolderInput,
  Pencil,
  Inbox,
  X,
  AlertTriangle,
} from "lucide-react";
import { tripsApi, tripFoldersApi } from "@/lib/api";
import {
  tripFromDetail,
  tripSummaryFromWire,
  type TripDetailResponse,
  type TripSummaryWire,
} from "@/lib/trip-from-detail";
import { useQueryClient } from "@tanstack/react-query";
import { useTripStore } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import { USER_TRIPS_QUERY_KEY } from "@/hooks/useUserTrips";
import { useEntitlements, useLimit } from "@/hooks";
import {
  DEFAULT_TRIP_FILTERS,
  TRIP_STATUSES,
  TRIP_SORT_KEYS,
  applyTripFilters,
  countByStatus,
  countOpenOwnedTrips,
  tripDistanceKmOrNull,
  type FolderScope,
  type TripFilters,
  type TripSortKey,
  type TripStatus,
} from "@/lib/trip-filters";
import { parseFeatureLimitError, tierLabel } from "@/lib/entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { formatRelativeTimeLabel } from "@tarmoto/shared";
import {
  migrateLegacyFolders,
  sortFoldersForDisplay,
  validateFolderName,
  type TripFolder,
} from "@/lib/trip-folders";
import { useFormat } from "@/format/FormatProvider";
import type { TripSummary } from "@/lib/types";
import {
  Button,
  FieldLabel,
  Input,
  MiniRouteSvg,
  PageHeader,
  Select,
  SkeletonGrid,
} from "@tarmoto/ui";
import { RouteOutlineSvg } from "@/components/trips/RouteOutlineSvg";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  TRIP_SORT_LABELS,
  TRIP_STATUS_FILTER_LABELS,
  TRIP_STATUS_LABELS,
} from "@/i18n/domainLabels";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
// Spec card status badge palette (v2-pages.jsx · trip cards). Each
// badge sits absolute over the MiniRouteSvg image area; all share
// padding/font/letter-spacing, only the surface + border vary:
// - planned   → solid ink with cream text (high-contrast "scheduled")
// - active    → solid accent (currently riding)
// - draft     → paper-2 surface with hairline border
// - completed → cream surface with hairline border
const STATUS_PILL: Record<TripStatus, string> = {
  draft: "bg-paper-2 text-ink border border-line-strong",
  planned: "bg-ink text-cream",
  active: "bg-accent text-ink",
  completed: "bg-cream text-ink border border-line-strong",
};
export default function TripListPage() {
  const { t } = useI18n();
  const format = useFormat();
  const searchLocale = format.locale;
  // Folder requests are scoped to the signed-in user, not to display
  // preferences. Keep the latest locale available to async completions so a
  // create/rename/rollback cannot restore the collation captured before a
  // locale switch. The translator ref serves the one-shot migration effect.
  const folderLocaleRef = useRef(searchLocale);
  const folderMigrationTranslatorRef = useRef(t);
  useEffect(() => {
    folderLocaleRef.current = searchLocale;
    folderMigrationTranslatorRef.current = t;
  }, [searchLocale, t]);
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const queryClient = useQueryClient();
  // max_active_trips gate (numeric-limits entitlement, #1032/#1036): ships
  // dark under a seeded-unlimited limit, so `atTripLimit` is inert until an
  // admin sets a finite limit. `null` means unlimited — never treat it as 0.
  const { tier } = useEntitlements();
  const { limit: maxActiveTrips, isSuccess: capResolved } =
    useLimit("max_active_trips");
  const openTripCount = countOpenOwnedTrips(trips, userId);
  const atTripLimit =
    maxActiveTrips !== null && openTripCount >= maxActiveTrips;
  // After any optimistic mutation that touches the persisted list,
  // drop the React Query cache for `useUserTrips`. `removeQueries`
  // (not `invalidateQueries`) — invalidation leaves the stale data
  // available until the refetch lands, which would let the hook's
  // write-through copy the pre-mutation snapshot back over the
  // freshly-mutated store. Removing forces the next mount to fetch
  // fresh, so the store and the cache can't diverge.
  const invalidateTripsCache = () =>
    queryClient.removeQueries({
      queryKey: USER_TRIPS_QUERY_KEY(userId),
    });
  const [loading, setLoading] = useState(true);
  // True when the trip list fetch failed — the count is unknown, not "zero".
  const [tripsLoadError, setTripsLoadError] = useState(false);
  // Block mint entry points unless we can prove the rider is under a FINITE
  // cap. `capResolved` is the entitlement query having actually SUCCEEDED — NOT
  // merely "not loading and not errored": before AuthSync hydrates the store,
  // `userId` is null, the /users/me query is disabled, and it reports
  // isLoading:false/isError:false while producing no snapshot. Failing closed on
  // `isSuccess` covers that auth-hydration window plus loading and error alike.
  // The open-trip COUNT only matters for a finite cap, so only then does an
  // unknown count (list loading/error) fail closed — an unlimited (null) cap
  // never gates on the count, so a /trips outage mustn't disable minting for
  // unlimited riders.
  const countUnknown = loading || tripsLoadError;
  const mintBlocked =
    !capResolved || (maxActiveTrips !== null && (atTripLimit || countUnknown));
  // Separate from `mintBlocked`, which also gates "New trip": an operator kill on
  // `gpx_import` must stop imports without stopping trip creation. Without this
  // the link stays active, navigates to `?import=1`, and the dialog silently
  // refuses to open — a dead click with no explanation.
  const { enabled: gpxImportEnabled } = useFeatureKillSwitch("gpx_import");
  const [folders, setFolders] = useState<TripFolder[]>([]);
  useEffect(() => {
    setFolders((current) => sortFoldersForDisplay(current, searchLocale));
  }, [searchLocale]);
  const [filters, setFilters] = useState<TripFilters>(() => ({
    ...DEFAULT_TRIP_FILTERS,
    statuses: new Set(DEFAULT_TRIP_FILTERS.statuses),
    folderScope: { ...DEFAULT_TRIP_FILTERS.folderScope },
  }));
  const [folderModal, setFolderModal] = useState<
    | {
        mode: "create";
      }
    | {
        mode: "rename";
        folder: TripFolder;
      }
    | null
  >(null);
  const [busyTripIds, setBusyTripIds] = useState<Set<string>>(() => new Set());
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // Safety net for the duplicate-mint 403: the proactive `atTripLimit` block
  // above covers the common case, but a stale client-side count (another tab
  // minted a trip, or the count just hasn't refetched yet) can still let the
  // request through — the backend is the actual source of truth.
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  // The cap the server actually enforced on the mint 403 — authoritative for
  // the modal's CTA even when the cached `maxActiveTrips` is stale.
  const [upgradeModalLimit, setUpgradeModalLimit] = useState<number | null>(
    null,
  );
  // Deletes confirm through the app dialog — system dialogs are disallowed.
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "folder"; folder: TripFolder }
    | { kind: "trip"; trip: TripSummary }
    | null
  >(null);
  const markBusy = (id: string) => {
    setBusyTripIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const clearBusy = (id: string) => {
    setBusyTripIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  useEffect(() => {
    // Clear trips every time userId changes (sign-out, sign-in, account
    // switch). Without this the new user would briefly see the previous
    // user's trips between the userId change and the fetch completing.
    let cancelled = false;
    setTrips([]);
    setErrorBanner(null);
    setTripsLoadError(false);
    if (!userId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    tripsApi
      .list()
      .then(({ data }) => {
        if (cancelled) return;
        // Wire rows arrive as `TripSummaryDto` (`title`, `created_at`).
        // Adapt to the companion's `TripSummary` (`name`, `createdAt`)
        // so cards / sorts read populated fields.
        const body = data as { data?: TripSummaryWire[] } | TripSummaryWire[];
        const rows = Array.isArray(body) ? body : (body?.data ?? []);
        setTrips(rows.map(tripSummaryFromWire));
      })
      .catch(() => {
        if (cancelled) return;
        setTrips([]);
        setTripsLoadError(true);
        setErrorBanner(t("Couldn't load your trips. Check your connection."));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, setTrips, userId]);
  useEffect(() => {
    // On any userId change (sign-out, sign-in, or direct account switch)
    // drop the previous user's folder scope so it doesn't point at a folder
    // the new user doesn't have. Scope is client-only state; the server-side
    // folder_id is per-trip and handled by the fetch effect above.
    setFilters((prev) =>
      prev.folderScope.kind === "folder"
        ? { ...prev, folderScope: { kind: "all" } }
        : prev,
    );
    if (!userId) {
      // Sign-out: also drop the previous user's folders.
      setFolders([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await tripFoldersApi.list();
        if (cancelled) return;
        const initial = sortFoldersForDisplay(
          data?.items ?? [],
          folderLocaleRef.current,
        );
        setFolders(initial);
        // First-load migration: lift any pre-existing localStorage rows
        // to the backend exactly once. We use the freshly fetched list
        // as the dedup source so re-running after a partial failure
        // doesn't duplicate names.
        const result = await migrateLegacyFolders(
          userId,
          initial,
          folderLocaleRef.current,
        );
        if (cancelled) return;
        if (result && result.succeeded > 0) {
          // Re-fetch after migration so the newly-posted folders show up
          // in their server-allocated position order.
          const refreshed = await tripFoldersApi.list();
          if (cancelled) return;
          setFolders(
            sortFoldersForDisplay(
              refreshed.data?.items ?? [],
              folderLocaleRef.current,
            ),
          );
          toast.success(
            folderMigrationTranslatorRef.current(
              "{count, plural, one {Moved # folder} other {Moved # folders}} to your Tarmoto account.",
              { count: result.succeeded },
            ),
          );
        }
      } catch {
        if (cancelled) return;
        setErrorBanner(
          folderMigrationTranslatorRef.current(
            "Couldn't load your folders. Try refreshing the page.",
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);
  const visibleTrips = useMemo(
    () => applyTripFilters(trips, filters, searchLocale),
    [trips, filters, searchLocale],
  );
  const statusCounts = useMemo(() => countByStatus(trips), [trips]);
  const unfiledCount = useMemo(
    () => trips.filter((storedTrip) => !storedTrip.folder_id).length,
    [trips],
  );
  const tripsPerFolder = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trips) {
      if (!t.folder_id) continue;
      map.set(t.folder_id, (map.get(t.folder_id) ?? 0) + 1);
    }
    return map;
  }, [trips]);
  // When a folder is deleted, the backend's FK on `trips.folder_id` is
  // `ON DELETE SET NULL`, so child trips become unfiled atomically with
  // the folder delete. We mirror that locally and don't issue a separate
  // PATCH per trip — that would be redundant work and would race the
  // cascade.
  const handleDeleteFolder = async (folder: TripFolder) => {
    const previousFolders = folders;
    // Snapshot the affected trip ids — not the entire trips array — so
    // a concurrent duplicate / delete / move running during the await
    // doesn't get clobbered by a stale full-array rollback. We re-
    // assign `folder_id = folder.id` only on the rows we actually
    // mutated below, leaving every other concurrent edit intact.
    const affectedTripIds = useTripStore
      .getState()
      .trips.filter((storedTrip) => storedTrip.folder_id === folder.id)
      .map((storedTrip) => storedTrip.id);
    // Snapshot the folder scope too: if the rider was viewing the
    // folder being deleted, we optimistically reset to "all" below so
    // they don't end up looking at a filter that points at a folder
    // that just disappeared. On rollback we have to restore that
    // selection — otherwise the folder reappears in the sidebar but
    // the trip list keeps showing every folder until the rider
    // re-clicks the folder manually.
    const previousFolderScope = filters.folderScope;
    setFolders(folders.filter((f) => f.id !== folder.id));
    const scopePointedAtDeleted =
      filters.folderScope.kind === "folder" &&
      filters.folderScope.id === folder.id;
    if (scopePointedAtDeleted) {
      setFilters({ ...filters, folderScope: { kind: "all" } });
    }
    setTrips(
      useTripStore
        .getState()
        .trips.map((storedTrip) =>
          storedTrip.folder_id === folder.id
            ? { ...storedTrip, folder_id: null }
            : storedTrip,
        ),
    );
    try {
      await tripFoldersApi.delete(folder.id);
      // The cascade on `trips.folder_id` runs server-side, so the
      // next `/api/v1/trips` fetch will return the affected trips
      // with `folder_id: null`. Invalidate the cache so a hook
      // consumer remounting within `staleTime` doesn't write the
      // pre-delete `folder_id` values back into the Zustand store.
      void invalidateTripsCache();
    } catch {
      // Roll back the folder list, the per-trip optimistic unfile, AND
      // the folder-scope filter so the rider isn't left looking at a
      // folder that reappeared in the sidebar but whose trips show as
      // unfiled / whose scope is still "all" — those would only
      // correct themselves on a full reload.
      setFolders(
        sortFoldersForDisplay(previousFolders, folderLocaleRef.current),
      );
      const affectedSet = new Set(affectedTripIds);
      setTrips(
        useTripStore
          .getState()
          .trips.map((storedTrip) =>
            affectedSet.has(storedTrip.id)
              ? { ...storedTrip, folder_id: folder.id }
              : storedTrip,
          ),
      );
      // Use the functional setter so we restore the saved scope on top
      // of any unrelated filter change (status toggle, search input)
      // that landed during the await.
      if (scopePointedAtDeleted) {
        setFilters((prev) => ({ ...prev, folderScope: previousFolderScope }));
      }
      setErrorBanner(t("Couldn't delete the folder. Try again."));
    }
  };
  const moveTripToFolder = async (
    trip: TripSummary,
    folderId: string | null,
  ) => {
    const previousFolderId = trip.folder_id ?? null;
    // Read fresh state so concurrent optimistic updates don't clobber each
    // other when two actions fire in the same render.
    setTrips(
      useTripStore
        .getState()
        .trips.map((storedTrip) =>
          storedTrip.id === trip.id
            ? { ...storedTrip, folder_id: folderId }
            : storedTrip,
        ),
    );
    markBusy(trip.id);
    try {
      await tripsApi.update(trip.id, { folder_id: folderId });
      void invalidateTripsCache();
    } catch {
      // Targeted rollback: touch only this trip so concurrent duplicates or
      // deletes made during the await aren't clobbered by a stale snapshot.
      setTrips(
        useTripStore
          .getState()
          .trips.map((storedTrip) =>
            storedTrip.id === trip.id
              ? { ...storedTrip, folder_id: previousFolderId }
              : storedTrip,
          ),
      );
      setErrorBanner(t("Couldn't move the trip. Try again."));
    } finally {
      clearBusy(trip.id);
    }
  };
  const duplicateTrip = async (trip: TripSummary) => {
    markBusy(trip.id);
    try {
      const { data } = await tripsApi.duplicate(trip.id);
      // Server may wrap the response in `{ data: ... }`. Either way we
      // get back a TripDetailDto (snake_case `title` / `created_at`,
      // members[] in place of collaborators) and must adapt it through
      // `tripFromDetail` before pushing into the list — without the
      // adapter `trip.name` is undefined and the new card renders with
      // an empty title.
      const body = data as unknown as
        | { data?: TripDetailResponse }
        | TripDetailResponse
        | null;
      const detail =
        body && typeof body === "object" && "data" in body && body.data
          ? body.data
          : (body as TripDetailResponse | null);
      if (detail && detail.id) {
        const created = tripFromDetail(detail);
        // Read the fresh trip list from the store — concurrent deletes
        // or moves made during the await shouldn't be silently reverted.
        setTrips([created, ...useTripStore.getState().trips]);
      }
      void invalidateTripsCache();
    } catch (err) {
      const limitError = parseFeatureLimitError(err);
      if (limitError && tier) {
        setUpgradeModalLimit(limitError.limit);
        setUpgradeModalOpen(true);
      } else {
        setErrorBanner(t("Couldn't duplicate the trip. Try again."));
      }
    } finally {
      clearBusy(trip.id);
    }
  };
  const deleteTrip = async (trip: TripSummary) => {
    // Read fresh state so concurrent optimistic updates don't clobber each
    // other when two actions fire in the same render.
    const before = useTripStore.getState().trips;
    const indexBefore = before.findIndex(
      (storedTrip) => storedTrip.id === trip.id,
    );
    setTrips(before.filter((storedTrip) => storedTrip.id !== trip.id));
    markBusy(trip.id);
    try {
      await tripsApi.delete(trip.id);
      void invalidateTripsCache();
    } catch {
      // Targeted rollback: splice the deleted trip back into the fresh list
      // so concurrent adds/moves aren't clobbered.
      const current = useTripStore.getState().trips;
      const restored = current.slice();
      const insertAt = Math.min(Math.max(indexBefore, 0), restored.length);
      restored.splice(insertAt, 0, trip);
      setTrips(restored);
      setErrorBanner(t("Couldn't delete the trip. Try again."));
    } finally {
      clearBusy(trip.id);
    }
  };
  const submitFolderModal = async (name: string) => {
    if (!folderModal) return;
    setFolderModal(null);
    if (folderModal.mode === "create") {
      // Optimistic: prepend a placeholder while the POST resolves so
      // the UI feels instant. The placeholder uses a synthetic id /
      // a position one past the current max — both get replaced when
      // the server response lands.
      const tempId = `tmp_${Date.now()}`;
      const optimistic: TripFolder = {
        id: tempId,
        user_id: userId ?? "",
        name: name.trim(),
        color: null,
        position: folders.length,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setFolders(sortFoldersForDisplay([...folders, optimistic], searchLocale));
      try {
        const { data } = await tripFoldersApi.create({ name: name.trim() });
        setFolders((prev) =>
          sortFoldersForDisplay(
            prev.map((f) => (f.id === tempId && data ? data : f)),
            folderLocaleRef.current,
          ),
        );
      } catch {
        setFolders((prev) => prev.filter((f) => f.id !== tempId));
        setErrorBanner(t("Couldn't create the folder. Try again."));
      }
    } else {
      const target = folderModal.folder;
      const previous = folders;
      setFolders(
        sortFoldersForDisplay(
          folders.map((f) =>
            f.id === target.id ? { ...f, name: name.trim() } : f,
          ),
          searchLocale,
        ),
      );
      try {
        const { data } = await tripFoldersApi.update(target.id, {
          name: name.trim(),
        });
        if (data) {
          setFolders((prev) =>
            sortFoldersForDisplay(
              prev.map((f) => (f.id === target.id ? data : f)),
              folderLocaleRef.current,
            ),
          );
        }
      } catch {
        setFolders(sortFoldersForDisplay(previous, folderLocaleRef.current));
        setErrorBanner(t("Couldn't rename the folder. Try again."));
      }
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <PageHeader
          stamp={t("Trips")}
          icon={<Route size={18} strokeWidth={2} />}
          title={t("My Trips")}
          sub={t(
            "Plan multi-day routes, organise them into folders, and ride them from the mobile app.",
          )}
          right={
            <div className="flex items-center gap-2">
              {mintBlocked ? (
                <>
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-paper px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink opacity-50"
                  >
                    <FileUp size={14} />
                    {t("Import GPX")}
                  </button>
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink opacity-50"
                  >
                    <Plus size={14} />
                    {t("New trip")}
                  </button>
                </>
              ) : (
                <>
                  {gpxImportEnabled ? (
                    <Link
                      href="/trips/planner?import=1"
                      className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-paper px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper-2"
                    >
                      <FileUp size={14} />
                      {t("Import GPX")}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-paper px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink opacity-50"
                    >
                      <FileUp size={14} />
                      {t("Import GPX")}
                    </button>
                  )}
                  <Link
                    href="/trips/planner"
                    className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
                  >
                    <Plus size={14} />
                    {t("New trip")}
                  </Link>
                </>
              )}
            </div>
          }
        />

        {atTripLimit && tier && maxActiveTrips !== null ? (
          <div className="mb-4">
            <UpgradePrompt
              variant="inline"
              capability={{
                limit: "max_active_trips",
                resolvedLimit: maxActiveTrips,
              }}
              currentTier={tier}
              message={t(
                "{max, plural, one {{used} of # trip used on the {tier} plan.} other {{used} of # trips used on the {tier} plan.}}",
                {
                  used: openTripCount,
                  max: maxActiveTrips,
                  tier: t(tierLabel(tier)),
                },
              )}
            />
          </div>
        ) : null}

        {errorBanner && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-700">
            <span>{errorBanner}</span>
            <button
              type="button"
              aria-label={t("Dismiss error")}
              onClick={() => setErrorBanner(null)}
              className="text-red-700 hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <FolderChipRow
          folders={folders}
          scope={filters.folderScope}
          unfiledCount={unfiledCount}
          totalCount={trips.length}
          tripsPerFolder={tripsPerFolder}
          onSelect={(next) => setFilters({ ...filters, folderScope: next })}
          onNew={() => setFolderModal({ mode: "create" })}
          onRename={(folder) => setFolderModal({ mode: "rename", folder })}
          onDelete={(folder) => setConfirmDelete({ kind: "folder", folder })}
        />

        <TripToolbar
          filters={filters}
          statusCounts={statusCounts}
          onChange={setFilters}
        />

        {loading ? (
          <SkeletonGrid
            cards={3}
            label={t("Loading trips…")}
            className="md:grid-cols-2"
          />
        ) : trips.length === 0 ? (
          <EmptyState
            title={t("No trips yet")}
            body={t(
              "Plan your first ride with the trip planner. Pick a region, tune the curves and asphalt, push it to your phone.",
            )}
            {...(mintBlocked
              ? {}
              : {
                  action: {
                    label: t("Create trip"),
                    href: "/trips/planner",
                  },
                })}
          />
        ) : visibleTrips.length === 0 ? (
          <EmptyState
            title={t("No trips match your filters")}
            body={t("Try clearing the search or selecting a different folder.")}
            action={{
              label: t("Clear filters"),
              onClick: () =>
                setFilters({
                  ...DEFAULT_TRIP_FILTERS,
                  statuses: new Set(DEFAULT_TRIP_FILTERS.statuses),
                  folderScope: { ...DEFAULT_TRIP_FILTERS.folderScope },
                }),
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 lg:grid-cols-3">
            {visibleTrips.map((trip) => (
              <TripCard
                key={trip.id}
                trip={trip}
                folders={folders}
                busy={busyTripIds.has(trip.id)}
                onDuplicate={() => duplicateTrip(trip)}
                onDelete={() => setConfirmDelete({ kind: "trip", trip })}
                onMove={(folderId) => moveTripToFolder(trip, folderId)}
              />
            ))}
          </div>
        )}
      </div>

      {folderModal && (
        <FolderModal
          mode={folderModal.mode}
          initialName={
            folderModal.mode === "rename" ? folderModal.folder.name : ""
          }
          folders={folders}
          excludeId={
            folderModal.mode === "rename" ? folderModal.folder.id : undefined
          }
          onClose={() => setFolderModal(null)}
          onSubmit={submitFolderModal}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={
          confirmDelete?.kind === "folder"
            ? t("Delete this folder?")
            : t("Delete this trip?")
        }
        message={
          confirmDelete?.kind === "folder"
            ? t('"{name}" is deleted; trips inside become unfiled.', {
                name: confirmDelete.folder.name,
              })
            : confirmDelete
              ? t('"{name}" is deleted for good. This cannot be undone.', {
                  name: confirmDelete.trip.name,
                })
              : ""
        }
        tone="danger"
        confirmLabel={
          confirmDelete?.kind === "folder"
            ? t("Delete folder")
            : t("Delete trip")
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const pending = confirmDelete;
          setConfirmDelete(null);
          if (!pending) return;
          if (pending.kind === "folder")
            void handleDeleteFolder(pending.folder);
          else void deleteTrip(pending.trip);
        }}
      />

      {upgradeModalOpen && tier ? (
        <UpgradePrompt
          variant="modal"
          capability={{
            limit: "max_active_trips",
            resolvedLimit: upgradeModalLimit,
          }}
          currentTier={tier}
          message={t("You've reached your trip limit on the {tier} plan.", {
            tier: t(tierLabel(tier)),
          })}
          onClose={() => setUpgradeModalOpen(false)}
        />
      ) : null}
    </div>
  );
}
// ─────────────────────────────────────────────────────────
// Folder chip row (replaces the legacy desktop sidebar + mobile drawer)
// ─────────────────────────────────────────────────────────
interface FolderChipRowProps {
  folders: TripFolder[];
  scope: FolderScope;
  unfiledCount: number;
  totalCount: number;
  tripsPerFolder: Map<string, number>;
  onSelect: (scope: FolderScope) => void;
  onNew: () => void;
  onRename: (folder: TripFolder) => void;
  onDelete: (folder: TripFolder) => void;
}
function FolderChipRow({
  folders,
  scope,
  unfiledCount,
  totalCount,
  tripsPerFolder,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: FolderChipRowProps) {
  const t = useTranslation();
  // Spec uses pill-shaped folder filters above the toolbar: `All trips`
  // first, then user folders (rename / delete via the kebab), then
  // `Unfiled` and a dashed `+ New folder` affordance. Chips wrap to a
  // second line on narrow viewports rather than scrolling
  // horizontally — an `overflow-x-auto` ancestor would clip the per-
  // chip rename/delete dropdown.
  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-2">
      <FolderChip
        icon={<Folder size={16} />}
        label={t("All trips")}
        count={totalCount}
        active={scope.kind === "all"}
        onSelect={() => onSelect({ kind: "all" })}
      />
      {folders.map((folder) => (
        <FolderChip
          key={folder.id}
          icon={<Folder size={16} />}
          label={folder.name}
          count={tripsPerFolder.get(folder.id) ?? 0}
          active={scope.kind === "folder" && scope.id === folder.id}
          onSelect={() => onSelect({ kind: "folder", id: folder.id })}
          onRename={() => onRename(folder)}
          onDelete={() => onDelete(folder)}
        />
      ))}
      <FolderChip
        icon={<Inbox size={16} />}
        label={t("Unfiled")}
        count={unfiledCount}
        active={scope.kind === "unfiled"}
        onSelect={() => onSelect({ kind: "unfiled" })}
      />
      <button
        type="button"
        onClick={onNew}
        className="inline-flex items-center gap-2 rounded-full border border-dashed border-line-strong px-[14px] py-2 text-[12px] font-bold text-fg-dim transition hover:border-ink hover:text-ink"
        aria-label={t("New folder")}
        title={t("New folder")}
      >
        <Plus size={14} />
        {t("New folder")}
      </button>
    </div>
  );
}
// Menu width must match the `w-56` in `<Menu>` (224px) — we use it
// to decide which side of the chip to anchor the dropdown to.
const FOLDER_MENU_WIDTH_PX = 224;

function FolderChip({
  icon,
  label,
  count,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  // User-owned folder chips get rename/delete; "All trips" and "Unfiled"
  // omit these (they're system scopes) and render without a context menu.
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  // Chip menus need to flip alignment based on where the chip
  // lands on the wrapping row. A leftmost wrapped chip with the
  // default `align="right"` (menu anchored to chip's right edge,
  // extending left) would render its left edge off-screen on
  // mobile; a rightmost chip with `align="left"` does the same
  // thing in the other direction.
  const [menuAlign, setMenuAlign] = useState<"left" | "right">("right");
  const chipRef = useRef<HTMLDivElement | null>(null);
  const hasActions = !!(onRename && onDelete);

  const handleToggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      // `align="right"` anchors menu to chip's right edge and extends
      // LEFT — fits only when there's enough room left of the chip's
      // right edge. `align="left"` is the mirror — fits only when
      // there's room to the right. If both fit, prefer right (matches
      // the original kebab UX). If neither, pick whichever overflows
      // less.
      const fitsLeftOfRightEdge = rect.right - FOLDER_MENU_WIDTH_PX >= 0;
      const fitsRightOfLeftEdge =
        rect.left + FOLDER_MENU_WIDTH_PX <= window.innerWidth;
      if (fitsLeftOfRightEdge) {
        setMenuAlign("right");
      } else if (fitsRightOfLeftEdge) {
        setMenuAlign("left");
      } else {
        setMenuAlign(
          rect.left > window.innerWidth - rect.right ? "right" : "left",
        );
      }
    }
    setOpen(true);
  };

  return (
    <div
      ref={chipRef}
      data-menu-root
      className="group relative flex shrink-0 items-center"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={`inline-flex items-center gap-2 rounded-full border px-[14px] py-2 text-[12px] font-bold transition ${
          active
            ? "border-accent bg-accent/20 text-ink"
            : "border-line-strong bg-transparent text-fg-dim hover:text-ink"
        } ${hasActions ? "pr-9" : ""}`}
      >
        {icon}
        <span className="max-w-[14ch] truncate">{label}</span>
        <span
          className={`font-mono text-[11px] tabular-nums ${active ? "text-ink" : "text-fg-mute"}`}
        >
          {format.integer(count)}
        </span>
      </button>
      {hasActions && (
        <>
          <button
            type="button"
            data-menu-trigger
            onClick={handleToggleMenu}
            aria-label={t("Folder actions for {label}", { label })}
            className="absolute right-2 rounded p-0.5 text-fg-dim opacity-60 transition hover:bg-paper hover:text-ink hover:opacity-100 focus:opacity-100"
          >
            <MoreVertical size={11} />
          </button>
          {open && (
            <Menu onClose={() => setOpen(false)} align={menuAlign}>
              <MenuItem
                icon={<Pencil size={13} />}
                label={t("Rename")}
                onClick={() => {
                  setOpen(false);
                  onRename?.();
                }}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label={t("Delete folder")}
                tone="danger"
                onClick={() => {
                  setOpen(false);
                  onDelete?.();
                }}
              />
            </Menu>
          )}
        </>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────
// Toolbar (search / status / sort)
// ─────────────────────────────────────────────────────────
function TripToolbar({
  filters,
  statusCounts,
  onChange,
}: {
  filters: TripFilters;
  statusCounts: Record<TripStatus, number>;
  onChange: (next: TripFilters) => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  const toggleStatus = (status: TripStatus) => {
    const next = new Set(filters.statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    if (next.size === 0) {
      for (const s of TRIP_STATUSES) next.add(s);
    }
    onChange({ ...filters, statuses: next });
  };
  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-3">
      <Input
        type="text"
        value={filters.search}
        onChange={(search) => onChange({ ...filters, search })}
        placeholder={t("Search by name, description, or rider\u2026")}
        ariaLabel={t("Search trips")}
        tone="cream"
        leadingIcon={<Search size={14} />}
        className="min-w-[280px] flex-1"
      />

      {TRIP_STATUSES.map((status) => {
        const active = filters.statuses.has(status);
        return (
          <button
            key={status}
            type="button"
            onClick={() => toggleStatus(status)}
            aria-pressed={active}
            className={`inline-flex items-center gap-2 rounded-lg border px-[14px] py-2 text-[12px] font-bold transition ${
              active
                ? "border-accent bg-accent/20 text-ink"
                : "border-line-strong bg-cream text-ink hover:border-ink"
            }`}
          >
            {t("{status} {count}", {
              status: t(TRIP_STATUS_FILTER_LABELS[status]),
              count: format.integer(statusCounts[status]),
            })}
          </button>
        );
      })}

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
          {t("Sort")}
        </span>
        <Select
          ariaLabel={t("Sort trips")}
          value={filters.sort}
          onChange={(next) =>
            onChange({
              ...filters,
              sort: next as TripSortKey,
            })
          }
          options={TRIP_SORT_KEYS.map((key) => ({
            value: key,
            label: t(TRIP_SORT_LABELS[key]),
          }))}
          tone="cream"
          className="w-[170px]"
        />
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────
// Trip card + actions
// ─────────────────────────────────────────────────────────
interface TripCardProps {
  trip: TripSummary;
  folders: TripFolder[];
  busy: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (folderId: string | null) => void;
}
function TripCard({
  trip,
  folders,
  busy,
  onDuplicate,
  onDelete,
  onMove,
}: TripCardProps) {
  const t = useTranslation();
  const format = useFormat();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Summary endpoint only carries totals when backend ships #647; until
  // then per-day distance lives on the detail row and this card has
  // none. Render only what the wire actually returned — never a
  // confidently-wrong "0 km".
  const distance = trip.distance_km ?? tripDistanceKmOrNull(trip);
  const currentFolder = trip.folder_id
    ? folders.find((f) => f.id === trip.folder_id)
    : null;
  const seed = stableSeed(trip.id);
  // Quality fallback (q=3) drives both MiniRouteSvg's overlay and the
  // QualityBars indicator so the card visual stays on-spec until
  // backend ships #647's `quality_avg` field — picking one to render
  // and hiding the other would leave the card visibly mismatched
  // against the design.
  //
  // Explicit null/undefined check so a real backend `quality_avg`
  // of `0` (lowest-quality trip — a valid output path of the backend
  // DTO mapping where day quality defaults to 0) gets clamped to
  // q=1, not silently remapped to the neutral q=3 placeholder.
  const quality: 1 | 2 | 3 | 4 | 5 =
    trip.quality_avg != null
      ? (Math.max(1, Math.min(5, Math.round(trip.quality_avg))) as
          | 1
          | 2
          | 3
          | 4
          | 5)
      : 3;
  const updatedIso = trip.updatedAt ?? trip.createdAt;
  // T7 e2e anchors on this cataloged "{title}, {status}" accessible name.
  // Without the explicit aria-label the visual status badge (rendered above
  // the title in DOM order) wins, making the card ambiguous.
  const statusLabel = t(TRIP_STATUS_LABELS[trip.status]);
  const cardAriaLabel = t("{title}, {status}", {
    title: trip.name,
    status: statusLabel,
  });
  return (
    <div
      className={`group relative rounded-[14px] border border-line bg-cream transition hover:border-line-strong ${busy ? "opacity-60" : ""}`}
    >
      <Link
        href={`/trips/${trip.id}`}
        aria-label={cardAriaLabel}
        className="block"
      >
        <div className="relative h-[140px] overflow-hidden rounded-t-[14px]">
          {trip.overviewGeometry && trip.overviewGeometry.length > 0 ? (
            <RouteOutlineSvg
              geometry={trip.overviewGeometry}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <MiniRouteSvg
              q={quality}
              seed={seed}
              className="absolute inset-0"
            />
          )}
          <div className="absolute left-[10px] top-[10px]" aria-hidden="true">
            <span
              className={`inline-flex items-center rounded-full px-[10px] py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] ${STATUS_PILL[trip.status]}`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="absolute right-[10px] top-[10px]" aria-hidden="true">
            <QualityBars q={quality} />
          </div>
        </div>

        <div className="p-4">
          <h3 className="text-[17px] font-extrabold tracking-[-0.3px] text-ink group-hover:text-accent transition line-clamp-1">
            {trip.name}
          </h3>
          {trip.region && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-dim">
              <MapPin size={14} className="text-fg-mute" strokeWidth={2} />
              <span className="truncate">{trip.region}</span>
            </div>
          )}

          <div className="mt-[14px] flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono text-[11px] text-fg-dim">
            {distance !== null && (
              <span>
                <span className="font-bold text-ink">
                  {format.distanceKm(distance)}
                </span>
              </span>
            )}
            <span>
              {t("{count, plural, one {# DAY} other {# DAYS}}", {
                count: trip.num_days,
              })}
            </span>
            {trip.passes_count != null && trip.passes_count > 0 && (
              <span>
                {t("{count, plural, one {# PASS} other {# PASSES}}", {
                  count: trip.passes_count,
                })}
              </span>
            )}
            {typeof trip.warnings_count === "number" &&
              trip.warnings_count > 0 && (
                <span className="inline-flex items-center gap-1 text-accent">
                  <AlertTriangle size={11} strokeWidth={2.4} />
                  {format.integer(trip.warnings_count)}
                </span>
              )}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-line pt-3 font-mono text-[11px] text-fg-mute">
            <span>
              {t("{status} {time}", {
                status: trip.updatedAt ? t("UPDATED") : t("CREATED"),
                time: formatRelativeTimeLabel(updatedIso, { format }, t),
              })}
            </span>
            {currentFolder && (
              <span className="uppercase truncate max-w-[12ch]">
                {currentFolder.name}
              </span>
            )}
          </div>
        </div>
      </Link>

      <div data-menu-root className="absolute bottom-3 right-3">
        <button
          type="button"
          data-menu-trigger
          aria-label={t("Trip actions for {name}", { name: trip.name })}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
            setMoveOpen(false);
          }}
          disabled={busy}
          className="rounded-lg bg-cream/80 p-1.5 text-fg-dim opacity-0 backdrop-blur-sm transition focus-visible:opacity-100 group-hover:opacity-100 hover:bg-paper hover:text-ink [@media(hover:none)]:opacity-100"
        >
          <MoreVertical size={16} />
        </button>

        {menuOpen && (
          <Menu
            align="right"
            verticalAlign="bottom"
            onClose={() => {
              setMenuOpen(false);
              setMoveOpen(false);
            }}
          >
            <MenuItem
              icon={<Copy size={13} />}
              label={t("Duplicate")}
              onClick={() => {
                setMenuOpen(false);
                onDuplicate();
              }}
            />
            <MenuItem
              icon={<FolderInput size={13} />}
              label={t("Move to folder")}
              onClick={() => setMoveOpen((v) => !v)}
              trailing={
                <span className="text-[10px] text-fg-dim">
                  {currentFolder?.name ?? t("Unfiled")}
                </span>
              }
            />
            {moveOpen && (
              <div className="max-h-48 overflow-y-auto border-t border-line py-1 pl-3 pr-1">
                <MoveItem
                  label={t("Unfiled")}
                  active={!trip.folder_id}
                  onClick={() => {
                    setMenuOpen(false);
                    setMoveOpen(false);
                    onMove(null);
                  }}
                />
                {folders.map((folder) => (
                  <MoveItem
                    key={folder.id}
                    label={folder.name}
                    active={trip.folder_id === folder.id}
                    onClick={() => {
                      setMenuOpen(false);
                      setMoveOpen(false);
                      onMove(folder.id);
                    }}
                  />
                ))}
                {folders.length === 0 && (
                  <p className="py-1 text-[11px] text-fg-dim">
                    {t("No folders yet. Create one from the sidebar.")}
                  </p>
                )}
              </div>
            )}
            <MenuItem
              icon={<Trash2 size={13} />}
              label={t("Delete")}
              tone="danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            />
          </Menu>
        )}
      </div>
    </div>
  );
}

function QualityBars({ q }: { q: 1 | 2 | 3 | 4 | 5 }) {
  // Spec quality bar palette — same hex ramp as `qualityColors`
  // mirrored locally so the indicator renders identically when CSS
  // tokens aren't reachable (e.g. printed cards). Empty bars use
  // ink/0.08 to stay readable on every cream tint.
  const QUALITY_HEX = [
    "#E05A3C",
    "#F0A03C",
    "#E8D66A",
    "#C7D36A",
    "#6FD38A",
  ] as const;
  const fillColor = QUALITY_HEX[q - 1];
  return (
    <div className="inline-flex gap-[2px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="h-[11px] w-[5px] rounded-[1.5px]"
          style={{
            background: i <= q ? fillColor : "rgba(14,14,16,0.08)",
          }}
        />
      ))}
    </div>
  );
}

function stableSeed(id: string): number {
  // FNV-1a 32-bit hash trimmed to a positive 16-bit seed. The
  // MiniRouteSvg seed only needs to be stable per-trip so two
  // adjacent cards look visually distinct; collision quality
  // doesn't matter beyond that.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 16) & 0xffff;
}
function MoveItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full text-left text-xs rounded px-2 py-1 transition truncate ${
        active ? "text-accent" : "text-ink hover:bg-paper hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
// ─────────────────────────────────────────────────────────
// Folder create/rename modal
// ─────────────────────────────────────────────────────────
function FolderModal({
  mode,
  initialName,
  folders,
  excludeId,
  onClose,
  onSubmit,
}: {
  mode: "create" | "rename";
  initialName: string;
  folders: TripFolder[];
  excludeId?: string | undefined;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const format = useFormat();
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  // Keep the latest onClose in a ref so the keydown effect doesn't re-add
  // the listener every render just because the parent passes an inline
  // arrow function for onClose.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateFolderName(
      value,
      folders,
      t,
      excludeId,
      format.locale,
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(value);
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm rounded-[14px] border border-line bg-cream p-5 shadow-xl"
      >
        <h2 className="text-sm font-semibold text-ink mb-3">
          {mode === "create" ? t("New folder") : t("Rename folder")}
        </h2>
        <FieldLabel htmlFor="folder-name">{t("Name")}</FieldLabel>
        <Input
          id="folder-name"
          autoFocus
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(null);
          }}
          placeholder={t("e.g. Summer {year} Alps", {
            year: format.number(2026, {
              useGrouping: false,
              maximumFractionDigits: 0,
            }),
          })}
        />
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="accent" size="sm" uppercase>
            {mode === "create" ? t("Create") : t("Save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
// ─────────────────────────────────────────────────────────
// Shared UI bits
// ─────────────────────────────────────────────────────────
function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?:
    | {
        label: string;
        onClick: () => void;
      }
    | {
        label: string;
        href: string;
      };
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-cream px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-paper text-fg-mute">
        <Route size={18} strokeWidth={2} />
      </div>
      <div className="text-[18px] font-extrabold text-ink">{title}</div>
      <div className="max-w-[480px] text-[13px] leading-[1.55] text-fg-dim">
        {body}
      </div>
      {action && (
        <div className="mt-[14px]">
          {"href" in action ? (
            <Link
              href={action.href}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95"
            >
              <Plus size={14} /> {action.label}
            </Link>
          ) : (
            <Button variant="secondary" uppercase onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
function Menu({
  onClose,
  align,
  verticalAlign = "top",
  children,
}: {
  onClose: () => void;
  align: "left" | "right";
  // `top` (default) opens 40 px below the trigger — folder chips
  // and any trigger at the top of a card. `bottom` flips the menu
  // upward, used by the trip-card kebab which sits at the
  // bottom-right of the card; with `top` it would render below the
  // card edge (and the card's `overflow-hidden` would clip it).
  verticalAlign?: "top" | "bottom";
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-trip-menu]")) return;
      // Ignore the mousedown only if it lands on *this* menu's own trigger —
      // clicking a sibling menu's trigger should still close us so the page
      // never shows two menus open at once. Each menu+trigger pair is scoped
      // by a common `[data-menu-root]` ancestor.
      const menuRoot = menuRef.current?.closest("[data-menu-root]");
      const targetRoot = target.closest("[data-menu-root]");
      if (
        targetRoot &&
        targetRoot === menuRoot &&
        target.closest("[data-menu-trigger]")
      ) {
        return;
      }
      onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  const verticalClass = verticalAlign === "top" ? "top-10" : "bottom-10";
  const horizontalClass = align === "right" ? "right-2" : "left-2";
  return (
    <div
      ref={menuRef}
      data-trip-menu
      className={`absolute z-20 w-56 rounded-lg border border-line bg-paper shadow-xl py-1 ${verticalClass} ${horizontalClass}`}
    >
      {children}
    </div>
  );
}
function MenuItem({
  icon,
  label,
  onClick,
  tone = "default",
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
  trailing?: React.ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "text-red-700 hover:bg-red-500/10"
      : "text-ink hover:bg-paper";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 transition ${toneClass}`}
    >
      <span className="text-fg-dim">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}
