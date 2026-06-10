/**
 * Route collections (US-56) — cloud-backed CRUD with a one-time migration of
 * the legacy localStorage shape that shipped while the backend lacked a
 * `/collections` endpoint.
 *
 * The companion view is denormalised onto the server's id-keyed item rows so
 * existing UI (which thinks in `tripIds: string[]`) keeps working untouched.
 * `mapDetailToView` is the single boundary between server DTOs and the
 * `RouteCollectionView` shape consumed by the pages and hook.
 */

import {
  routeCollectionsApi,
  type RouteCollectionDetail,
  type RouteCollectionSummary,
  type RouteCollectionVisibility,
} from "@/lib/api";

export type { RouteCollectionVisibility };

export interface CollectionTripRef {
  /** Server-assigned join-row id; required for `removeItem`. */
  itemId: string;
  /** Server-assigned position; preserved for ordering. */
  position: number;
  /** The referenced trip uuid. */
  tripId: string;
}

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
  /** Trip refs in server position order. Includes `itemId` for delete. */
  tripRefs: CollectionTripRef[];
  /** Convenience derived list — the existing UI binds to `tripIds`. */
  tripIds: string[];
  /** Ride refs in server position order. Includes `itemId` for delete. */
  rideRefs: CollectionRideRef[];
  /** Convenience derived list, mirrors `tripIds`. */
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
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Collection name is required";
  if (trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    return `Collection name must be ${MAX_COLLECTION_NAME_LENGTH} characters or fewer`;
  }
  const lower = trimmed.toLowerCase();
  const clash = collections.some(
    (c) => c.id !== excludeId && c.title.trim().toLowerCase() === lower,
  );
  if (clash) return "A collection with that name already exists";
  return null;
}

export function validateCollectionDescription(
  description: string | undefined,
): string | null {
  if (description === undefined) return null;
  // Trim to match what `createCollection`/`updateCollection` actually store —
  // otherwise trailing whitespace could be rejected even though the persisted
  // value would fit within the limit.
  const trimmed = description.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_COLLECTION_DESCRIPTION_LENGTH) {
    return `Description must be ${MAX_COLLECTION_DESCRIPTION_LENGTH} characters or fewer`;
  }
  return null;
}

// ── Server <-> view mapping ─────────────────────────────────────────────────

export function mapDetailToView(
  detail: RouteCollectionDetail,
): RouteCollectionView {
  // The DB CHECK enforces XOR, so each item is either trip-keyed or ride-
  // keyed. Split into the two ref lists, each independently ordered by
  // position so trip-only and ride-only consumers (the picker tabs, the
  // public-page list) keep stable rendering.
  const sortedItems = detail.items
    .slice()
    .sort((a, b) => a.position - b.position);

  const tripRefs: CollectionTripRef[] = [];
  const rideRefs: CollectionRideRef[] = [];
  for (const item of sortedItems) {
    if (typeof item.trip_id === "string") {
      tripRefs.push({
        itemId: item.id,
        position: item.position,
        tripId: item.trip_id,
      });
    } else if (typeof item.ride_id === "string") {
      rideRefs.push({
        itemId: item.id,
        position: item.position,
        rideId: item.ride_id,
      });
    }
  }

  return {
    id: detail.id,
    ownerId: detail.owner_id,
    ownerName: detail.owner_name ?? "",
    title: detail.title,
    description: detail.description,
    visibility: detail.visibility,
    slug: detail.slug,
    tripRefs,
    tripIds: tripRefs.map((r) => r.tripId),
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
    tripRefs: [],
    tripIds: [],
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
 * from a view. Order matches the on-screen layout (trips above rides on the
 * owner page) so the public page — which lists items in raw position order
 * — reflects what the user just saw.
 */
export function reorderPayload(view: RouteCollectionView): string[] {
  return [
    ...view.tripRefs.map((r) => r.itemId),
    ...view.rideRefs.map((r) => r.itemId),
  ];
}

export function sortCollectionsByName<T extends { title: string }>(
  collections: readonly T[],
): T[] {
  return collections
    .slice()
    .sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    );
}

// ── Legacy localStorage migration ───────────────────────────────────────────

/**
 * Pre-server localStorage shape. Kept as a type-only declaration so the
 * runtime never accidentally creates one — the in-memory view uses
 * `RouteCollectionView` instead.
 */
export interface LegacyStoredRouteCollection {
  id: string;
  name: string;
  description?: string;
  isPublic: boolean;
  tripIds: string[];
  createdAt: string;
  updatedAt: string;
}

const LEGACY_STORAGE_PREFIX = "tarmoto:route-collections:";
const MIGRATION_DONE_PREFIX = "tarmoto:route-collections-migrated:";

export function legacyStorageKey(userId: string): string {
  return `${LEGACY_STORAGE_PREFIX}${userId}`;
}

export function migrationDoneKey(userId: string): string {
  return `${MIGRATION_DONE_PREFIX}${userId}`;
}

/**
 * Reads legacy collections from localStorage. Returns an empty array on the
 * server, when storage is unavailable, or when the stored value isn't an
 * array — same forgiving semantics the previous loader had so a corrupted
 * key never blocks the user from seeing the page.
 */
export function readLegacyCollections(
  userId: string,
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): LegacyStoredRouteCollection[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(legacyStorageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLegacyCollection);
  } catch {
    return [];
  }
}

export function clearLegacyCollections(
  userId: string,
  storage: Pick<Storage, "removeItem" | "setItem"> | null = typeof window ===
  "undefined"
    ? null
    : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.removeItem(legacyStorageKey(userId));
    storage.setItem(migrationDoneKey(userId), "1");
  } catch {
    // Quota or private-mode failures are non-fatal — at worst the user is
    // re-prompted next session, which the migration helper guards against
    // with the `read-vs-write` symmetry on the same key.
  }
}

export function isMigrationDone(
  userId: string,
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(migrationDoneKey(userId)) === "1";
  } catch {
    return false;
  }
}

export interface MigrationResult {
  attempted: number;
  migrated: number;
  failed: number;
  /** New cloud collections, ready to be merged into the in-memory view. */
  collections: RouteCollectionView[];
  /** First failure message, surfaced to the user inline; nulls = all clean. */
  errorMessage: string | null;
}

interface MigrateOptions {
  /** Injectable for tests so we don't hit network. */
  client?: typeof routeCollectionsApi;
  /** Injectable storage for tests; defaults to `window.localStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/**
 * Best-effort migration: each legacy row becomes a server-side collection,
 * then each tripId is added as an item. Per-collection errors are swallowed
 * so a single 500 doesn't block the rest. The legacy key is cleared only if
 * we attempted at least one migration AND the user wasn't entirely offline
 * (i.e. at least one collection was created) — otherwise we leave the key
 * alone so the user can retry next session.
 */
export async function migrateLegacyCollections(
  userId: string,
  {
    client = routeCollectionsApi,
    storage = pickStorage(),
  }: MigrateOptions = {},
): Promise<MigrationResult> {
  const legacy = readLegacyCollections(userId, storage ?? null);
  const result: MigrationResult = {
    attempted: legacy.length,
    migrated: 0,
    failed: 0,
    collections: [],
    errorMessage: null,
  };
  if (legacy.length === 0) {
    if (storage) clearLegacyCollections(userId, storage);
    return result;
  }

  for (const row of legacy) {
    try {
      const created = (
        await client.create({
          title: truncate(row.name.trim(), MAX_COLLECTION_NAME_LENGTH),
          description: row.description?.trim() || undefined,
          visibility: row.isPublic ? "unlisted" : "private",
        })
      ).data;

      // Add trip items in original order. Failures here don't roll back the
      // collection — a partially-migrated collection is still better than no
      // collection, and the user can re-add manually.
      const tripIds: string[] = [];
      for (const tripId of row.tripIds) {
        try {
          await client.addItem(created.id, { trip_id: tripId });
          tripIds.push(tripId);
        } catch (err) {
          // We don't need to log every individual item failure — they are
          // typically deleted trips that the UI already labels as
          // "unavailable". The user can prune them via the detail page.
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[migration] failed to add legacy trip ${tripId} to ${created.id}`,
              err,
            );
          }
        }
      }

      // Re-fetch detail so we have the canonical positions/itemIds.
      try {
        const refreshed = (await client.get(created.id)).data;
        result.collections.push(mapDetailToView(refreshed));
      } catch {
        // Fall back to a synthesised view from the create response if the
        // refresh fails — better than dropping the migrated collection.
        result.collections.push(mapDetailToView(created));
      }
      result.migrated += 1;
    } catch (err) {
      result.failed += 1;
      if (result.errorMessage == null) {
        result.errorMessage =
          err instanceof Error ? err.message : "Failed to migrate collection";
      }
    }
  }

  // Only clear local storage if at least one migration succeeded — leaving
  // the legacy data in place lets the user retry on a flaky-network session
  // instead of silently losing their preferences.
  if (result.migrated > 0 && storage) {
    clearLegacyCollections(userId, storage);
  }

  return result;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function pickStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function isLegacyCollection(
  value: unknown,
): value is LegacyStoredRouteCollection {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.isPublic === "boolean" &&
    Array.isArray(c.tripIds) &&
    c.tripIds.every((id) => typeof id === "string") &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string" &&
    (c.description === undefined || typeof c.description === "string")
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
