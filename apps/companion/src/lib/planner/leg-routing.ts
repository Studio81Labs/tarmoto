import type { RouteRequestBody, RouteResponse } from "@/lib/api";

/**
 * Per-leg routing (revision 3 §C): the route is computed one leg at a
 * time — each consecutive routing-waypoint pair gets its own request
 * carrying that leg's effective road preference — and the responses are
 * concatenated back into the single RouteResponse the rest of the app
 * consumes. `legBreaks` records where each leg starts in the merged
 * polyline so quality segments can be tagged with their legId.
 */

export interface PlannerRoutingLeg {
  legId: string;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  options: RouteRequestBody["options"];
}

export interface TripLegBreak {
  legId: string;
  /** Vertex index in the concatenated polyline where this leg starts. */
  startVertex: number;
}

export interface ConcatenatedLegRoutes {
  merged: RouteResponse;
  legBreaks: TripLegBreak[];
}

/** Distance-weighted mean over legs; null when no leg has a value. */
function weightedMean(
  responses: readonly RouteResponse[],
  pick: (r: RouteResponse) => number | null,
): number | null {
  let weighted = 0;
  let weight = 0;
  for (const response of responses) {
    const value = pick(response);
    if (value === null) continue;
    const km = Math.max(response.distance_km, 0.001);
    weighted += value * km;
    weight += km;
  }
  return weight > 0 ? weighted / weight : null;
}

export function concatLegRouteResponses(
  legs: readonly PlannerRoutingLeg[],
  responses: readonly RouteResponse[],
): ConcatenatedLegRoutes {
  if (legs.length !== responses.length || responses.length === 0) {
    throw new Error(
      `Leg/response count mismatch (${legs.length} legs, ${responses.length} responses)`,
    );
  }

  const geometry: RouteResponse["geometry"] = [];
  const legBreaks: TripLegBreak[] = [];
  const surfaceMix: Record<string, number> = {};
  let distanceKm = 0;
  let durationMin = 0;
  let elevationGainM = 0;

  responses.forEach((response, index) => {
    legBreaks.push({
      legId: legs[index]!.legId,
      startVertex: Math.max(0, geometry.length - (index > 0 ? 1 : 0)),
    });
    // Consecutive legs share their boundary vertex — drop the duplicate.
    const points =
      index > 0 && geometry.length > 0
        ? response.geometry.slice(1)
        : response.geometry;
    geometry.push(...points);
    distanceKm += response.distance_km;
    durationMin += response.duration_min;
    elevationGainM += response.elevation_gain_m;
    for (const [surface, metres] of Object.entries(response.surface_mix)) {
      surfaceMix[surface] = (surfaceMix[surface] ?? 0) + metres;
    }
  });

  return {
    merged: {
      geometry,
      distance_km: distanceKm,
      duration_min: durationMin,
      elevation_gain_m: elevationGainM,
      avg_quality: weightedMean(responses, (r) => r.avg_quality),
      curviness_score: weightedMean(responses, (r) => r.curviness_score),
      surface_mix: surfaceMix,
    },
    legBreaks,
  };
}
