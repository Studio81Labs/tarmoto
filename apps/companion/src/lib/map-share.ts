import { API_BASE_SERVER } from "@/lib/config";
import type { MapSharePublic } from "@/lib/api";

// Re-exported so server-side callers keep importing `MapSharePublic`
// from this module (alongside `fetchSharedMap`) without reaching into
// the client-side `api.ts` for a type definition.
export type { MapSharePublic };

/**
 * Server-side fetch for a public road-map share. Returns null on 404 so
 * the page component can call `notFound()` cleanly.
 */
export async function fetchSharedMap(
  token: string,
): Promise<MapSharePublic | null> {
  const res = await fetch(
    `${API_BASE_SERVER}/map-shares/${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /map-shares/${token} failed (${res.status})`);
  }

  return (await res.json()) as MapSharePublic;
}
