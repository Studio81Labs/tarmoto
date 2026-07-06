import type { paths } from "@tarmoto/openapi-client";
import { apiServer } from "@/lib/api/server";

type BestRoadsResponse =
  paths["/api/v1/roads/best"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Server-side fetcher used by the SSR region pages. The /roads/best endpoint
 * is public, so no Authorization header is needed. Returns null on 404
 * (unknown region) so callers can call Next's notFound() cleanly. Keeps the
 * weekly ISR revalidate via the `next` fetch option (forwarded by the client).
 */
export async function fetchBestRoads(
  country: string,
  region: string,
  limit = 10,
): Promise<BestRoadsResponse | null> {
  const { data, response } = await apiServer.GET("/api/v1/roads/best", {
    params: { query: { country, region, limit } },
    next: { revalidate: 604800 },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /roads/best failed (${response.status})`);
  }
  return data ?? null;
}
