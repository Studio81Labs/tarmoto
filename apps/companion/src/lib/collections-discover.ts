/**
 * Data layer for the Community → Collections discovery grid: public
 * collections (search + popularity ranked) and per-collection mosaic
 * thumbnails sourced from the existing preview endpoint.
 */
import type { components } from "@tarmoto/openapi-client";
import { api } from "./api";
import { routeCollectionsApi } from "./api";

export type DiscoverCollection =
  components["schemas"]["RouteCollectionCardDto"];

/** The discovery grid consumes only the items + total; the endpoint also
 * returns `limit`/`offset` for pagination, which this projection drops. */
export type DiscoverCollectionPage = Pick<
  components["schemas"]["RouteCollectionDiscoverResponseDto"],
  "items" | "total"
>;

/** Browse public collections, optionally filtered by a title search. */
export async function fetchDiscoverCollections(
  q: string,
  signal?: AbortSignal,
): Promise<DiscoverCollectionPage> {
  const query: { q?: string; limit?: string } = { limit: "24" };
  if (q.trim()) query.q = q.trim();
  const { data, error } = await api.GET("/api/v1/collections/discover", {
    params: { query },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (error || !data) return { items: [], total: 0 };
  return { items: data.items, total: data.total };
}

/** Up to `max` route polylines (as [lng,lat][] arrays) for a collection mosaic. */
export async function fetchCollectionMosaic(
  slug: string,
  max = 6,
): Promise<number[][][]> {
  try {
    const { data } = await routeCollectionsApi.getPreviewBySlug(slug);
    const lines: number[][][] = [];
    for (const route of data.routes) {
      const first = route.lines?.[0];
      if (first && first.length >= 2) lines.push(first);
      if (lines.length >= max) break;
    }
    return lines;
  } catch {
    return [];
  }
}
