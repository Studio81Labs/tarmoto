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

/** Exactly the fields a best-roads page renders once quality is killed —
 *  see {@link stripRoadQuality}. */
export type SanitizedBestRoad = Pick<
  BestRoad,
  | "id"
  | "road_name"
  | "road_number"
  | "curviness_score"
  | "surface_type"
  | "length_m"
  | "geometry"
>;

/**
 * Rebuild each row with ONLY the fields the page needs, for when the operator
 * has killed `road_quality_overlay`.
 *
 * **An allowlist, deliberately, not `Omit<BestRoad, "quality_score">`.**
 * Dropping the one obvious field is not enough when the DTO carries values
 * DERIVED from it: `best_score` is
 * `quality_score * 2 + curviness_score + LEAST(length_km, 20) * 0.1`
 * (`roads.service.ts`), and curviness and length stay in the same object — so
 * a blocklist leaves the killed score recoverable in one line of algebra from
 * the "sanitized" payload. Projecting instead means a field the backend adds
 * later is excluded by default rather than shipped by default, which is the
 * only safe direction for a sanitizer.
 *
 * **Rebuilds rather than deletes** for a second reason: these rows cross into
 * `BestRoadsMap`, a `"use client"` component, and Next serializes
 * client-component props into the RSC Flight payload embedded in the HTML. A
 * `quality_score: null` placeholder would put the field name straight back
 * into `view-source:`. An absent key also makes each consumer's type demand
 * the missing branch instead of quietly rendering an em dash, and keeps a
 * stripped score distinguishable from a genuinely unrated road.
 */
export function stripRoadQuality(
  roads: readonly BestRoad[],
): SanitizedBestRoad[] {
  return roads.map((r) => ({
    id: r.id,
    road_name: r.road_name,
    road_number: r.road_number,
    curviness_score: r.curviness_score,
    surface_type: r.surface_type,
    length_m: r.length_m,
    geometry: r.geometry,
  }));
}

/**
 * Server-side fetcher used by the SSR region pages. The /roads/best endpoint
 * is public, so no Authorization header is needed. Returns null on 404
 * (unknown region) so callers can call Next's notFound() cleanly.
 *
 * The `revalidate` below is LIVE since the companion moved to a persistent
 * Node standalone server on Coolify (#1240): Next's default incremental cache
 * — an in-memory LRU, plus `.next/cache` on disk where the runtime user can
 * write it — backs the fetch data cache, and an explicit per-fetch
 * `revalidate` opts in even under `dynamic = "force-dynamic"` (the segment
 * default is what force-dynamic overrides, not an explicit option). Verified
 * against the standalone bundle: repeat renders serve this fetch from cache,
 * so the backend sees one `GET /roads/best` per region per TTL window per
 * container. The scope is the CONTAINER, not the fleet: a redeploy or restart
 * starts cold and refetches once. (Under the retired OpenNext/Workers hosting
 * this option was genuinely inert — `incrementalCache` was left unset, which
 * the adapter resolved to a no-op cache. That history is #1174.)
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
