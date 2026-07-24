import type { paths } from "@tarmoto/openapi-client";
import type { EnglishMessageKey } from "@/i18n";
import { api } from "./api";

export type FunZoneListItem =
  paths["/api/v1/roads/fun-zones"]["get"]["responses"]["200"]["content"]["application/json"][number];

export type FunZoneDetail =
  paths["/api/v1/roads/fun-zones/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

const FUN_ZONE_SEASON_LABELS = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  year_round: "Year-round",
} as const satisfies Record<string, EnglishMessageKey>;

/** Catalog key for every season identifier emitted by the backend. */
export function funZoneSeasonLabel(season: string): EnglishMessageKey {
  return (
    FUN_ZONE_SEASON_LABELS[season as keyof typeof FUN_ZONE_SEASON_LABELS] ??
    "Unknown"
  );
}

/**
 * Client-side fetch for zones in a bbox. The endpoint is public, so no
 * Authorization header is attached (the shared client only adds one when a
 * token is present). Uses the caller's AbortSignal so viewport-driven requests
 * can cancel each other when the user is still panning.
 */
export async function fetchFunZonesInBbox(
  bbox: [number, number, number, number],
  init?: { signal?: AbortSignal },
): Promise<FunZoneListItem[]> {
  const { data, response } = await api.GET("/api/v1/roads/fun-zones", {
    params: { query: { bbox: bbox.join(",") } },
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  });
  // The list endpoint returns 200 with [] for "no zones in bbox"; any non-2xx
  // is a real error (bad bbox param, misconfigured API base, backend down) and
  // should surface to the user, not be coerced to [].
  if (!response.ok) {
    throw new Error(`GET /roads/fun-zones failed (${response.status})`);
  }
  return data ?? [];
}

export type FunZoneCorridorInput =
  paths["/api/v1/roads/fun-zones/in-corridor"]["post"]["requestBody"]["content"]["application/json"];

/**
 * Fun zones within `bufferKm` of a routed polyline (#865, the STOPS-tab
 * `twisty_highlight` layer) — the corridor counterpart of
 * {@link fetchFunZonesInBbox}. AuthGuard'd server-side (arbitrary-route
 * geospatial compute on a post-login surface), so the shared client's
 * Authorization header must be present.
 */
export async function fetchFunZonesInCorridor(
  route: { lat: number; lng: number }[],
  bufferKm: number,
  init?: { signal?: AbortSignal },
): Promise<FunZoneListItem[]> {
  const { data, response } = await api.POST(
    "/api/v1/roads/fun-zones/in-corridor",
    {
      body: { route, buffer_km: bufferKm },
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `POST /roads/fun-zones/in-corridor failed (${response.status})`,
    );
  }
  return data ?? [];
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
  const { data, response } = await api.GET("/api/v1/roads/fun-zones/{id}", {
    params: { path: { id } },
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /roads/fun-zones/${id} failed (${response.status})`);
  }
  return data ?? null;
}
