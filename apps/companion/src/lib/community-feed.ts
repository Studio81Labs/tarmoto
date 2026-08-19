import type { CommunityRideQuery, CommunityRideSort } from "./api";

export interface CommunityFeedLocation {
  label: string;
  lat: number;
  lng: number;
  km: number;
}

/** Ride-type filter values — the wire ride types plus the "all" sentinel. */
export type RideTypeFilter =
  "all" | NonNullable<CommunityRideQuery["ride_type"]>;

export interface CommunityFeedFormState {
  sort: CommunityRideSort;
  rideType: RideTypeFilter;
  minQuality: string;
  minPopularity: string;
  minCurviness: string;
  minDistanceKm: string;
  maxDistanceKm: string;
  location: CommunityFeedLocation | null;
  limit: number;
  offset: number;
}

export function buildCommunityRideQuery(
  state: CommunityFeedFormState,
): CommunityRideQuery {
  const query: CommunityRideQuery = {
    sort:
      state.sort === "nearest" && !state.location ? "most_popular" : state.sort,
    limit: state.limit,
    offset: state.offset,
  };

  if (state.rideType !== "all") {
    query.ride_type = state.rideType;
  }

  const minQuality = parseNumericField(state.minQuality);
  if (minQuality != null) query.min_quality = minQuality;

  const minPopularity = parseNumericField(state.minPopularity);
  if (minPopularity != null) query.min_popularity = minPopularity;

  const minCurviness = parseNumericField(state.minCurviness);
  if (minCurviness != null) query.min_curviness = minCurviness;

  const minDistanceKm = parseNumericField(state.minDistanceKm);
  if (minDistanceKm != null) query.min_distance_km = minDistanceKm;

  const maxDistanceKm = parseNumericField(state.maxDistanceKm);
  if (maxDistanceKm != null) query.max_distance_km = maxDistanceKm;

  if (state.location) {
    query.lat = state.location.lat;
    query.lng = state.location.lng;
    query.radius_km = state.location.km;
  }

  return query;
}

function parseNumericField(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
