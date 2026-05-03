"use client";

import {
  useMemo,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bookmark,
  FolderOpen,
  MoreVertical,
  Pencil,
  Plus,
  Route as RouteIcon,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { useCollections } from "@/hooks/useCollections";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import {
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_NAME_LENGTH,
  validateCollectionDescription,
  validateCollectionName,
  type RouteCollectionView,
} from "@/lib/route-collections";
import type { RouteCollectionVisibility } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";

interface CollectionInputForm {
  title: string;
  description: string;
  visibility: RouteCollectionVisibility;
}

export default function RouteCollectionsPage() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const {
    collections,
    followed,
    status,
    errorMessage,
    refresh,
    createCollection,
    updateCollection,
    removeCollection,
    unfollowCollection,
    migration,
  } = useCollections(userId);

  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; collection: RouteCollectionView }
    | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const unfollow = async (collection: RouteCollectionView) => {
    if (!confirm(`Stop following "${collection.title}"?`)) return;
    setActionError(null);
    try {
      await unfollowCollection(collection.id);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to unfollow collection",
      );
    }
  };

  // Throws on failure so the modal stays open and renders the error inside
  // its own form. The earlier shape (catch + setActionError + leave modal
  // open) hid the error behind the modal's fixed overlay — the user got no
  // feedback that anything went wrong.
  const submitModal = async (input: CollectionInputForm) => {
    if (!modal) return;
    setActionError(null);
    if (modal.mode === "create") {
      await createCollection({
        title: input.title.trim(),
        description: input.description.trim() || undefined,
        visibility: input.visibility,
      });
    } else {
      await updateCollection(modal.collection.id, {
        title: input.title.trim(),
        description: input.description.trim() || null,
        visibility: input.visibility,
      });
    }
    setModal(null);
  };

  const deleteCollection = async (collection: RouteCollectionView) => {
    if (
      !confirm(
        `Delete "${collection.title}"? The routes inside won't be affected.`,
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      await removeCollection(collection.id);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to delete collection",
      );
    }
  };

  const needle = search.trim().toLowerCase();

  const visible = useMemo(() => {
    return collections.filter((c) => {
      if (!needle) return true;
      const hay = `${c.title} ${c.description ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [collections, needle]);

  // Apply the same search to followed collections so a search that hides the
  // owned grid doesn't leave unfiltered followed cards visible below it (the
  // search box label says "Search collections…" generically). Followed cards
  // also key on `ownerName` since "by Jane Rider" is a meaningful axis to
  // search by — it's the only thing that distinguishes a followed collection
  // from the owned grid.
  const visibleFollowed = useMemo(() => {
    return followed.filter((c) => {
      if (!needle) return true;
      const hay =
        `${c.title} ${c.description ?? ""} ${c.ownerName}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [followed, needle]);

  const showSkeleton = status === "loading" && collections.length === 0;
  const showLoadError = status === "error" && collections.length === 0;

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

      {migration && <MigrationBanner migration={migration} />}

      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200"
        >
          {actionError}
        </div>
      )}

      <Toolbar search={search} onSearch={setSearch} />

      {showSkeleton ? (
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-5"
          aria-busy="true"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 rounded-2xl border border-slate-800 bg-slate-900 animate-pulse"
            />
          ))}
        </div>
      ) : showLoadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-10 text-center mt-5"
        >
          <AlertTriangle
            size={32}
            className="mx-auto text-amber-400 mb-3"
            aria-hidden="true"
          />
          <p className="text-amber-200 mb-1">
            Couldn&apos;t load your collections
          </p>
          <p className="text-sm text-slate-500 mb-4">
            {errorMessage ?? "Try again in a moment."}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
          >
            Retry
          </button>
        </div>
      ) : collections.length === 0 ? (
        <EmptyState
          title="No collections yet"
          body="Curate your favourite roads into shareable collections."
          actionLabel="Create collection"
          onAction={() => setModal({ mode: "create" })}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No collections match your filters"
          body="Try clearing the search."
          actionLabel="Clear search"
          onAction={() => setSearch("")}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
          {visible.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              onEdit={() => setModal({ mode: "edit", collection })}
              onDelete={() => void deleteCollection(collection)}
            />
          ))}
        </div>
      )}

      {visibleFollowed.length > 0 && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-3">
            <Bookmark size={14} className="text-tarmoto-cyan" />
            <h2 className="text-sm font-semibold text-white">
              Followed collections
            </h2>
            <span className="text-xs text-slate-500">
              · {visibleFollowed.length}
              {needle && visibleFollowed.length !== followed.length
                ? ` of ${followed.length}`
                : ""}
            </span>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Collections from other riders you&apos;ve saved. They show up here
            until you unfollow.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleFollowed.map((collection) => (
              <FollowedCollectionCard
                key={collection.id}
                collection={collection}
                onUnfollow={() => void unfollow(collection)}
              />
            ))}
          </div>
        </section>
      )}

      {modal && (
        <CollectionModal
          mode={modal.mode}
          initial={
            modal.mode === "edit"
              ? {
                  title: modal.collection.title,
                  description: modal.collection.description ?? "",
                  visibility: modal.collection.visibility,
                }
              : { title: "", description: "", visibility: "private" }
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
// Migration banner
// ─────────────────────────────────────────────────────────

function MigrationBanner({
  migration,
}: {
  migration: NonNullable<ReturnType<typeof useCollections>["migration"]>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = migration.count === 1 ? "collection" : "collections";

  return (
    <div className="mb-4 rounded-xl border border-tarmoto-cyan/20 bg-tarmoto-cyan/5 p-4">
      <p className="text-sm text-slate-200">
        Found {migration.count} {word} saved on this device. Move them to your
        Tarmoto account so they sync across devices and survive clearing browser
        storage.
      </p>
      {error && (
        <p className="mt-2 text-xs text-amber-300" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await migration.accept();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Migration failed");
            } finally {
              setPending(false);
            }
          }}
          className="px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-xs font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {pending ? "Moving…" : "Move to my account"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={migration.decline}
          className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white transition disabled:opacity-50"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────

function Toolbar({
  search,
  onSearch,
}: {
  search: string;
  onSearch: (value: string) => void;
}) {
  return (
    <div className="max-w-md">
      <div className="relative flex-1">
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Collection card
// ─────────────────────────────────────────────────────────

function CollectionCard({
  collection,
  onEdit,
  onDelete,
}: {
  collection: RouteCollectionView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Distance + missing-count breakdowns deliberately live on the detail page,
  // not here. The list endpoint returns a summary (no per-item ids), so any
  // attempt to join against `useUserTrips` here would always read zero
  // present-trips and render a misleading "N unavailable" badge for every
  // non-empty collection. The simple `itemCount` is authoritative.
  return (
    <div
      data-menu-root
      className="relative rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition"
    >
      <Link
        href={`/community/collections/${collection.id}`}
        className="block p-5 pr-12 group"
      >
        <div className="flex items-start gap-2 mb-3">
          <h3 className="font-semibold text-white group-hover:text-tarmoto-cyan transition line-clamp-2 flex-1">
            {collection.title}
          </h3>
          <RouteCollectionVisibilityPill
            visibility={collection.visibility}
            className="shrink-0"
          />
        </div>

        {collection.description && (
          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
            {collection.description}
          </p>
        )}

        <div className="flex items-center gap-2 text-sm text-slate-400">
          <RouteIcon size={13} />
          <span>
            {collection.itemCount} route
            {collection.itemCount === 1 ? "" : "s"}
          </span>
        </div>

        <p className="mt-3 text-[11px] text-slate-600">
          Updated {formatRelativeTime(collection.updatedAt)}
        </p>
      </Link>

      <button
        type="button"
        data-menu-trigger
        aria-label={`Actions for ${collection.title}`}
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

// ─────────────────────────────────────────────────────────
// Followed collection card
// ─────────────────────────────────────────────────────────

function FollowedCollectionCard({
  collection,
  onUnfollow,
}: {
  collection: RouteCollectionView;
  onUnfollow: () => void;
}) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition relative">
      <Link
        href={`/community/collections/shared/${encodeURIComponent(collection.slug)}`}
        className="block p-5 pr-12 group"
      >
        <div className="flex items-start gap-2 mb-3">
          <h3 className="font-semibold text-white group-hover:text-tarmoto-cyan transition line-clamp-2 flex-1">
            {collection.title}
          </h3>
          <RouteCollectionVisibilityPill
            visibility={collection.visibility}
            className="shrink-0"
          />
        </div>

        {collection.description && (
          <p className="text-xs text-slate-500 line-clamp-2 mb-3">
            {collection.description}
          </p>
        )}

        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="inline-flex items-center gap-1">
            <RouteIcon size={13} />
            <span>
              {collection.itemCount} route
              {collection.itemCount === 1 ? "" : "s"}
            </span>
          </span>
          {collection.ownerName && (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <User size={13} />
              <span className="truncate">{collection.ownerName}</span>
            </span>
          )}
        </div>

        <p className="mt-3 text-[11px] text-slate-600">
          Updated {formatRelativeTime(collection.updatedAt)}
        </p>
      </Link>

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onUnfollow();
        }}
        aria-label={`Unfollow ${collection.title}`}
        className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition"
      >
        <Trash2 size={16} />
      </button>
    </div>
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
  initial: CollectionInputForm;
  collections: readonly RouteCollectionView[];
  excludeId?: string;
  onClose: () => void;
  onSubmit: (input: CollectionInputForm) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [visibility, setVisibility] = useState<RouteCollectionVisibility>(
    initial.visibility,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nameError = validateCollectionName(title, collections, excludeId);
    if (nameError) {
      setError(nameError);
      return;
    }
    const descError = validateCollectionDescription(description);
    if (descError) {
      setError(descError);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ title, description, visibility });
    } catch (err) {
      // Render the error inline so it's visible above the modal overlay.
      // The page's own actionError banner sits behind us — a parent-level
      // setState wouldn't paint until the modal closed.
      setError(
        err instanceof Error ? err.message : "Failed to save collection",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-modal-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl"
      >
        <h2
          id="collection-modal-title"
          className="text-sm font-semibold text-white mb-4"
        >
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
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
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

          <fieldset>
            <legend className="block text-xs text-slate-500 mb-2">
              Visibility
            </legend>
            <div className="space-y-2">
              {(
                [
                  {
                    value: "private",
                    label: "Private",
                    body: "Only you can see this collection.",
                  },
                  {
                    value: "unlisted",
                    label: "Unlisted",
                    body: "Anyone with the link can view. Not listed publicly.",
                  },
                  {
                    value: "public",
                    label: "Public",
                    body: "Anyone can find and view this collection.",
                  },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className={`flex gap-3 p-3 rounded-lg cursor-pointer border transition ${
                    visibility === opt.value
                      ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
                      : "border-slate-800 bg-slate-950 hover:border-slate-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="collection-visibility"
                    value={opt.value}
                    checked={visibility === opt.value}
                    onChange={() => setVisibility(opt.value)}
                    className="mt-0.5 accent-tarmoto-cyan"
                  />
                  <div>
                    <p className="text-sm text-white">{opt.label}</p>
                    <p className="text-[11px] text-slate-500">{opt.body}</p>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg bg-tarmoto-cyan text-slate-950 text-sm font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
          >
            {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </div>
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
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Stash onClose in a ref so the document-listener effect doesn't re-bind
  // every render (the parent passes an inline arrow). Mirrors the pattern
  // CollectionModal uses for its Escape handler.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
      onCloseRef.current();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

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
  icon: ReactNode;
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
