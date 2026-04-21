import { API_BASE_SERVER } from "@/lib/config";
import type { paths } from "@tarmoto/openapi/types";

type BestRoadsResponse =
  paths["/api/v1/roads/best"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Server-side fetcher used by the SSR region pages. The /roads/best endpoint
 * is public, so no Authorization header is needed. Returns null on 404
 * (unknown region) so callers can call Next's notFound() cleanly.
 */
export async function fetchBestRoads(
  country: string,
  region: string,
  limit = 10,
): Promise<BestRoadsResponse | null> {
  const url =
    `${API_BASE_SERVER}/roads/best` +
    `?country=${encodeURIComponent(country)}` +
    `&region=${encodeURIComponent(region)}` +
    `&limit=${limit}`;

  const res = await fetch(url, {
    next: { revalidate: 604800 },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /roads/best failed (${res.status})`);
  }
  return (await res.json()) as BestRoadsResponse;
}
