import { cache } from "react";
import { apiServer } from "@/lib/api/server";
import type {
  RouteCollectionDetail,
  RouteCollectionPreviewResponse,
} from "@/lib/api";

export type { RouteCollectionDetail, RouteCollectionPreviewResponse };

type RouteCollectionPreviewItem =
  RouteCollectionPreviewResponse["routes"][number];

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
/** A collection preview item with the recorded quality removed — see
 *  {@link stripCollectionQuality}. */
export type SanitizedCollectionPreviewItem = Omit<
  RouteCollectionPreviewItem,
  "quality_avg"
>;

/**
 * Rebuild each item with only the fields the shared page renders, for when the
 * operator has killed `road_quality_overlay`. Same allowlist reasoning as
 * `stripRoadQuality` / `stripSegmentQuality` — every other field on this DTO
 * has a real consumer (`lines` for the map, `title`/`distance_km`/`status` for
 * the row, `target_id` for its link, `position` for ordering), so `quality_avg`
 * is the only one dropped.
 *
 * Deletes the key: these items are handed to `CollectionPreviewMap`, a
 * `"use client"` component whose props Next serializes into the RSC Flight
 * payload embedded in the HTML.
 */
/**
 * A collection preview item that MAY carry its recorded quality — the shape
 * every consumer should accept, because a killed `road_quality_overlay`
 * strips it server-side. The full DTO is assignable here.
 */
export type MaybeQualityCollectionPreviewItem =
  SanitizedCollectionPreviewItem & {
    quality_avg?: number | null;
  };

export function stripCollectionQuality(
  routes: readonly RouteCollectionPreviewItem[],
): SanitizedCollectionPreviewItem[] {
  return routes.map((r) => ({
    item_id: r.item_id,
    position: r.position,
    target_id: r.target_id,
    lines: r.lines,
    title: r.title,
    distance_km: r.distance_km,
    status: r.status,
  }));
}

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
