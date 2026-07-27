import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
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

const COLLECTIONS_LIBRARY_QUERY_KEY = (userId: string | null, locale: string) =>
  [...COLLECTIONS_LIBRARY_QUERY_PREFIX, userId, locale] as const;

const COLLECTIONS_LIBRARY_USER_QUERY_KEY = (userId: string | null) =>
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
  const locale = useFormat().locale;
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const query = useQuery<LibraryCacheShape>({
    queryKey: COLLECTIONS_LIBRARY_QUERY_KEY(userId, locale),
    enabled: userId != null,
    queryFn: async () => {
      // The library endpoint returns owned + followed in one
      // payload so the page never renders half the library while
      // waiting on the other half.
      const { data } = await routeCollectionsApi.listLibrary();
      return {
        owned: sortCollectionsByName(data.owned.map(mapSummaryToView), locale),
        // Server order (followed_at desc) — most-recently-saved
        // collection lands at the top.
        followed: data.followed.map(mapSummaryToView),
      };
    },
  });

  const writeUserCaches = useCallback(
    (
      updater: (
        prev: LibraryCacheShape,
        cacheLocale: string,
      ) => LibraryCacheShape,
    ) => {
      // Resolve the cache set when the mutation completes, not when its
      // callback was created. A regional-locale switch can mount a new cache
      // while a request is in flight; updating only the captured key would
      // leave the active library stale.
      const queries = queryClient.getQueryCache().findAll({
        queryKey: COLLECTIONS_LIBRARY_USER_QUERY_KEY(userId),
      });
      const queryKeys =
        queries.length > 0
          ? queries.map((query) => query.queryKey)
          : [COLLECTIONS_LIBRARY_QUERY_KEY(userId, locale)];

      for (const queryKey of queryKeys) {
        const cacheLocale =
          typeof queryKey[3] === "string" ? queryKey[3] : locale;
        queryClient.setQueryData<LibraryCacheShape>(queryKey, (prev) =>
          updater(prev ?? EMPTY_CACHE, cacheLocale),
        );
      }
    },
    [queryClient, userId, locale],
  );

  const cancelUserCacheFetches = useCallback(
    () =>
      queryClient.cancelQueries({
        queryKey: COLLECTIONS_LIBRARY_USER_QUERY_KEY(userId),
      }),
    [queryClient, userId],
  );

  const refresh = useCallback(async () => {
    setErrorMessage(null);
    await queryClient.invalidateQueries({
      queryKey: COLLECTIONS_LIBRARY_QUERY_KEY(userId, locale),
    });
  }, [queryClient, userId, locale]);

  const replaceOne = useCallback(
    async (next: RouteCollectionView) => {
      // A locale switch can start a list request before this mutation reaches
      // the server. Cancel it before writing so its stale response cannot land
      // afterward and undo the mutation result.
      await cancelUserCacheFetches();
      writeUserCaches((prev, cacheLocale) => ({
        ...prev,
        owned: sortCollectionsByName(
          [...prev.owned.filter((c) => c.id !== next.id), next],
          cacheLocale,
        ),
      }));
    },
    [cancelUserCacheFetches, writeUserCaches],
  );

  const createCollection = useCallback(
    async (input: CreateRouteCollectionInput) => {
      const { data } = await routeCollectionsApi.create(input);
      const view = mapDetailToView(data);
      await replaceOne(view);
      return view;
    },
    [replaceOne],
  );

  const updateCollection = useCallback(
    async (id: string, input: UpdateRouteCollectionInput) => {
      const { data } = await routeCollectionsApi.update(id, input);
      const view = mapDetailToView(data);
      await replaceOne(view);
      return view;
    },
    [replaceOne],
  );

  const removeCollection = useCallback(
    async (id: string) => {
      await routeCollectionsApi.delete(id);
      await cancelUserCacheFetches();
      writeUserCaches((prev) => ({
        ...prev,
        owned: prev.owned.filter((c) => c.id !== id),
      }));
    },
    [cancelUserCacheFetches, writeUserCaches],
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
      const removeFromCaches = () =>
        writeUserCaches((prev) => {
          const target = prev.followed.find((c) => c.id === id);
          if (!target) return prev;
          removed.current = target;
          return {
            ...prev,
            followed: prev.followed.filter((c) => c.id !== id),
          };
        });
      await cancelUserCacheFetches();
      removeFromCaches();
      try {
        await routeCollectionsApi.unfollow(id);
        // A locale cache may have been created after the optimistic write.
        await cancelUserCacheFetches();
        removeFromCaches();
      } catch (err) {
        const restored = removed.current;
        if (restored != null) {
          await cancelUserCacheFetches();
          writeUserCaches((prev) =>
            prev.followed.some((c) => c.id === restored.id)
              ? prev
              : { ...prev, followed: [...prev.followed, restored] },
          );
        }
        throw err;
      }
    },
    [cancelUserCacheFetches, writeUserCaches],
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
