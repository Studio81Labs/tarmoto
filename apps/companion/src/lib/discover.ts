import { API_BASE } from "@/lib/config";
import type { paths } from "@tarmoto/openapi-client";

export type FunZoneListItem =
  paths["/api/v1/roads/fun-zones"]["get"]["responses"]["200"]["content"]["application/json"][number];

export type FunZoneDetail =
  paths["/api/v1/roads/fun-zones/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Client-side fetch for zones in a bbox. The endpoint is public, so no
 * Authorization header is attached. Uses the caller's AbortSignal so that
 * viewport-driven requests can cancel each other when the user is still
 * panning.
 */
export async function fetchFunZonesInBbox(
  bbox: [number, number, number, number],
  init?: { signal?: AbortSignal },
): Promise<FunZoneListItem[]> {
  const query = new URLSearchParams({ bbox: bbox.join(",") });
  const res = await fetch(`${API_BASE}/roads/fun-zones?${query.toString()}`, {
    signal: init?.signal,
  });
  if (!res.ok) {
    // The list endpoint returns 200 with [] for "no zones in bbox"; any
    // non-2xx is a real error (bad bbox param, misconfigured API base,
    // backend down) and should surface to the user, not be coerced to [].
    throw new Error(`GET /roads/fun-zones failed (${res.status})`);
  }
  return (await res.json()) as FunZoneListItem[];
}

/**
 * Fetch a single Fun Zone with its top contributing roads. Returns null on
 * 404 so callers can close the detail panel cleanly without treating the
 * missing zone as an exception.
 */
export async function fetchFunZoneDetail(
  id: string,
  init?: { signal?: AbortSignal },
): Promise<FunZoneDetail | null> {
  const res = await fetch(
    `${API_BASE}/roads/fun-zones/${encodeURIComponent(id)}`,
    { signal: init?.signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /roads/fun-zones/${id} failed (${res.status})`);
  }
  return (await res.json()) as FunZoneDetail;
}
