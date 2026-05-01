import { API_BASE_SERVER } from "@/lib/config";
import type { RouteCollectionDetail } from "@/lib/api";

export type { RouteCollectionDetail };

/**
 * Server-side fetch for the public/unlisted slug endpoint. Uses the server
 * API base (which falls back to a local Docker host) so SSR works in
 * production without leaking the public NEXT_PUBLIC_API_URL into the
 * client-side `api.ts` path.
 *
 * Returns `null` for the 404 case (private/missing slug) so the caller can
 * `notFound()` cleanly instead of branching on a thrown error.
 */
export async function fetchSharedCollection(
  slug: string,
): Promise<RouteCollectionDetail | null> {
  const res = await fetch(
    `${API_BASE_SERVER}/collections/by-slug/${encodeURIComponent(slug)}`,
    { cache: "no-store" },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /collections/by-slug/${slug} failed (${res.status})`);
  }

  return (await res.json()) as RouteCollectionDetail;
}
