import { apiFetch } from "./client";

// ── Community feed endpoints (US-53 companion feed) ──

export type CommunityRideSort =
  | "newest"
  | "oldest"
  | "longest"
  | "shortest"
  | "highest_quality"
  | "curviest"
  | "most_popular"
  | "nearest";

export interface CommunityRide {
  id: string;
  share_token: string;
  rider_id: string;
  rider_name: string;
  rider_avatar_url: string | null;
  name: string | null;
  ride_type: string;
  started_at: string;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  avg_curviness: number | null;
  duration_min: number | null;
  view_count: number;
  description: string | null;
  like_count: number;
  viewer_has_liked: boolean;
  clone_count: number;
  route_geometry: Array<{ lat: number; lng: number }> | null;
}

export interface RideLikeResult {
  like_count: number;
  viewer_has_liked: boolean;
}

export interface CloneRideResult {
  trip_id: string;
  clone_count: number;
}

export interface CommunityRidePage {
  items: CommunityRide[];
  total: number;
  limit: number;
  offset: number;
}

export interface CommunityRideQuery {
  lat?: number;
  lng?: number;
  radius_km?: number;
  min_distance_km?: number;
  max_distance_km?: number;
  min_quality?: number;
  min_popularity?: number;
  min_curviness?: number;
  max_curviness?: number;
  ride_type?: string;
  sort?: CommunityRideSort;
  limit?: number;
  offset?: number;
}

export const communityApi = {
  list: (params: CommunityRideQuery) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiFetch<CommunityRidePage>(`/rides/community${suffix}`);
  },
  like: (rideId: string) =>
    apiFetch<RideLikeResult>(`/rides/${encodeURIComponent(rideId)}/like`, {
      method: "POST",
    }),
  unlike: (rideId: string) =>
    apiFetch<RideLikeResult>(`/rides/${encodeURIComponent(rideId)}/like`, {
      method: "DELETE",
    }),
  clone: (rideId: string) =>
    apiFetch<CloneRideResult>(`/rides/${encodeURIComponent(rideId)}/clone`, {
      method: "POST",
    }),
};
