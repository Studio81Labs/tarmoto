import { useEffect, useState } from "react";
import {
  loadCollections,
  saveCollections,
  sortCollectionsByName,
  type StoredRouteCollection,
} from "@/lib/route-collections";

/**
 * Loads the signed-in user's route collections from localStorage and exposes
 * a `persist` helper that sorts and writes back through `saveCollections`.
 *
 * Both collection pages need the same hydrate-then-mutate pattern, so it
 * lives here to prevent the same drift that prompted `useUserTrips`. When a
 * backend `/collections` endpoint ships, this hook is the single place to
 * swap storage.
 *
 * Pass `userId === null` to render an empty list (e.g. signed-out visitors).
 *
 * `hydrated` flips to `true` once the first `userId`-driven load has run, so
 * detail pages can wait before deciding a collection is missing — otherwise
 * the empty initial state would flash "not found" on every navigation.
 */
export function useCollections(userId: string | null): {
  collections: StoredRouteCollection[];
  hydrated: boolean;
  persist: (next: readonly StoredRouteCollection[]) => void;
} {
  const [collections, setCollections] = useState<StoredRouteCollection[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!userId) {
      setCollections([]);
      setHydrated(true);
      return;
    }
    setCollections(sortCollectionsByName(loadCollections(userId)));
    setHydrated(true);
  }, [userId]);

  const persist = (next: readonly StoredRouteCollection[]) => {
    const sorted = sortCollectionsByName(next);
    setCollections(sorted);
    if (userId) saveCollections(userId, sorted);
  };

  return { collections, hydrated, persist };
}
