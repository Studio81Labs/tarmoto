/**
 * Route collections (US-56) — cloud-backed CRUD over the server's id-keyed
 * item rows. Collections hold recorded rides only; trips are private and
 * collaborator-only, so they are never surfaced here.
 *
 * `mapDetailToView` is the single boundary between server DTOs and the
 * `RouteCollectionView` shape consumed by the pages and hook.
 */

import { DEFAULT_LOCALE, normalizeForLocaleSearch } from "@tarmoto/shared";
import type { Translate } from "@/i18n";
import {
  type RouteCollectionDetail,
  type RouteCollectionSummary,
  type RouteCollectionVisibility,
} from "@/lib/api";

export type { RouteCollectionVisibility };

export interface CollectionRideRef {
  /** Server-assigned join-row id; required for `removeItem`. */
  itemId: string;
  /** Server-assigned position; preserved for ordering. */
  position: number;
  /** The referenced ride uuid. */
  rideId: string;
}

export interface RouteCollectionView {
  id: string;
  /**
   * Owner uuid, or `null` when the owning rider has set
   * `profile_visibility = 'private'` and the viewer is not the
   * owner. Masked alongside `ownerName` (#279 / #501) so a
   * "Hidden curator" surface can't deep-link to the rider's
   * profile via the id.
   */
  ownerId: string | null;
  ownerName: string;
  title: string;
  description: string | null;
  visibility: RouteCollectionVisibility;
  slug: string;
  /** Ride refs in server position order. Includes `itemId` for delete. */
  rideRefs: CollectionRideRef[];
  /** Convenience derived list — the existing UI binds to `rideIds`. */
  rideIds: string[];
  itemCount: number;
  /**
   * Riders following this collection. Carries the real count for
   * detail-sourced views (`mapDetailToView`); 0 for summary-sourced list
   * views, which never render it (the summary DTO omits the field).
   */
  followerCount: number;
  createdAt: string;
  updatedAt: string;
}

export const MAX_COLLECTION_NAME_LENGTH = 80;
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 500;

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCollectionName(
  name: string,
  collections: readonly { id: string; title: string }[],
  t: Translate,
  excludeId?: string,
  locale: string = DEFAULT_LOCALE,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("Collection name is required");
  if (trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    return t("Collection name must be {max} characters or fewer", {
      max: MAX_COLLECTION_NAME_LENGTH,
    });
  }
  const normalized = normalizeForLocaleSearch(trimmed, locale);
  const clash = collections.some(
    (collection) =>
      collection.id !== excludeId &&
      normalizeForLocaleSearch(collection.title, locale) === normalized,
  );
  if (clash) return t("A collection with that name already exists");
  return null;
}

export function validateCollectionDescription(
  description: string | undefined,
  t: Translate,
): string | null {
  if (description === undefined) return null;
  // Trim to match what `createCollection`/`updateCollection` actually store —
  // otherwise trailing whitespace could be rejected even though the persisted
  // value would fit within the limit.
  const trimmed = description.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_COLLECTION_DESCRIPTION_LENGTH) {
    return t("Description must be {max} characters or fewer", {
      max: MAX_COLLECTION_DESCRIPTION_LENGTH,
    });
  }
  return null;
}

// ── Server <-> view mapping ─────────────────────────────────────────────────

export function mapDetailToView(
  detail: RouteCollectionDetail,
): RouteCollectionView {
  const rideRefs: CollectionRideRef[] = detail.items
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      itemId: item.id,
      position: item.position,
      rideId: item.ride_id,
    }));

  return {
    id: detail.id,
    ownerId: detail.owner_id,
    ownerName: detail.owner_name ?? "",
    title: detail.title,
    description: detail.description,
    visibility: detail.visibility,
    slug: detail.slug,
    rideRefs,
    rideIds: rideRefs.map((r) => r.rideId),
    itemCount: detail.item_count,
    followerCount: detail.follower_count,
    createdAt: detail.created_at,
    updatedAt: detail.updated_at,
  };
}

export function mapSummaryToView(
  summary: RouteCollectionSummary,
): RouteCollectionView {
  return {
    id: summary.id,
    ownerId: summary.owner_id,
    // The summary endpoint populates `owner_name` for other riders' collections
    // (e.g. the followed list); the rider's own list returns `null` since the
    // UI never surfaces the caller's own name.
    ownerName: summary.owner_name ?? "",
    title: summary.title,
    description: summary.description,
    visibility: summary.visibility,
    slug: summary.slug,
    rideRefs: [],
    rideIds: [],
    itemCount: summary.item_count,
    // Summary DTO omits follower_count; list views never render it.
    followerCount: 0,
    createdAt: summary.created_at,
    updatedAt: summary.updated_at,
  };
}

/**
 * Move an array element from `from` to `to`, returning a new array. The
 * `position` field on each ref is left untouched — the server will renumber
 * 0..N-1 after the reorder PATCH succeeds. We rebuild the view from the
 * server response on success, so per-ref `position` only matters for sort
 * stability while the request is in flight.
 *
 * Returns the same array instance when the move is a no-op (out-of-range
 * indices or identical positions) so React can skip a re-render.
 */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items as T[];
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Build the `item_ids` payload for `PATCH /collections/:id/items/reorder`
 * from a view, in the on-screen (ride) order.
 */
export function reorderPayload(view: RouteCollectionView): string[] {
  return view.rideRefs.map((r) => r.itemId);
}

export function sortCollectionsByName<T extends { title: string }>(
  collections: readonly T[],
  locale: string,
): T[] {
  return collections
    .slice()
    .sort((a, b) =>
      a.title.localeCompare(b.title, locale, { sensitivity: "base" }),
    );
}
