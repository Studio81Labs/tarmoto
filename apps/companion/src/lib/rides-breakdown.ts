/**
 * Fetches the surface + curviness distance breakdown for the active stats
 * filter (US-49). Unlike the rest of the stats screen — which aggregates the
 * full ride list client-side — these two cards need a per-segment join the
 * client can't do, so the backend computes them live from
 * `ride_segments → road_segments` and returns ready-to-render slices.
 */

import type { components } from "@tarmoto/openapi-client";
import type { EnglishMessageKey } from "@/i18n";
import type { SurfaceType } from "@tarmoto/shared";
import { api } from "./api";
import { windowStart, type RideFilters, type RideType } from "./ride-stats";

export type RideBreakdown = components["schemas"]["RideBreakdownDto"];
export type RideBreakdownSlice = components["schemas"]["RideBreakdownSliceDto"];

type CurvinessBreakdownKey =
  "straight" | "flowing" | "twisty" | "tight" | "hairpin";
type RideBreakdownKey = SurfaceType | CurvinessBreakdownKey;

const BREAKDOWN_LABELS = {
  asphalt: "Asphalt",
  concrete: "Concrete",
  cobblestone: "Cobblestone",
  gravel: "Gravel",
  dirt: "Dirt",
  unknown: "Unknown",
  straight: "Straight",
  flowing: "Flowing",
  twisty: "Twisty",
  tight: "Tight",
  hairpin: "Hairpin",
} as const satisfies Record<RideBreakdownKey, EnglishMessageKey>;

export function rideBreakdownLabel(key: string): EnglishMessageKey {
  return key in BREAKDOWN_LABELS
    ? BREAKDOWN_LABELS[key as keyof typeof BREAKDOWN_LABELS]
    : "Unknown";
}

export async function fetchRideBreakdown(
  filters: RideFilters,
  now = new Date(),
): Promise<RideBreakdown> {
  const start = windowStart(filters.window, now);
  const query: { started_from?: string; started_to?: string; type?: RideType } =
    {
      // Upper bound at "now" so future-dated rides (clock skew / bad import)
      // are excluded server-side too, matching the client-side KPI filter and
      // the charts (which only bucket through today).
      started_to: now.toISOString(),
    };
  // Send the exact instant (not a truncated date) so the server aggregate uses
  // the same lower bound as the client-side KPI filter — otherwise the cards
  // would count rides from midnight on the boundary day that the KPIs exclude.
  if (start) query.started_from = start.toISOString();
  if (filters.rideType !== "all") query.type = filters.rideType;

  const { data, error } = await api.GET("/api/v1/rides/stats/breakdown", {
    params: { query },
  });
  if (error) {
    // `error` is already truthy here, so the typeof-object guard is enough to
    // safely probe for a `message` field.
    const apiMessage =
      typeof error === "object" && "message" in error
        ? (error as { message?: unknown }).message
        : undefined;
    throw new Error(
      typeof apiMessage === "string" && apiMessage.length > 0
        ? apiMessage
        : "Could not load the ride breakdown",
      { cause: error },
    );
  }
  return data;
}
