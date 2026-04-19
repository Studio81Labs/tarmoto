/**
 * Route collections (US-56) — client-side metadata with localStorage
 * persistence.
 *
 * Collections are a user-local grouping of existing trips (routes). The
 * backend has no `/collections` endpoint yet, so — mirroring trip-folders —
 * the collection row (id → name, description, visibility, tripIds) lives in
 * localStorage keyed per user. The member trips themselves are server state
 * fetched via `tripsApi`. When the backend ships a collections endpoint this
 * module can switch storage without touching consumers.
 *
 * Deliberately named `StoredRouteCollection` to avoid colliding with the
 * server-shaped `RouteCollection` DTO in `@/lib/types.ts`, which embeds full
 * `Trip[]` and rider metadata instead of just `tripIds`.
 */

export interface StoredRouteCollection {
  id: string;
  name: string;
  description?: string;
  isPublic: boolean;
  tripIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionInput {
  name: string;
  description?: string;
  isPublic: boolean;
}

const STORAGE_PREFIX = "tarmoto:route-collections:";

export const MAX_COLLECTION_NAME_LENGTH = 80;
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 500;

export function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function loadCollections(userId: string): StoredRouteCollection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCollection);
  } catch {
    return [];
  }
}

export function saveCollections(
  userId: string,
  collections: readonly StoredRouteCollection[],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify(collections),
    );
  } catch {
    // Quota or private-mode failures are non-fatal; collections simply won't
    // persist across sessions. The in-memory state still works.
  }
}

function isCollection(value: unknown): value is StoredRouteCollection {
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

export function validateCollectionName(
  name: string,
  collections: readonly StoredRouteCollection[],
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Collection name is required";
  if (trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    return `Collection name must be ${MAX_COLLECTION_NAME_LENGTH} characters or fewer`;
  }
  const lower = trimmed.toLowerCase();
  const clash = collections.some(
    (c) => c.id !== excludeId && c.name.trim().toLowerCase() === lower,
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

export function createCollection(
  input: CollectionInput,
  now: Date = new Date(),
): StoredRouteCollection {
  const trimmedDescription = input.description?.trim();
  return {
    id: generateCollectionId(now),
    name: input.name.trim(),
    description: trimmedDescription ? trimmedDescription : undefined,
    isPublic: input.isPublic,
    tripIds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function updateCollection(
  collections: readonly StoredRouteCollection[],
  id: string,
  input: CollectionInput,
  now: Date = new Date(),
): StoredRouteCollection[] {
  return collections.map((c) => {
    if (c.id !== id) return c;
    const trimmedDescription = input.description?.trim();
    return {
      ...c,
      name: input.name.trim(),
      description: trimmedDescription ? trimmedDescription : undefined,
      isPublic: input.isPublic,
      updatedAt: now.toISOString(),
    };
  });
}

export function removeCollection(
  collections: readonly StoredRouteCollection[],
  id: string,
): StoredRouteCollection[] {
  return collections.filter((c) => c.id !== id);
}

export function addTripsToCollection(
  collections: readonly StoredRouteCollection[],
  id: string,
  tripIds: readonly string[],
  now: Date = new Date(),
): StoredRouteCollection[] {
  return collections.map((c) => {
    if (c.id !== id) return c;
    // De-dup while preserving insertion order so added-last routes show up at
    // the end rather than silently shuffling existing positions.
    const seen = new Set(c.tripIds);
    const added: string[] = [];
    for (const tid of tripIds) {
      if (!seen.has(tid)) {
        seen.add(tid);
        added.push(tid);
      }
    }
    if (added.length === 0) return c;
    return {
      ...c,
      tripIds: [...c.tripIds, ...added],
      updatedAt: now.toISOString(),
    };
  });
}

export function removeTripFromCollection(
  collections: readonly StoredRouteCollection[],
  id: string,
  tripId: string,
  now: Date = new Date(),
): StoredRouteCollection[] {
  return collections.map((c) => {
    if (c.id !== id) return c;
    if (!c.tripIds.includes(tripId)) return c;
    return {
      ...c,
      tripIds: c.tripIds.filter((t) => t !== tripId),
      updatedAt: now.toISOString(),
    };
  });
}

export function sortCollectionsByName(
  collections: readonly StoredRouteCollection[],
): StoredRouteCollection[] {
  return collections
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

// Short time-based id with a random suffix — unique enough for client-local
// metadata.
function generateCollectionId(now: Date): string {
  const ts = now.getTime().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `col_${ts}_${rand}`;
}
