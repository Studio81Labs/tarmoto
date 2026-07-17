"use client";
import { t } from "@/i18n";
import {
  useEffect,
  useMemo,
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
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { useCollections } from "@/hooks/useCollections";
import {
  Button,
  Card,
  FieldLabel,
  Input,
  Mono,
  RadioCardGroup,
  SkeletonGrid,
  Stamp,
  Textarea,
} from "@tarmoto/ui";
import { toast } from "@/lib/toast";
import { UserAvatar } from "@/components/UserAvatar";
import { CommunityScaffold } from "../_CommunityScaffold";
import { CollectionsDiscover } from "@/components/community/CollectionsDiscover";
import { CommunityEmptyState } from "../_CommunityEmptyState";
import { RouteCollectionVisibilityPill } from "@/components/RouteCollectionVisibilityPill";
import {
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_NAME_LENGTH,
  validateCollectionDescription,
  validateCollectionName,
  type RouteCollectionView,
} from "@/lib/route-collections";
import type { RouteCollectionVisibility } from "@/lib/api";
import { useFormat } from "@/format/FormatProvider";
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
  } = useCollections(userId);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<
    | {
        mode: "create";
      }
    | {
        mode: "edit";
        collection: RouteCollectionView;
      }
    | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<RouteCollectionView | null>(
    null,
  );
  const [unfollowTarget, setUnfollowTarget] =
    useState<RouteCollectionView | null>(null);
  const confirmUnfollow = async () => {
    const collection = unfollowTarget;
    if (!collection) return;
    setUnfollowTarget(null);
    try {
      await unfollowCollection(collection.id);
    } catch (err) {
      toast.error(
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
    if (modal.mode === "create") {
      const description = input.description.trim() || undefined;
      await createCollection({
        title: input.title.trim(),
        ...(description !== undefined ? { description } : {}),
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
  const confirmDelete = async () => {
    const collection = deleteTarget;
    if (!collection) return;
    setDeleteTarget(null);
    try {
      await removeCollection(collection.id);
    } catch (err) {
      toast.error(
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
    <CommunityScaffold
      collectionsBadge={
        status === "loading" && collections.length === 0 ? null : (
          <Mono className="text-[11px]">{collections.length}</Mono>
        )
      }
      headerRight={
        <Button
          variant="accent"
          uppercase
          leftIcon={<Plus size={14} />}
          onClick={() => setModal({ mode: "create" })}
        >
          {t("New collection")}
        </Button>
      }
    >
      <Toolbar search={search} onSearch={setSearch} />

      <div className="mt-5">
        <CollectionsDiscover search={search} />
      </div>

      <div className="mb-1 mt-10">
        <Stamp as="h2">{t("Your collections")}</Stamp>
      </div>

      {showSkeleton ? (
        <SkeletonGrid
          cards={3}
          label={t("Loading collections…")}
          className="mt-5 md:grid-cols-2"
        />
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
            {t("Couldn't load your collections")}
          </p>
          <p className="text-sm text-fg-dim mb-4">
            {errorMessage ?? "Try again in a moment."}
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            {t("Retry")}
          </Button>
        </div>
      ) : collections.length === 0 ? (
        <CommunityEmptyState
          icon={<FolderOpen size={18} strokeWidth={2} />}
          title={t("No collections yet")}
          body={t(
            "Curate your favourite roads into shareable lists. Follow collections from other riders to discover new regions.",
          )}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={t("No collections match your filters")}
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
              onDelete={() => setDeleteTarget(collection)}
            />
          ))}
        </div>
      )}

      {visibleFollowed.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-center gap-2">
            <Bookmark size={14} className="text-accent" />
            <Stamp as="h2">{t("Followed collections")}</Stamp>
            <span className="text-xs text-fg-dim">
              · {visibleFollowed.length}
              {needle && visibleFollowed.length !== followed.length
                ? ` of ${followed.length}`
                : ""}
            </span>
          </div>
          <p className="text-xs text-fg-dim mb-3">
            {t(
              "Collections from other riders you've saved. They show up here until you unfollow. ",
            )}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleFollowed.map((collection) => (
              <FollowedCollectionCard
                key={collection.id}
                collection={collection}
                onUnfollow={() => setUnfollowTarget(collection)}
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

      {deleteTarget && (
        <ConfirmDialog
          title={t("Delete collection")}
          message={`Delete "${deleteTarget.title}"? The routes inside won't be affected.`}
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {unfollowTarget && (
        <ConfirmDialog
          title={t("Stop following")}
          message={`Stop following "${unfollowTarget.title}"?`}
          confirmLabel="Unfollow"
          onConfirm={() => void confirmUnfollow()}
          onCancel={() => setUnfollowTarget(null)}
        />
      )}
    </CommunityScaffold>
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
      <Input
        value={search}
        onChange={onSearch}
        ariaLabel={t("Search collections")}
        placeholder={t("Search collections\u2026")}
        tone="cream"
        leadingIcon={<Search size={14} />}
      />
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
  const format = useFormat();
  const [menuOpen, setMenuOpen] = useState(false);
  // Distance + missing-count breakdowns deliberately live on the detail page,
  // not here. The list endpoint returns a summary (no per-item ids), so any
  // attempt to join against `useUserTrips` here would always read zero
  // present-trips and render a misleading "N unavailable" badge for every
  // non-empty collection. The simple `itemCount` is authoritative.
  return (
    <div
      data-menu-root
      className="relative rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
    >
      <Link
        href={`/community/collections/${collection.id}`}
        className="block p-5 pr-12 group"
      >
        <div className="flex items-start gap-2 mb-3">
          <h3 className="font-semibold text-ink group-hover:text-accent transition line-clamp-2 flex-1">
            {collection.title}
          </h3>
          <RouteCollectionVisibilityPill
            visibility={collection.visibility}
            className="shrink-0"
          />
        </div>

        {collection.description && (
          <p className="text-xs text-fg-dim line-clamp-2 mb-3">
            {collection.description}
          </p>
        )}

        <div className="flex items-center gap-2 text-sm text-fg-dim">
          <RouteIcon size={13} />
          <span>
            {collection.itemCount === 1
              ? t("1 route")
              : t("{count} routes", { count: collection.itemCount })}
          </span>
        </div>

        <p className="mt-3 text-[11px] text-fg-mute">
          {t("Updated")}
          {format.relativeTime(collection.updatedAt)}
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
        className="absolute top-3 right-3 p-1.5 rounded-lg text-fg-dim hover:text-ink hover:bg-paper transition"
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
  const format = useFormat();
  return (
    <div className="relative rounded-[14px] border border-line bg-cream transition hover:border-line-strong">
      <Link
        href={`/community/collections/shared/${encodeURIComponent(collection.slug)}`}
        className="block p-5 pr-12 group"
      >
        <div className="flex items-start gap-2 mb-3">
          <h3 className="font-semibold text-ink group-hover:text-accent transition line-clamp-2 flex-1">
            {collection.title}
          </h3>
          <RouteCollectionVisibilityPill
            visibility={collection.visibility}
            className="shrink-0"
          />
        </div>

        {collection.description && (
          <p className="text-xs text-fg-dim line-clamp-2 mb-3">
            {collection.description}
          </p>
        )}

        <div className="flex items-center gap-3 text-sm text-fg-dim">
          <span className="inline-flex items-center gap-1">
            <RouteIcon size={13} />
            <span>
              {collection.itemCount === 1
                ? t("1 route")
                : t("{count} routes", { count: collection.itemCount })}
            </span>
          </span>
          {collection.ownerName && (
            <span className="inline-flex items-center gap-1.5 text-fg-dim">
              <UserAvatar name={collection.ownerName} size={18} fontSize={9} />
              <span className="truncate">{collection.ownerName}</span>
            </span>
          )}
        </div>

        <p className="mt-3 text-[11px] text-fg-mute">
          {t("Updated")}
          {format.relativeTime(collection.updatedAt)}
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
        className="absolute top-3 right-3 p-1.5 rounded-lg text-fg-dim hover:text-red-400 hover:bg-paper transition"
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
  excludeId?: string | undefined;
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
      // Render the error inline inside the modal form so it's visible above
      // the modal overlay and stays put while the user fixes their input.
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-paper/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-md rounded-[14px] border border-line bg-cream p-5 shadow-xl"
      >
        <h2
          id="collection-modal-title"
          className="text-sm font-semibold text-ink mb-4"
        >
          {mode === "create" ? "New collection" : "Edit collection"}
        </h2>

        <div className="space-y-3">
          <div>
            <FieldLabel htmlFor="collection-name">{t("Name")}</FieldLabel>
            <Input
              id="collection-name"
              autoFocus
              value={title}
              onChange={(next) => {
                setTitle(next);
                setError(null);
              }}
              maxLength={MAX_COLLECTION_NAME_LENGTH + 10}
              placeholder={t("e.g. My Favourite Beskydy Loops")}
            />
          </div>
          <div>
            <FieldLabel htmlFor="collection-description">
              {t("Description")}{" "}
              <span className="text-fg-mute">{t("(optional)")}</span>
            </FieldLabel>
            <Textarea
              id="collection-description"
              value={description}
              onChange={(next) => {
                setDescription(next);
                setError(null);
              }}
              rows={3}
              maxLength={MAX_COLLECTION_DESCRIPTION_LENGTH + 10}
              placeholder={t("What makes this collection special?")}
            />
            <p className="mt-1 text-[11px] text-fg-mute">
              {description.length}/{MAX_COLLECTION_DESCRIPTION_LENGTH}
            </p>
          </div>

          <fieldset>
            <legend className="block text-xs text-fg-dim mb-2">
              {t("Visibility")}
            </legend>
            <RadioCardGroup
              name="collection-visibility"
              value={visibility}
              onChange={setVisibility}
              options={[
                {
                  value: "private",
                  label: "Private",
                  help: "Only you can see this collection.",
                },
                {
                  value: "unlisted",
                  label: "Unlisted",
                  help: "Anyone with the link can view. Not listed publicly.",
                },
                {
                  value: "public",
                  label: "Public",
                  help: "Anyone can find and view this collection.",
                },
              ]}
            />
          </fieldset>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={submitting} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            variant="accent"
            size="sm"
            uppercase
            loading={submitting}
          >
            {submitting
              ? t("Saving…")
              : mode === "create"
                ? t("Create")
                : t("Save")}
          </Button>
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
    <Card padded={false} className="mt-5 p-16 text-center">
      <FolderOpen size={48} className="mx-auto mb-4 text-fg-mute" />
      <p className="mb-2 text-lg text-fg-dim">{title}</p>
      <p className="mb-6 text-sm text-fg-dim">{body}</p>
      <Button
        variant="accent"
        size="sm"
        uppercase
        leftIcon={<Plus size={16} />}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </Card>
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
      className="absolute top-10 right-2 z-20 w-44 rounded-lg border border-line bg-paper shadow-xl py-1"
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
      : "text-ink hover:bg-paper";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 transition ${toneClass}`}
    >
      <span className="text-fg-dim">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-sm rounded-[14px] border border-line bg-paper p-6 shadow-xl">
        <h2
          id="confirm-dialog-title"
          className="text-lg font-semibold text-ink"
        >
          {title}
        </h2>
        <p id="confirm-dialog-message" className="mt-2 text-sm text-fg-dim">
          {message}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button ref={confirmRef} variant="danger-solid" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
