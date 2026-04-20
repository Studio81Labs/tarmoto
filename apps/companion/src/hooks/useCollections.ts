import { useEffect, useRef, useState } from "react";
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
 *
 * On `userId` change we reset state *before* reading the new user's data so
 * a sign-out/account-switch doesn't momentarily expose the previous user's
 * collections (or let `persist` write them into the new user's slot).
 */
export function useCollections(userId: string | null): {
  collections: StoredRouteCollection[];
  hydrated: boolean;
  persist: (next: readonly StoredRouteCollection[]) => void;
} {
  const [collections, setCollections] = useState<StoredRouteCollection[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Track the userId the in-memory state is associated with. `persist` reads
  // this instead of the effect-closed `userId` so a write that races with an
  // account switch can't slip into the new account's storage slot.
  const activeUserIdRef = useRef<string | null>(userId);

  useEffect(() => {
    activeUserIdRef.current = userId;
    setHydrated(false);
    setCollections([]);
    if (!userId) {
      setHydrated(true);
      return;
    }
    setCollections(sortCollectionsByName(loadCollections(userId)));
    setHydrated(true);
  }, [userId]);

  const persist = (next: readonly StoredRouteCollection[]) => {
    const sorted = sortCollectionsByName(next);
    setCollections(sorted);
    const owner = activeUserIdRef.current;
    if (owner) saveCollections(owner, sorted);
  };

  return { collections, hydrated, persist };
}
