"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Bookmark, BookmarkCheck, Settings2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, MetricTile, Mono, Stamp } from "@tarmoto/ui";
import { useAuthStore } from "@/stores/auth";
import {
  ApiError,
  routeCollectionsApi,
  type RouteCollectionDetail,
  type RouteCollectionPreviewItem,
} from "@/lib/api";
import {
  COLLECTION_VISIBILITY_LABELS,
  RouteCollectionVisibilityPill,
} from "@/components/RouteCollectionVisibilityPill";
import { UserAvatar } from "@/components/UserAvatar";
import { CollectionRouteRow } from "@/components/community/collection-route-atoms";
import { CollectionPreviewMap } from "@/components/community/CollectionPreviewMap";
import { COLLECTIONS_LIBRARY_QUERY_PREFIX } from "@/hooks/useCollections";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { formatRelativeTimeLabel } from "@tarmoto/shared";

type LoadState =
  | { phase: "loading" }
  | {
      phase: "ready";
      detail: RouteCollectionDetail;
      routes: RouteCollectionPreviewItem[];
    }
  | { phase: "not-found" }
  | { phase: "error"; message: string };

/**
 * In-app, read-only view of a collection a member discovered. Reuses the
 * collection-detail layout (header + metric tiles + map + route rows) but drops
 * every owner-edit affordance — visibility editing, add-routes, reorder,
 * delete — and offers a Follow / Unfollow toggle instead. Loads by slug
 * (`getBySlug`, optional-auth) so a non-owner can read a public/unlisted
 * collection; the owner-by-id detail page (`/[collectionId]`) stays the edit
 * surface, and the standalone `/shared/[slug]` page stays for anonymous links.
 */
export default function DiscoverCollectionPage() {
  const t = useTranslation();
  const format = useFormat();
  // With the other hooks: there are early returns below, and a hook after one
  // changes hook order between renders (the mistake #1202 shipped).
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const { slug } = useParams<{ slug: string }>();
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const queryClient = useQueryClient();
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [following, setFollowing] = useState(false);
  const [followPending, setFollowPending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const reload = useCallback(
    async (s: string) => {
      try {
        const [detailRes, previewRes] = await Promise.all([
          routeCollectionsApi.getBySlug(s),
          routeCollectionsApi.getPreviewBySlug(s),
        ]);
        const detail = detailRes.data;
        const routes = [...previewRes.data.routes].sort(
          (a, b) => a.position - b.position,
        );
        setLoad({ phase: "ready", detail, routes });
        setFollowing(detail.viewer_is_following);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setLoad({ phase: "not-found" });
          return;
        }
        setLoad({
          phase: "error",
          message: getUserFacingErrorMessage(
            err,
            t("Failed to load collection"),
          ),
        });
      }
    },
    [t],
  );

  // Gate on the access token hydrating so the first fetch is authenticated and
  // `viewer_is_owner` / `viewer_is_following` are personalised on load. Same
  // pattern as the owner detail page.
  useEffect(() => {
    if (!slug || !authReady) return;
    setLoad({ phase: "loading" });
    void reload(slug);
  }, [slug, authReady, reload]);

  const detail = load.phase === "ready" ? load.detail : null;

  const onToggleFollow = async () => {
    if (!detail || followPending) return;
    setFollowPending(true);
    setFollowError(null);
    const previous = following;
    setFollowing(!previous);
    try {
      if (previous) {
        await routeCollectionsApi.unfollow(detail.id);
      } else {
        await routeCollectionsApi.follow(detail.id);
      }
      await queryClient.invalidateQueries({
        queryKey: COLLECTIONS_LIBRARY_QUERY_PREFIX,
      });
    } catch (err) {
      setFollowing(previous);
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? t("This collection is no longer available.")
            : err.status === 400
              ? t("You can't follow your own collection.")
              : getUserFacingErrorMessage(err, t("Something went wrong."))
          : getUserFacingErrorMessage(err, t("Something went wrong."));
      setFollowError(message);
    } finally {
      setFollowPending(false);
    }
  };

  if (load.phase === "loading") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <div className="h-8 w-48 animate-pulse rounded bg-paper" />
        <div className="mt-4 h-[140px] animate-pulse rounded-[14px] bg-paper" />
      </div>
    );
  }
  if (load.phase === "not-found") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <BackLink />
        <p className="mt-8 text-center text-sm text-fg-dim">
          {t("This collection is private or no longer available.")}
        </p>
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
        <BackLink />
        <p role="alert" className="mt-8 text-center text-sm text-quality-q1">
          {t("Couldn't load this collection right now.")}
        </p>
      </div>
    );
  }

  const { routes } = load;
  // Strip client-side rather than gating inside `CollectionRouteRow`: that row
  // also renders on the SERVER for the public shared collection route, so it
  // must stay hook-free. The shared route strips the same field server-side
  // (#1201); this is the client-rendered half of the same rule.
  const visibleRoutes = qualityEnabled
    ? routes
    : routes.map(({ quality_avg: _dropped, ...rest }) => rest);
  const ownerName = detail!.owner_name || "";
  const author = ownerName || (detail!.viewer_is_owner ? t("You") : "");
  const totalKm = routes.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  // Value + unit from the SAME split call — pairing a unit-preference-aware
  // value with a hardcoded "KM" label would mislabel a miles figure for an
  // imperial viewer.

  return (
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <BackLink />

      <header className="mb-5 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="break-words font-sans text-[32px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {detail!.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-fg-dim">
            <RouteCollectionVisibilityPill
              visibility={detail!.visibility}
              label={t(COLLECTION_VISIBILITY_LABELS[detail!.visibility])}
            />
            {ownerName && (
              <>
                <span className="text-fg-mute">·</span>
                {detail!.owner_id ? (
                  <Link
                    href={`/community/${encodeURIComponent(detail!.owner_id)}`}
                    className="inline-flex items-center gap-1.5 transition hover:text-ink"
                  >
                    <UserAvatar name={ownerName} size={20} fontSize={10} />
                    {ownerName}
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <UserAvatar name={ownerName} size={20} fontSize={10} />
                    {ownerName}
                  </span>
                )}
              </>
            )}
            <span className="text-fg-mute">·</span>
            <Mono className="text-[11px] text-fg-mute">
              {t("Updated {time}", {
                time: formatRelativeTimeLabel(
                  detail!.updated_at,
                  { format },
                  t,
                ),
              })}
            </Mono>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {detail!.viewer_is_owner ? (
            <Link
              href={`/community/collections/${detail!.id}`}
              className="inline-flex items-center gap-2 rounded-[10px] border border-line-strong px-4 py-2.5 text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-paper"
            >
              <Settings2 size={14} aria-hidden="true" />
              {t("Manage")}
            </Link>
          ) : (
            <Button
              variant={following ? "secondary" : "primary"}
              uppercase
              loading={followPending}
              aria-pressed={following}
              leftIcon={
                following ? (
                  <BookmarkCheck size={14} aria-hidden="true" />
                ) : (
                  <Bookmark size={14} aria-hidden="true" />
                )
              }
              onClick={() => void onToggleFollow()}
            >
              {following ? t("Following") : t("Follow")}
            </Button>
          )}
          {followError && (
            <p role="alert" className="text-[11px] text-quality-q1">
              {followError}
            </p>
          )}
        </div>
      </header>

      {detail!.description && (
        <p className="mb-4 max-w-2xl whitespace-pre-line text-sm text-ink">
          {detail!.description}
        </p>
      )}

      <section className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        <MetricTile
          variant="ink"
          accentNumber
          label={t("Routes")}
          value={detail!.item_count}
          formatValue={format.integer}
        />
        <MetricTile
          label={t("Total distance")}
          value={format.distanceKm(totalKm)}
        />
        <MetricTile
          label={t("Followers")}
          value={detail!.follower_count}
          formatValue={format.integer}
        />
      </section>

      <Stamp className="mb-2.5 mt-6 block">{t("Map preview")}</Stamp>
      <CollectionPreviewMap routes={routes} />

      <div className="mb-3 mt-[30px] flex items-baseline justify-between">
        <Stamp>{t("Routes")}</Stamp>
        {routes.length > 0 && (
          <Mono className="text-[11px] text-fg-mute">
            {format.distanceKm(totalKm)}
          </Mono>
        )}
      </div>
      {routes.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-line bg-cream p-10 text-center text-sm text-fg-dim">
          {t("This collection has no routes yet.")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {visibleRoutes.map((route, idx) => (
            <CollectionRouteRow
              key={route.item_id}
              route={route}
              index={idx + 1}
              author={author}
              format={format}
              linkable
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BackLink() {
  const t = useTranslation();
  return (
    <Link
      href="/community/collections"
      className="mb-4 inline-flex items-center gap-1 text-sm text-fg-dim transition hover:text-ink"
    >
      <ArrowLeft size={16} />
      {t("Collections")}
    </Link>
  );
}
