import type { components, paths } from "@tarmoto/openapi-client";
import { apiServer } from "@/lib/api/server";

type BestRoadsResponse =
  paths["/api/v1/roads/best"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * One road row from `GET /api/v1/roads/best` — the generated `BestRoadDto`.
 * The best-roads UI (list, map, schema.org, embed) derives its row/label
 * shapes from this via `Pick<>` so a backend field change propagates to every
 * surface at typecheck time.
 */
export type BestRoad = components["schemas"]["BestRoadDto"];

/** A best-roads row whose quality score has been REMOVED — see
 *  {@link stripRoadQuality}. The key is absent, not null. */
export type BestRoadWithoutQuality = Omit<BestRoad, "quality_score">;

/**
 * Drop `quality_score` from every row, for when the operator has killed
 * `road_quality_overlay`.
 *
 * **Deletes the key rather than nulling it**, which matters twice over. These
 * rows are handed to `BestRoadsMap`, a `"use client"` component, and Next
 * serializes client-component props into the RSC Flight payload embedded in
 * the HTML — so `quality_score: null` would put the field straight back into
 * `view-source:`, which is the exact thing a server-side kill exists to
 * prevent. And an absent key makes every consumer's type say the score may not
 * be there, so the compiler asks for the missing branch instead of letting a
 * `null` quietly render as an em dash.
 */
export function stripRoadQuality(
  roads: readonly BestRoad[],
): BestRoadWithoutQuality[] {
  return roads.map(({ quality_score: _dropped, ...rest }) => rest);
}

/**
 * Server-side fetcher used by the SSR region pages. The /roads/best endpoint
 * is public, so no Authorization header is needed. Returns null on 404
 * (unknown region) so callers can call Next's notFound() cleanly.
 *
 * The `revalidate` below is INERT in production: the Cloudflare adapter leaves
 * `incrementalCache` unset, which OpenNext resolves to its `dummy` cache whose
 * `get`/`set` throw, so no server fetch in this app caches across requests.
 * Every page view re-hits the backend today. Tracked in #1174; the option is
 * kept because it states the intent and starts working once a cache exists.
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
