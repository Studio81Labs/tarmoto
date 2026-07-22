import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import {
  routeCollectionsApi,
  type CreateRouteCollectionInput,
  type UpdateRouteCollectionInput,
} from "@/lib/api";
import {
  mapDetailToView,
  mapSummaryToView,
  sortCollectionsByName,
  type RouteCollectionView,
} from "@/lib/route-collections";

export type CollectionsStatus = "idle" | "loading" | "ready" | "error";

export interface UseCollectionsResult {
  collections: RouteCollectionView[];
  /**
   * Collections the user has followed via the public/unlisted slug page,
   * sorted server-side by `followed_at desc`. The library page renders these
   * alongside `collections` so the user can act on saved collections from
   * other riders without leaving their dashboard.
   */
  followed: RouteCollectionView[];
  status: CollectionsStatus;
  errorMessage: string | null;
  refresh: () => Promise<void>;
  createCollection: (
    input: CreateRouteCollectionInput,
  ) => Promise<RouteCollectionView>;
  updateCollection: (
    id: string,
    input: UpdateRouteCollectionInput,
  ) => Promise<RouteCollectionView>;
  removeCollection: (id: string) => Promise<void>;
  unfollowCollection: (id: string) => Promise<void>;
}

interface LibraryCacheShape {
  owned: RouteCollectionView[];
  followed: RouteCollectionView[];
}

/**
 * Stable prefix for the cached library payload. Exported so flows
 * that mutate follow state outside this hook (e.g. the public
 * shared-collection page's `RouteCollectionFollowCta`) can drop the
 * cached library on success — without that, a 30-second `staleTime`
 * lets the library page render the pre-follow `followed` list when
 * the user navigates back from the share page.
 */
export const COLLECTIONS_LIBRARY_QUERY_PREFIX = [
  "collections",
  "library",
] as const;

const COLLECTIONS_LIBRARY_QUERY_KEY = (userId: string | null) =>
  [...COLLECTIONS_LIBRARY_QUERY_PREFIX, userId] as const;

const EMPTY_CACHE: LibraryCacheShape = { owned: [], followed: [] };

/**
 * Cloud-backed route collections (US-56). The library list is driven
 * by `@tanstack/react-query` — keyed by `userId`, so an account
 * switch can't show the previous user's library on the next mount.
 * Mutations write the new row directly into the cached owned list,
 * so the UI updates synchronously without waiting on a refetch.
 *
 * Pass `userId === null` to render an empty list (signed-out
 * visitors); the query is disabled.
 */
export function useCollections(userId: string | null): UseCollectionsResult {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const query = useQuery<LibraryCacheShape>({
    queryKey: COLLECTIONS_LIBRARY_QUERY_KEY(userId),
    enabled: userId != null,
    queryFn: async () => {
      // The library endpoint returns owned + followed in one
      // payload so the page never renders half the library while
      // waiting on the other half.
      const { data } = await routeCollectionsApi.listLibrary();
      return {
        owned: sortCollectionsByName(data.owned.map(mapSummaryToView)),
        // Server order (followed_at desc) — most-recently-saved
        // collection lands at the top.
        followed: data.followed.map(mapSummaryToView),
      };
    },
  });

  const writeCache = useCallback(
    (updater: (prev: LibraryCacheShape) => LibraryCacheShape) => {
      queryClient.setQueryData<LibraryCacheShape>(
        COLLECTIONS_LIBRARY_QUERY_KEY(userId),
        (prev) => updater(prev ?? EMPTY_CACHE),
      );
    },
    [queryClient, userId],
  );

  const refresh = useCallback(async () => {
    setErrorMessage(null);
    await queryClient.invalidateQueries({
      queryKey: COLLECTIONS_LIBRARY_QUERY_KEY(userId),
    });
  }, [queryClient, userId]);

  const replaceOne = useCallback(
    (next: RouteCollectionView) => {
      writeCache((prev) => ({
        ...prev,
        owned: sortCollectionsByName([
          ...prev.owned.filter((c) => c.id !== next.id),
          next,
        ]),
      }));
    },
    [writeCache],
  );

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
      writeCache((prev) => ({
        ...prev,
        owned: prev.owned.filter((c) => c.id !== id),
      }));
    },
    [writeCache],
  );

  const unfollowCollection = useCallback(
    async (id: string) => {
      // Optimistic drop — the unfollow endpoint is idempotent
      // (US-56) so a network failure won't leave the row in a
      // half-state. Capture the single dropped row (not the full
      // list) so a rapid second unfollow landing while the first is
      // in-flight doesn't see the closure restore an old snapshot
      // that re-adds rows another call has already removed.
      // Held as `.current` on a stable object so TypeScript's
      // control-flow analysis doesn't narrow the value back to
      // `null` after assignment inside the setQueryData callback.
      const removed: { current: RouteCollectionView | null } = {
        current: null,
      };
      writeCache((prev) => {
        const target = prev.followed.find((c) => c.id === id);
        if (!target) return prev;
        removed.current = target;
        return {
          ...prev,
          followed: prev.followed.filter((c) => c.id !== id),
        };
      });
      try {
        await routeCollectionsApi.unfollow(id);
      } catch (err) {
        const restored = removed.current;
        if (restored != null) {
          writeCache((prev) =>
            prev.followed.some((c) => c.id === restored.id)
              ? prev
              : { ...prev, followed: [...prev.followed, restored] },
          );
        }
        throw err;
      }
    },
    [writeCache],
  );

  const data = query.data ?? EMPTY_CACHE;
  const status: CollectionsStatus =
    userId == null
      ? "ready"
      : query.isLoading
        ? "loading"
        : query.isError
          ? "error"
          : "ready";

  return {
    collections: data.owned,
    followed: data.followed,
    status,
    errorMessage:
      errorMessage ??
      (query.isError
        ? getUserFacingErrorMessage(
            query.error,
            t("Failed to load route collections"),
          )
        : null),
    refresh,
    createCollection,
    updateCollection,
    removeCollection,
    unfollowCollection,
  };
}
