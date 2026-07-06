import { cache } from "react";
import { apiServer } from "@/lib/api/server";
import type {
  RouteCollectionDetail,
  RouteCollectionPreviewResponse,
} from "@/lib/api";

export type { RouteCollectionDetail, RouteCollectionPreviewResponse };

/**
 * Server-side fetch for the public/unlisted slug endpoint. Uses the server
 * API base (which falls back to a local Docker host) so SSR works in
 * production without leaking the public NEXT_PUBLIC_API_URL into the
 * client-side `api.ts` path.
 *
 * Returns `null` for the 404 case (private/missing slug) so the caller can
 * `notFound()` cleanly instead of branching on a thrown error.
 *
 * Wrapped in React's `cache()` so `generateMetadata` and the page component
 * dedupe to a single backend hit per render. The underlying `fetch` uses
 * `cache: "no-store"` to opt out of Next.js's HTTP cache (we want a fresh
 * read on every navigation), which also disables Next's automatic fetch
 * dedup — `cache()` restores it at the function level for one render pass.
 */
export const fetchSharedCollection = cache(
  async (slug: string): Promise<RouteCollectionDetail | null> => {
    const { data, response } = await apiServer.GET(
      "/api/v1/collections/by-slug/{slug}",
      { params: { path: { slug } }, cache: "no-store" },
    );

    if (response.status === 404) return null;
    // Branch on the HTTP status, not `error`: openapi-fetch only populates
    // `error` when the error response has a parseable body, so a 5xx with an
    // empty body would otherwise fall through to `null` and render notFound()
    // instead of surfacing the outage.
    if (!response.ok) {
      throw new Error(
        `GET /collections/by-slug/${slug} failed (${response.status})`,
      );
    }

    return data ?? null;
  },
);

/**
 * Server-side fetch for the per-item preview of a public/unlisted collection —
 * the simplified route geometry plus the per-item summaries (#689) the shared
 * page renders its route rows + map from. Same `cache()` + `no-store` rationale
 * as `fetchSharedCollection`.
 *
 * Returns `null` on ANY non-2xx so the caller can distinguish "preview failed"
 * from "collection genuinely has no routes". The detail fetch is the source of
 * truth for not-found/private, so if it succeeded but this errors (e.g. a
 * transient 500), the page must NOT collapse a populated collection into the
 * "no routes added" empty state — it shows a degraded "couldn't load routes"
 * notice instead.
 */
export const fetchSharedCollectionPreview = cache(
  async (slug: string): Promise<RouteCollectionPreviewResponse | null> => {
    const { data, error } = await apiServer.GET(
      "/api/v1/collections/by-slug/{slug}/preview",
      { params: { path: { slug } }, cache: "no-store" },
    );
    if (error || !data) return null;
    return data;
  },
);
