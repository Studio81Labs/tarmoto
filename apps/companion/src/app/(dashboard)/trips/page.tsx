"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Plus,
  Route,
  Calendar,
  MapPin,
  Users,
  Search,
  Folder,
  FolderPlus,
  MoreVertical,
  Copy,
  Trash2,
  FolderInput,
  Pencil,
  Inbox,
  X,
} from "lucide-react";
import { tripsApi } from "@/lib/api";
import { useTripStore } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import {
  DEFAULT_TRIP_FILTERS,
  TRIP_STATUSES,
  TRIP_SORT_KEYS,
  applyTripFilters,
  countByStatus,
  tripDistanceKm,
  type FolderScope,
  type TripFilters,
  type TripSortKey,
  type TripStatus,
} from "@/lib/trip-filters";
import {
  createFolder,
  loadFolders,
  removeFolder,
  renameFolder,
  saveFolders,
  sortFoldersByName,
  validateFolderName,
  type TripFolder,
} from "@/lib/trip-folders";
import { duplicateTripPayload } from "@/lib/trip-duplicate";
import { formatRelativeTime } from "@/lib/utils";
import type { Trip } from "@/lib/types";

const STATUS_LABEL: Record<TripStatus, string> = {
  draft: "Drafts",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
};

const STATUS_PILL: Record<TripStatus, string> = {
  draft: "bg-slate-600 text-white",
  planned: "bg-blue-500 text-white",
  active: "bg-tarmoto-cyan text-slate-950",
  completed: "bg-quality-excellent text-slate-950",
};

const SORT_LABEL: Record<TripSortKey, string> = {
  updated: "Last updated",
  created: "Date created",
  name: "Name (A→Z)",
  distance: "Distance",
};

export default function TripListPage() {
  const trips = useTripStore((s) => s.trips);
  const setTrips = useTripStore((s) => s.setTrips);
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<TripFolder[]>([]);
  const [filters, setFilters] = useState<TripFilters>(() => ({
    ...DEFAULT_TRIP_FILTERS,
    statuses: new Set(DEFAULT_TRIP_FILTERS.statuses),
    folderScope: { ...DEFAULT_TRIP_FILTERS.folderScope },
  }));

  const [folderModal, setFolderModal] = useState<
    { mode: "create" } | { mode: "rename"; folder: TripFolder } | null
  >(null);
  const [busyTripIds, setBusyTripIds] = useState<Set<string>>(() => new Set());
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

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
        const body = data as unknown as { data?: Trip[] } | Trip[];
        setTrips(Array.isArray(body) ? body : (body?.data ?? []));
      })
      .catch(() => {
        if (cancelled) return;
        setTrips([]);
        setErrorBanner("Couldn't load your trips. Check your connection.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTrips, userId]);

  useEffect(() => {
    if (!userId) {
      // Sign-out / account switch: drop the previous user's folders and any
      // selected folder scope so nothing leaks across sessions.
      setFolders([]);
      setFilters((prev) =>
        prev.folderScope.kind === "folder"
          ? { ...prev, folderScope: { kind: "all" } }
          : prev,
      );
      return;
    }
    setFolders(sortFoldersByName(loadFolders(userId)));
  }, [userId]);

  const persistFolders = (next: TripFolder[]) => {
    const sorted = sortFoldersByName(next);
    setFolders(sorted);
    if (userId) saveFolders(userId, sorted);
  };

  const visibleTrips = useMemo(
    () => applyTripFilters(trips, filters),
    [trips, filters],
  );
  const statusCounts = useMemo(() => countByStatus(trips), [trips]);
  const unfiledCount = useMemo(
    () => trips.filter((t) => !t.folderId).length,
    [trips],
  );
  const tripsPerFolder = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trips) {
      if (!t.folderId) continue;
      map.set(t.folderId, (map.get(t.folderId) ?? 0) + 1);
    }
    return map;
  }, [trips]);

  // When a folder is deleted we drop its metadata, clear `folderId` on every
  // affected trip locally, and tell the server to do the same. Without the
  // server update those trips would reload with a stale folderId that no
  // longer matches any folder and would be filtered out of "Unfiled" too.
  const handleDeleteFolder = async (folder: TripFolder) => {
    if (
      !confirm(
        `Delete folder "${folder.name}"? Trips inside will become unfiled.`,
      )
    ) {
      return;
    }
    persistFolders(removeFolder(folders, folder.id));
    if (
      filters.folderScope.kind === "folder" &&
      filters.folderScope.id === folder.id
    ) {
      setFilters({ ...filters, folderScope: { kind: "all" } });
    }
    // Read fresh store state so rapid successive actions from the same
    // render cycle don't clobber each other's optimistic updates.
    const current = useTripStore.getState().trips;
    const affected = current.filter((t) => t.folderId === folder.id);
    setTrips(
      current.map((t) =>
        t.folderId === folder.id ? { ...t, folderId: undefined } : t,
      ),
    );
    const failures = await Promise.allSettled(
      affected.map((t) => tripsApi.update(t.id, { folderId: null })),
    );
    if (failures.some((r) => r.status === "rejected")) {
      setErrorBanner(
        "Folder deleted, but some trips couldn't sync. They may reappear after reload.",
      );
    }
  };

  const moveTripToFolder = async (trip: Trip, folderId: string | null) => {
    const previousFolderId = trip.folderId;
    // Read fresh state so concurrent optimistic updates don't clobber each
    // other when two actions fire in the same render.
    setTrips(
      useTripStore
        .getState()
        .trips.map((t) =>
          t.id === trip.id ? { ...t, folderId: folderId ?? undefined } : t,
        ),
    );
    markBusy(trip.id);
    try {
      await tripsApi.update(trip.id, { folderId });
    } catch {
      // Targeted rollback: touch only this trip so concurrent duplicates or
      // deletes made during the await aren't clobbered by a stale snapshot.
      setTrips(
        useTripStore
          .getState()
          .trips.map((t) =>
            t.id === trip.id ? { ...t, folderId: previousFolderId } : t,
          ),
      );
      setErrorBanner("Couldn't move the trip. Try again.");
    } finally {
      clearBusy(trip.id);
    }
  };

  const duplicateTrip = async (trip: Trip) => {
    markBusy(trip.id);
    try {
      const { data } = await tripsApi.create(duplicateTripPayload(trip));
      // Match the list-endpoint handling: the server sometimes wraps
      // responses in `{ data: ... }`, so unwrap if present.
      const body = data as unknown as { data?: Trip } | Trip | null;
      const created =
        body && typeof body === "object" && "data" in body && body.data
          ? (body.data as Trip)
          : (body as Trip | null);
      // Read the fresh trip list from the store — concurrent deletes or
      // moves made during the await shouldn't be silently reverted.
      if (created && created.id) {
        setTrips([created, ...useTripStore.getState().trips]);
      }
    } catch {
      setErrorBanner("Couldn't duplicate the trip. Try again.");
    } finally {
      clearBusy(trip.id);
    }
  };

  const deleteTrip = async (trip: Trip) => {
    if (!confirm(`Delete "${trip.name}"? This cannot be undone.`)) return;
    // Read fresh state so concurrent optimistic updates don't clobber each
    // other when two actions fire in the same render.
    const before = useTripStore.getState().trips;
    const indexBefore = before.findIndex((t) => t.id === trip.id);
    setTrips(before.filter((t) => t.id !== trip.id));
    markBusy(trip.id);
    try {
      await tripsApi.delete(trip.id);
    } catch {
      // Targeted rollback: splice the deleted trip back into the fresh list
      // so concurrent adds/moves aren't clobbered.
      const current = useTripStore.getState().trips;
      const restored = current.slice();
      const insertAt = Math.min(Math.max(indexBefore, 0), restored.length);
      restored.splice(insertAt, 0, trip);
      setTrips(restored);
      setErrorBanner("Couldn't delete the trip. Try again.");
    } finally {
      clearBusy(trip.id);
    }
  };

  const submitFolderModal = (name: string) => {
    if (!folderModal) return;
    if (folderModal.mode === "create") {
      persistFolders([...folders, createFolder(name)]);
    } else {
      persistFolders(renameFolder(folders, folderModal.folder.id, name));
    }
    setFolderModal(null);
  };

  return (
    <div className="flex h-full">
      <FolderNav
        folders={folders}
        scope={filters.folderScope}
        unfiledCount={unfiledCount}
        totalCount={trips.length}
        tripsPerFolder={tripsPerFolder}
        onSelect={(scope) => setFilters({ ...filters, folderScope: scope })}
        onNew={() => setFolderModal({ mode: "create" })}
        onRename={(folder) => setFolderModal({ mode: "rename", folder })}
        onDelete={handleDeleteFolder}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-6xl mx-auto animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
            <div>
              <h1 className="text-2xl font-bold">My Trips</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {trips.length} trip{trips.length === 1 ? "" : "s"} ·{" "}
                {folders.length} folder{folders.length === 1 ? "" : "s"}
              </p>
            </div>
            <Link
              href="/trips/planner"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
            >
              <Plus size={16} /> New trip
            </Link>
          </div>

          {errorBanner && (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <span>{errorBanner}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => setErrorBanner(null)}
                className="text-red-200 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <TripToolbar
            filters={filters}
            statusCounts={statusCounts}
            onChange={setFilters}
          />

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-48 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse"
                />
              ))}
            </div>
          ) : trips.length === 0 ? (
            <EmptyState
              title="No trips yet"
              body="Plan your first ride with the trip planner."
              action={{ label: "Create trip", href: "/trips/planner" }}
            />
          ) : visibleTrips.length === 0 ? (
            <EmptyState
              title="No trips match your filters"
              body="Try clearing the search or selecting a different folder."
              action={{
                label: "Clear filters",
                onClick: () =>
                  setFilters({
                    ...DEFAULT_TRIP_FILTERS,
                    statuses: new Set(DEFAULT_TRIP_FILTERS.statuses),
                    folderScope: { ...DEFAULT_TRIP_FILTERS.folderScope },
                  }),
              }}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
              {visibleTrips.map((trip) => (
                <TripCard
                  key={trip.id}
                  trip={trip}
                  folders={folders}
                  busy={busyTripIds.has(trip.id)}
                  onDuplicate={() => duplicateTrip(trip)}
                  onDelete={() => deleteTrip(trip)}
                  onMove={(folderId) => moveTripToFolder(trip, folderId)}
                />
              ))}
            </div>
          )}
        </div>
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Folder sidebar
// ─────────────────────────────────────────────────────────

interface FolderNavProps {
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

function FolderNav({
  folders,
  scope,
  unfiledCount,
  totalCount,
  tripsPerFolder,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: FolderNavProps) {
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60 px-3 py-5">
      <div className="flex items-center justify-between mb-3 px-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          Folders
        </span>
        <button
          type="button"
          onClick={onNew}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 text-sm">
        <FolderNavItem
          icon={<Route size={14} />}
          label="All trips"
          count={totalCount}
          active={scope.kind === "all"}
          onClick={() => onSelect({ kind: "all" })}
        />
        <FolderNavItem
          icon={<Inbox size={14} />}
          label="Unfiled"
          count={unfiledCount}
          active={scope.kind === "unfiled"}
          onClick={() => onSelect({ kind: "unfiled" })}
        />

        {folders.length > 0 && (
          <div className="mt-3 space-y-0.5">
            {folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                count={tripsPerFolder.get(folder.id) ?? 0}
                active={scope.kind === "folder" && scope.id === folder.id}
                onSelect={() => onSelect({ kind: "folder", id: folder.id })}
                onRename={() => onRename(folder)}
                onDelete={() => onDelete(folder)}
              />
            ))}
          </div>
        )}
      </nav>
    </aside>
  );
}

function FolderNavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition ${
        active
          ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
          : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
      }`}
    >
      <span className="flex items-center gap-2 truncate">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="text-xs tabular-nums text-slate-500">{count}</span>
    </button>
  );
}

function FolderRow({
  folder,
  count,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  folder: TripFolder;
  count: number;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-menu-root className="group relative flex items-center">
      <button
        type="button"
        onClick={onSelect}
        className={`flex flex-1 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition ${
          active
            ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
            : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
        }`}
      >
        <span className="flex items-center gap-2 truncate">
          <Folder size={14} />
          <span className="truncate">{folder.name}</span>
        </span>
        <span className="text-xs tabular-nums text-slate-500">{count}</span>
      </button>
      <button
        type="button"
        data-menu-trigger
        onClick={() => setOpen((v) => !v)}
        aria-label={`Folder actions for ${folder.name}`}
        className="absolute right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
      >
        <MoreVertical size={12} />
      </button>
      {open && (
        <Menu onClose={() => setOpen(false)} align="right">
          <MenuItem
            icon={<Pencil size={13} />}
            label="Rename"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          />
          <MenuItem
            icon={<Trash2 size={13} />}
            label="Delete folder"
            tone="danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          />
        </Menu>
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative flex-1 max-w-md">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search by name, description, or rider…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TRIP_STATUSES.map((status) => {
          const active = filters.statuses.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              aria-pressed={active}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                active
                  ? "bg-slate-800 text-white border border-slate-700"
                  : "bg-transparent text-slate-500 border border-slate-800 hover:text-slate-300"
              }`}
            >
              {STATUS_LABEL[status]}{" "}
              <span className="tabular-nums text-slate-500">
                {statusCounts[status]}
              </span>
            </button>
          );
        })}

        <label className="flex items-center gap-2 text-xs text-slate-500 ml-2">
          <span>Sort</span>
          <select
            value={filters.sort}
            onChange={(e) =>
              onChange({
                ...filters,
                sort: e.target.value as TripSortKey,
              })
            }
            className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-white focus:outline-none focus:border-tarmoto-cyan"
          >
            {TRIP_SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Trip card + actions
// ─────────────────────────────────────────────────────────

interface TripCardProps {
  trip: Trip;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  const distance = tripDistanceKm(trip);
  const currentFolder = trip.folderId
    ? folders.find((f) => f.id === trip.folderId)
    : null;

  return (
    <div
      data-menu-root
      className={`relative rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition ${
        busy ? "opacity-60" : ""
      }`}
    >
      <Link href={`/trips/${trip.id}`} className="block p-5 pr-12 group">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="font-semibold text-white group-hover:text-tarmoto-cyan transition line-clamp-2">
            {trip.name}
          </h3>
          <span
            className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${STATUS_PILL[trip.status]}`}
          >
            {trip.status}
          </span>
        </div>

        {trip.description && (
          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
            {trip.description}
          </p>
        )}

        <div className="space-y-1.5 text-sm text-slate-400">
          <div className="flex items-center gap-2">
            <Calendar size={13} />
            <span>
              {trip.days.length} day{trip.days.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin size={13} />
            <span>{Math.round(distance)} km total</span>
          </div>
          {trip.collaborators.length > 1 && (
            <div className="flex items-center gap-2">
              <Users size={13} />
              <span>{trip.collaborators.length} riders</span>
            </div>
          )}
          {currentFolder && (
            <div className="flex items-center gap-2 text-slate-500">
              <Folder size={13} />
              <span className="truncate">{currentFolder.name}</span>
            </div>
          )}
        </div>

        <p className="mt-3 text-[11px] text-slate-600">
          Updated {formatRelativeTime(trip.updatedAt)}
        </p>
      </Link>

      <button
        type="button"
        data-menu-trigger
        aria-label={`Trip actions for ${trip.name}`}
        onClick={(e) => {
          e.preventDefault();
          setMenuOpen((v) => !v);
          setMoveOpen(false);
        }}
        disabled={busy}
        className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
      >
        <MoreVertical size={16} />
      </button>

      {menuOpen && (
        <Menu
          align="right"
          onClose={() => {
            setMenuOpen(false);
            setMoveOpen(false);
          }}
        >
          <MenuItem
            icon={<Copy size={13} />}
            label="Duplicate"
            onClick={() => {
              setMenuOpen(false);
              onDuplicate();
            }}
          />
          <MenuItem
            icon={<FolderInput size={13} />}
            label="Move to folder"
            onClick={() => setMoveOpen((v) => !v)}
            trailing={
              <span className="text-[10px] text-slate-500">
                {currentFolder?.name ?? "Unfiled"}
              </span>
            }
          />
          {moveOpen && (
            <div className="pl-3 pr-1 py-1 border-t border-slate-800 max-h-48 overflow-y-auto">
              <MoveItem
                label="Unfiled"
                active={!trip.folderId}
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
                  active={trip.folderId === folder.id}
                  onClick={() => {
                    setMenuOpen(false);
                    setMoveOpen(false);
                    onMove(folder.id);
                  }}
                />
              ))}
              {folders.length === 0 && (
                <p className="text-[11px] text-slate-500 py-1">
                  No folders yet. Create one from the sidebar.
                </p>
              )}
            </div>
          )}
          <MenuItem
            icon={<Trash2 size={13} />}
            label="Delete"
            tone="danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          />
        </Menu>
      )}
    </div>
  );
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
        active
          ? "text-tarmoto-cyan"
          : "text-slate-300 hover:bg-slate-800 hover:text-white"
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
  excludeId?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateFolderName(value, folders, excludeId);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(value);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl"
      >
        <h2 className="text-sm font-semibold text-white mb-3">
          {mode === "create" ? "New folder" : "Rename folder"}
        </h2>
        <label
          className="block text-xs text-slate-500 mb-1"
          htmlFor="folder-name"
        >
          Name
        </label>
        <input
          id="folder-name"
          autoFocus
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="e.g. Summer 2026 Alps"
          className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-tarmoto-cyan"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light transition"
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
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
    | { label: string; onClick: () => void }
    | { label: string; href: string };
}) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center mt-5">
      <Route size={48} className="mx-auto text-slate-600 mb-4" />
      <p className="text-slate-400 text-lg mb-1">{title}</p>
      <p className="text-slate-500 text-sm mb-6">{body}</p>
      {action &&
        ("href" in action ? (
          <Link
            href={action.href}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
          >
            <Plus size={16} /> {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}

function Menu({
  onClose,
  align,
  children,
}: {
  onClose: () => void;
  align: "left" | "right";
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

  return (
    <div
      ref={menuRef}
      data-trip-menu
      className={`absolute top-10 z-20 w-56 rounded-lg border border-slate-800 bg-slate-950 shadow-xl py-1 ${
        align === "right" ? "right-2" : "left-2"
      }`}
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
      ? "text-red-400 hover:bg-red-500/10"
      : "text-slate-200 hover:bg-slate-800";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 transition ${toneClass}`}
    >
      <span className="text-slate-500">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}
