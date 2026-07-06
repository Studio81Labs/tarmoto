import { apiServer } from "@/lib/api/server";
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
  const { data, error, response } = await apiServer.GET(
    "/api/v1/map-shares/{token}",
    { params: { path: { token } }, cache: "no-store" },
  );

  if (response.status === 404) return null;
  if (error) {
    throw new Error(`GET /map-shares/${token} failed (${response.status})`);
  }

  return data ?? null;
}
