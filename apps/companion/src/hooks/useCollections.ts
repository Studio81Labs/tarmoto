import { useCallback, useEffect, useRef, useState } from "react";
import {
  routeCollectionsApi,
  type CreateRouteCollectionInput,
  type UpdateRouteCollectionInput,
} from "@/lib/api";
import {
  isMigrationDone,
  mapDetailToView,
  mapSummaryToView,
  migrateLegacyCollections,
  migrationDoneKey,
  readLegacyCollections,
  sortCollectionsByName,
  type RouteCollectionView,
} from "@/lib/route-collections";

export type CollectionsStatus = "idle" | "loading" | "ready" | "error";

export interface MigrationOpportunity {
  /** How many legacy collections we found in localStorage. */
  count: number;
  /** Promise resolver — call once the user accepts/declines. */
  accept: () => Promise<void>;
  decline: () => void;
}

export interface UseCollectionsResult {
  collections: RouteCollectionView[];
  status: CollectionsStatus;
  errorMessage: string | null;
  /** Reload the list from the server. */
  refresh: () => Promise<void>;
  createCollection: (
    input: CreateRouteCollectionInput,
  ) => Promise<RouteCollectionView>;
  updateCollection: (
    id: string,
    input: UpdateRouteCollectionInput,
  ) => Promise<RouteCollectionView>;
  removeCollection: (id: string) => Promise<void>;
  /**
   * If the user has legacy localStorage collections AND has not yet been
   * prompted, this is non-null and the page can render a banner asking the
   * user to opt into migration. The hook does NOT auto-migrate — that's the
   * "user opt-in" gate from the issue.
   */
  migration: MigrationOpportunity | null;
}

/**
 * Cloud-backed route collections (US-56). Mirrors the previous localStorage
 * hook's shape (`refresh`, mutators) but every call hits the backend. The
 * `migration` field surfaces a one-time, user-confirmed import of the legacy
 * localStorage row into the new endpoint.
 *
 * Pass `userId === null` to render an empty list (e.g. signed-out visitors).
 */
export function useCollections(userId: string | null): UseCollectionsResult {
  const [collections, setCollections] = useState<RouteCollectionView[]>([]);
  const [status, setStatus] = useState<CollectionsStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [migration, setMigration] = useState<MigrationOpportunity | null>(null);

  // Track the userId the in-memory state belongs to so a refresh that lands
  // after an account switch doesn't write the previous user's data into the
  // new view (mirrors the guard the legacy hook had against localStorage).
  const activeUserIdRef = useRef<string | null>(userId);
  activeUserIdRef.current = userId;

  const replaceOne = useCallback((next: RouteCollectionView) => {
    setCollections((prev) => {
      const without = prev.filter((c) => c.id !== next.id);
      return sortCollectionsByName([...without, next]);
    });
  }, []);

  const removeOne = useCallback((id: string) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    const owner = activeUserIdRef.current;
    if (!owner) {
      setCollections([]);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    try {
      const { data } = await routeCollectionsApi.listMine();
      // Drop the result if the user has switched accounts mid-flight.
      if (activeUserIdRef.current !== owner) return;
      setCollections(sortCollectionsByName(data.items.map(mapSummaryToView)));
      setStatus("ready");
    } catch (err) {
      if (activeUserIdRef.current !== owner) return;
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load route collections",
      );
    }
  }, []);

  const createCollection = useCallback(
    async (input: CreateRouteCollectionInput) => {
      const { data } = await routeCollectionsApi.create(input);
      const view = mapDetailToView(data);
      replaceOne(view);
      return view;
    },
    [replaceOne],
  );

  const updateCollection = useCallback(
    async (id: string, input: UpdateRouteCollectionInput) => {
      const { data } = await routeCollectionsApi.update(id, input);
      const view = mapDetailToView(data);
      replaceOne(view);
      return view;
    },
    [replaceOne],
  );

  const removeCollection = useCallback(
    async (id: string) => {
      await routeCollectionsApi.delete(id);
      removeOne(id);
    },
    [removeOne],
  );

  // Item-level mutations (add/remove trip) live on the detail page rather
  // than this hook. The detail page already loads /collections/:id and
  // owns the item state — routing those calls through the hook would just
  // round-trip them via this hook's `collections` list, which the list
  // page doesn't render anyway.

  // Initial load + migration-opportunity check whenever userId changes.
  useEffect(() => {
    setCollections([]);
    setMigration(null);
    if (!userId) {
      setStatus("ready");
      setErrorMessage(null);
      return;
    }
    void refresh();

    // Migration prompt: only surface if the legacy key has data AND we haven't
    // already migrated (or skipped) for this user. Storage helpers are no-ops
    // server-side; readLegacyCollections returns [] there.
    if (!isMigrationDone(userId)) {
      const legacy = readLegacyCollections(userId);
      if (legacy.length > 0) {
        setMigration({
          count: legacy.length,
          accept: async () => {
            const result = await migrateLegacyCollections(userId);
            // Merge migrated collections into the view; refresh anyway in case
            // listMine is the source of truth (e.g. legacy row had odd data).
            await refresh();
            if (result.errorMessage) {
              setErrorMessage(result.errorMessage);
            }
            setMigration(null);
          },
          decline: () => {
            // Mark as done so we don't keep prompting; legacy data stays in
            // localStorage in case the user changes their mind via dev tools.
            try {
              if (typeof window !== "undefined") {
                window.localStorage.setItem(migrationDoneKey(userId), "1");
              }
            } catch {
              // Quota / private mode — best-effort.
            }
            setMigration(null);
          },
        });
      }
    }
  }, [userId, refresh]);

  return {
    collections,
    status,
    errorMessage,
    refresh,
    createCollection,
    updateCollection,
    removeCollection,
    migration,
  };
}
