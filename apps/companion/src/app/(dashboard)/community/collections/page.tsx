"use client";

import { useMemo, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  FolderOpen,
  Globe,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  Route as RouteIcon,
  Search,
  Trash2,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { useUserTrips } from "@/hooks/useUserTrips";
import { useCollections } from "@/hooks/useCollections";
import {
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_NAME_LENGTH,
  createCollection,
  removeCollection,
  updateCollection,
  validateCollectionDescription,
  validateCollectionName,
  type CollectionInput,
  type StoredRouteCollection,
} from "@/lib/route-collections";
import { tripDistanceKm } from "@/lib/trip-filters";
import { formatDistance, formatRelativeTime } from "@/lib/utils";
import type { Trip } from "@/lib/types";

type VisibilityFilter = "all" | "public" | "private";

export default function RouteCollectionsPage() {
  const { tripById, loading: loadingTrips } = useUserTrips();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { collections, persist } = useCollections(userId);

  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [modal, setModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; collection: StoredRouteCollection }
    | null
  >(null);

  const submitModal = (input: CollectionInput) => {
    if (!modal) return;
    if (modal.mode === "create") {
      persist([...collections, createCollection(input)]);
    } else {
      persist(updateCollection(collections, modal.collection.id, input));
    }
    setModal(null);
  };

  const deleteCollection = (collection: StoredRouteCollection) => {
    if (
      !confirm(
        `Delete "${collection.name}"? The routes inside won't be affected.`,
      )
    ) {
      return;
    }
    persist(removeCollection(collections, collection.id));
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return collections.filter((c) => {
      if (visibility === "public" && !c.isPublic) return false;
      if (visibility === "private" && c.isPublic) return false;
      if (!needle) return true;
      const hay = `${c.name} ${c.description ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [collections, search, visibility]);

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Route Collections</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {collections.length} collection
            {collections.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({ mode: "create" })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
        >
          <Plus size={16} /> New collection
        </button>
      </div>

      <Toolbar
        search={search}
        onSearch={setSearch}
        visibility={visibility}
        onVisibility={setVisibility}
        counts={{
          all: collections.length,
          public: collections.filter((c) => c.isPublic).length,
          private: collections.filter((c) => !c.isPublic).length,
        }}
      />

      {collections.length === 0 ? (
        <EmptyState
          title="No collections yet"
          body="Curate your favourite roads into shareable collections."
          actionLabel="Create collection"
          onAction={() => setModal({ mode: "create" })}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No collections match your filters"
          body="Try clearing the search or switching visibility."
          actionLabel="Clear filters"
          onAction={() => {
            setSearch("");
            setVisibility("all");
          }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
          {visible.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              tripById={tripById}
              loadingTrips={loadingTrips}
              onEdit={() => setModal({ mode: "edit", collection })}
              onDelete={() => deleteCollection(collection)}
            />
          ))}
        </div>
      )}

      {modal && (
        <CollectionModal
          mode={modal.mode}
          initial={
            modal.mode === "edit"
              ? {
                  name: modal.collection.name,
                  description: modal.collection.description ?? "",
                  isPublic: modal.collection.isPublic,
                }
              : { name: "", description: "", isPublic: false }
          }
          collections={collections}
          excludeId={modal.mode === "edit" ? modal.collection.id : undefined}
          onClose={() => setModal(null)}
          onSubmit={submitModal}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────

function Toolbar({
  search,
  onSearch,
  visibility,
  onVisibility,
  counts,
}: {
  search: string;
  onSearch: (value: string) => void;
  visibility: VisibilityFilter;
  onVisibility: (value: VisibilityFilter) => void;
  counts: Record<VisibilityFilter, number>;
}) {
  const options: { key: VisibilityFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "public", label: "Public" },
    { key: "private", label: "Private" },
  ];
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative flex-1 max-w-md">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search collections…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan transition"
        />
      </div>
      <div className="flex items-center gap-1">
        {options.map((opt) => {
          const active = visibility === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onVisibility(opt.key)}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                active
                  ? "bg-slate-800 text-white border border-slate-700"
                  : "bg-transparent text-slate-500 border border-slate-800 hover:text-slate-300"
              }`}
            >
              {opt.label}{" "}
              <span className="tabular-nums text-slate-500">
                {counts[opt.key]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Collection card
// ─────────────────────────────────────────────────────────

function CollectionCard({
  collection,
  tripById,
  loadingTrips,
  onEdit,
  onDelete,
}: {
  collection: StoredRouteCollection;
  tripById: Map<string, Trip>;
  loadingTrips: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Only count trips the user still owns — if a trip is deleted we don't want
  // to inflate the card stats. The detail page shows a "missing trip" hint so
  // users can unstick broken entries.
  const presentTrips = collection.tripIds
    .map((id) => tripById.get(id))
    .filter((t): t is Trip => Boolean(t));
  const totalDistance = presentTrips.reduce(
    (sum, t) => sum + tripDistanceKm(t),
    0,
  );
  const missingCount = collection.tripIds.length - presentTrips.length;

  return (
    <div
      data-menu-root
      className="relative rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition"
    >
      <Link
        href={`/community/collections/${collection.id}`}
        className="block p-5 pr-12 group"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="font-semibold text-white group-hover:text-tarmoto-cyan transition line-clamp-2">
            {collection.name}
          </h3>
          <VisibilityBadge isPublic={collection.isPublic} />
        </div>

        {collection.description && (
          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
            {collection.description}
          </p>
        )}

        <div className="space-y-1.5 text-sm text-slate-400">
          <div className="flex items-center gap-2">
            <RouteIcon size={13} />
            <span>
              {collection.tripIds.length} route
              {collection.tripIds.length === 1 ? "" : "s"}
              {missingCount > 0 && !loadingTrips && (
                <span className="ml-2 text-[11px] text-amber-400">
                  {missingCount} unavailable
                </span>
              )}
            </span>
          </div>
          {presentTrips.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-tarmoto-cyan" />
              <span>{formatDistance(totalDistance)} total</span>
            </div>
          )}
        </div>

        <p className="mt-3 text-[11px] text-slate-600">
          Updated {formatRelativeTime(collection.updatedAt)}
        </p>
      </Link>

      <button
        type="button"
        data-menu-trigger
        aria-label={`Actions for ${collection.name}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
      >
        <MoreVertical size={16} />
      </button>

      {menuOpen && (
        <CardMenu onClose={() => setMenuOpen(false)}>
          <CardMenuItem
            icon={<Pencil size={13} />}
            label="Edit"
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
          />
          <CardMenuItem
            icon={<Trash2 size={13} />}
            label="Delete"
            tone="danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          />
        </CardMenu>
      )}
    </div>
  );
}

function VisibilityBadge({ isPublic }: { isPublic: boolean }) {
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
        isPublic
          ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
          : "bg-slate-800 text-slate-400"
      }`}
    >
      {isPublic ? <Globe size={10} /> : <Lock size={10} />}
      {isPublic ? "Public" : "Private"}
    </span>
  );
}

// ─────────────────────────────────────────────────────────
// Create / edit modal
// ─────────────────────────────────────────────────────────

function CollectionModal({
  mode,
  initial,
  collections,
  excludeId,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial: { name: string; description: string; isPublic: boolean };
  collections: readonly StoredRouteCollection[];
  excludeId?: string;
  onClose: () => void;
  onSubmit: (input: CollectionInput) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [isPublic, setIsPublic] = useState(initial.isPublic);
  const [error, setError] = useState<string | null>(null);

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
    const nameError = validateCollectionName(name, collections, excludeId);
    if (nameError) {
      setError(nameError);
      return;
    }
    const descError = validateCollectionDescription(description);
    if (descError) {
      setError(descError);
      return;
    }
    onSubmit({ name, description, isPublic });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl"
      >
        <h2 className="text-sm font-semibold text-white mb-4">
          {mode === "create" ? "New collection" : "Edit collection"}
        </h2>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="collection-name"
              className="block text-xs text-slate-500 mb-1"
            >
              Name
            </label>
            <input
              id="collection-name"
              autoFocus
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={MAX_COLLECTION_NAME_LENGTH + 10}
              placeholder="e.g. My Favourite Beskydy Loops"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-tarmoto-cyan"
            />
          </div>
          <div>
            <label
              htmlFor="collection-description"
              className="block text-xs text-slate-500 mb-1"
            >
              Description <span className="text-slate-600">(optional)</span>
            </label>
            <textarea
              id="collection-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setError(null);
              }}
              rows={3}
              maxLength={MAX_COLLECTION_DESCRIPTION_LENGTH + 10}
              placeholder="What makes this collection special?"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm placeholder:text-slate-600 focus:outline-none focus:border-tarmoto-cyan resize-none"
            />
            <p className="mt-1 text-[11px] text-slate-600">
              {description.length}/{MAX_COLLECTION_DESCRIPTION_LENGTH}
            </p>
          </div>

          <fieldset className="rounded-lg border border-slate-800 p-3">
            <legend className="px-1 text-xs text-slate-500">Visibility</legend>
            <div className="flex flex-col gap-2 text-sm">
              <VisibilityOption
                selected={!isPublic}
                onClick={() => setIsPublic(false)}
                icon={<Lock size={14} />}
                title="Private"
                body="Only you can see this collection."
              />
              <VisibilityOption
                selected={isPublic}
                onClick={() => setIsPublic(true)}
                icon={<Globe size={14} />}
                title="Public"
                body="Anyone with the link can view this collection."
              />
            </div>
          </fieldset>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

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

function VisibilityOption({
  selected,
  onClick,
  icon,
  title,
  body,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex items-start gap-3 px-3 py-2 rounded-lg text-left transition border ${
        selected
          ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
          : "border-slate-800 bg-slate-950 hover:border-slate-700"
      }`}
    >
      <span
        className={
          selected ? "text-tarmoto-cyan mt-0.5" : "text-slate-500 mt-0.5"
        }
      >
        {icon}
      </span>
      <span className="flex-1">
        <span
          className={`block text-sm font-medium ${selected ? "text-white" : "text-slate-300"}`}
        >
          {title}
        </span>
        <span className="block text-[11px] text-slate-500">{body}</span>
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────

function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-16 text-center mt-5">
      <FolderOpen size={48} className="mx-auto text-slate-600 mb-4" />
      <p className="text-slate-400 text-lg mb-2">{title}</p>
      <p className="text-slate-500 text-sm mb-6">{body}</p>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
      >
        <Plus size={16} /> {actionLabel}
      </button>
    </div>
  );
}

function CardMenu({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-collection-menu]")) return;
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
      data-collection-menu
      className="absolute top-10 right-2 z-20 w-44 rounded-lg border border-slate-800 bg-slate-950 shadow-xl py-1"
    >
      {children}
    </div>
  );
}

function CardMenuItem({
  icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
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
    </button>
  );
}
