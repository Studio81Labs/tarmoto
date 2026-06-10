import { cache } from "react";
import { API_BASE_SERVER } from "@/lib/config";
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
    const res = await fetch(
      `${API_BASE_SERVER}/collections/by-slug/${encodeURIComponent(slug)}`,
      { cache: "no-store" },
    );

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GET /collections/by-slug/${slug} failed (${res.status})`,
      );
    }

    return (await res.json()) as RouteCollectionDetail;
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
    const res = await fetch(
      `${API_BASE_SERVER}/collections/by-slug/${encodeURIComponent(slug)}/preview`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as RouteCollectionPreviewResponse;
  },
);
