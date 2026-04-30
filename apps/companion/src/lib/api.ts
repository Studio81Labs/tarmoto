import { createApiClient } from "@tarmoto/openapi/client";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";
import type { MountainPass } from "./passes-summary";

// Typed openapi-fetch client for all spec-defined endpoints
export const api = createApiClient({
  baseUrl: API_HOST,
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().clearSession(),
});

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// ── Auth helpers ──

export async function forgotPassword(email: string) {
  await apiFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// Used by the registration page before Auth.js signIn.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const { data } = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  return data;
}

// ── Raw fetch helper for endpoints not yet in the OpenAPI spec ──
// Checks res.ok and clears session on 401 (matching openapi-fetch client behavior).
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T }> {
  const token = useAuthStore.getState().accessToken;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers ?? {})),
  };
  const { headers: _, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().clearSession();
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { message?: string }).message ??
        `Request failed (${res.status})`,
      res.status,
      body,
    );
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { data: undefined as T };
  }
  const data = (await res.json()) as T;
  return { data };
}

// ── Trip endpoints (not yet in spec) ──
export const tripsApi = {
  list: (params?: { page?: number; status?: string }) => {
    const defined = params
      ? Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    const query = defined ? "?" + new URLSearchParams(defined).toString() : "";
    return apiFetch(`/trips${query}`);
  },
  get: (id: string) => apiFetch(`/trips/${id}`),
  create: (data: unknown) =>
    apiFetch("/trips", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: unknown) =>
    apiFetch(`/trips/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: string) => apiFetch(`/trips/${id}`, { method: "DELETE" }),
  // POST /trips/:tripId/generate (US-7) — backend builds three preset
  // options (best-fit / scenic / fastest), persists the selected one,
  // and returns all three for side-by-side comparison.
  generate: (tripId: string, params: unknown) =>
    apiFetch(`/trips/${tripId}/generate`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  invite: (tripId: string, email: string) =>
    apiFetch(`/trips/${tripId}/invite`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
};

// ── Trip shares (US-35: read-only invite links, first slice) ──

export interface TripShareResponse {
  id: string;
  share_token: string;
  share_url: string;
  title: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface TripSharePublic {
  share_token: string;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface TripShareListResponse {
  items: TripShareResponse[];
  total: number;
}

export const tripSharesApi = {
  create: (payload: { title: string; snapshot: Record<string, unknown> }) =>
    apiFetch<TripShareResponse>("/trip-shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMine: () => apiFetch<TripShareListResponse>("/trip-shares/mine"),
  getByToken: (token: string) =>
    apiFetch<TripSharePublic>(`/trip-shares/${encodeURIComponent(token)}`),
  revoke: (id: string) =>
    apiFetch(`/trip-shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ── Trip collaboration (US-35: suggestions + votes + accept/reject + activity) ──

export type SuggestionVote = "up" | "down";
export type SuggestionStatus = "open" | "accepted" | "rejected";

export interface TripSuggestion {
  id: string;
  trip_id: string;
  trip_day_id: string | null;
  suggested_by: string;
  suggester_display_name: string;
  road_segment_id: string | null;
  title: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  status: SuggestionStatus;
  up_votes: number;
  down_votes: number;
  /** Caller's own vote, or null if they haven't voted. */
  caller_vote: SuggestionVote | null;
  created_at: string;
  updated_at: string;
}

export type TripActivityAction =
  | "member_joined"
  | "member_left"
  | "trip_updated"
  | "trip_generated"
  | "suggestion_created"
  | "suggestion_deleted"
  | "suggestion_voted"
  | "suggestion_vote_removed"
  | "suggestion_accepted"
  | "suggestion_rejected";

export interface TripActivityEntry {
  id: string;
  trip_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: TripActivityAction;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TripActivityListResponse {
  activity: TripActivityEntry[];
}

export const tripCollabApi = {
  listSuggestions: (tripId: string) =>
    apiFetch<TripSuggestion[]>(
      `/trips/${encodeURIComponent(tripId)}/suggestions`,
    ),
  createSuggestion: (
    tripId: string,
    payload: {
      title: string;
      description?: string;
      trip_day_id?: string;
      road_segment_id?: string;
      lat?: number;
      lng?: number;
    },
  ) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  deleteSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<void>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}`,
      { method: "DELETE" },
    ),
  voteSuggestion: (
    tripId: string,
    suggestionId: string,
    vote: SuggestionVote,
  ) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/vote`,
      { method: "POST", body: JSON.stringify({ vote }) },
    ),
  unvoteSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/vote`,
      { method: "DELETE" },
    ),
  acceptSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/accept`,
      { method: "POST" },
    ),
  rejectSuggestion: (tripId: string, suggestionId: string) =>
    apiFetch<TripSuggestion>(
      `/trips/${encodeURIComponent(tripId)}/suggestions/${encodeURIComponent(suggestionId)}/reject`,
      { method: "POST" },
    ),
  listActivity: (tripId: string, limit?: number) => {
    const query = limit != null ? `?limit=${limit}` : "";
    return apiFetch<TripActivityListResponse>(
      `/trips/${encodeURIComponent(tripId)}/activity${query}`,
    );
  },
};

// ── Exploration endpoints (not yet in spec) ──
export interface ExplorationStats {
  ridden_segments: number;
  total_segments: number;
  percent_explored: number;
  total_distance_km: number;
}

export interface UnriddenSegment {
  id: string;
  road_name: string | null;
  length_m: number;
  quality_score: number | null;
  surface_type: string;
  distance_m: number;
}

export const explorationApi = {
  getStats: () => apiFetch<ExplorationStats>("/exploration/stats"),
  getRiddenIds: () =>
    apiFetch<{ segment_ids: string[] }>("/exploration/ridden-ids"),
  getNearbyUnridden: (params: {
    lat: number;
    lng: number;
    radius_km?: number;
    limit?: number;
  }) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius_km != null)
      query.set("radius_km", String(params.radius_km));
    if (params.limit != null) query.set("limit", String(params.limit));
    return apiFetch<UnriddenSegment[]>(
      `/exploration/nearby-unridden?${query.toString()}`,
    );
  },
};

// ── Hazards endpoints (public; not yet in spec) ──

export interface HazardResponse {
  id: string;
  lat: number;
  lng: number;
  hazard_type: string;
  severity: string;
  note: string | null;
  confirmations: number;
  reporter: string | null;
  road_name: string | null;
  created_at: string;
  expires_at: string;
}

export const hazardsApi = {
  findNearby: (
    params: { lat: number; lng: number; radius?: number; types?: string },
    init?: RequestInit,
  ) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius != null) query.set("radius", String(params.radius));
    if (params.types) query.set("types", params.types);
    return apiFetch<HazardResponse[]>(`/hazards?${query.toString()}`, init);
  },
};

// ── Closures endpoints (US-40 seasonal closures & roadworks) ──

export type RoadClosureReason =
  | "closure"
  | "roadworks"
  | "seasonal"
  | "weather"
  | "event"
  | "other";

export type RoadClosureSeverity = "advisory" | "partial" | "full";

export interface RoadClosurePoint {
  lat: number;
  lng: number;
}

export interface RoadClosure {
  id: string;
  title: string;
  reason: RoadClosureReason;
  severity: RoadClosureSeverity;
  geometry: RoadClosurePoint[];
  detour: RoadClosurePoint[] | null;
  country_code: string;
  region: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  source: "operator" | "osm" | "official";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckRouteClosuresResponse {
  closures: RoadClosure[];
  full_count: number;
  partial_count: number;
  advisory_count: number;
}

export const closuresApi = {
  list: (
    params: {
      bbox?: string;
      active_on?: string;
      severity?: RoadClosureSeverity;
      reason?: RoadClosureReason;
      include_past?: boolean;
    },
    init?: RequestInit,
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiFetch<RoadClosure[]>(`/closures${suffix}`, init);
  },
  checkRoute: (
    data: {
      route: RoadClosurePoint[];
      buffer_m?: number;
      active_on?: string;
    },
    init?: RequestInit,
  ) =>
    apiFetch<CheckRouteClosuresResponse>("/closures/check-route", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// ── POI endpoints (US-36 / US-48 planner stops & stays) ──

export type AccommodationKind =
  | "hotel"
  | "motel"
  | "hostel"
  | "guest_house"
  | "apartment"
  | "chalet"
  | "camp_site";

export interface AccommodationSuggestion {
  external_id: string;
  name: string | null;
  kind: AccommodationKind;
  lat: number;
  lng: number;
  distance_km: number;
  website: string | null;
  phone: string | null;
  stars: number | null;
}

export interface AccommodationsResponse {
  accommodations: AccommodationSuggestion[];
  radius_km: number;
  kinds: AccommodationKind[];
}

export type PoiKind = "restaurant" | "viewpoint" | "cafe" | "fuel_station";

export interface RoutePoiSuggestion {
  external_id: string;
  name: string | null;
  kind: PoiKind;
  lat: number;
  lng: number;
  distance_along_route_km: number;
  distance_from_route_km: number;
  website: string | null;
  phone: string | null;
  hint: string | null;
}

export interface AlongRoutePoisResponse {
  pois: RoutePoiSuggestion[];
  buffer_km: number;
  kinds: PoiKind[];
  route_length_km: number;
}

export const poiApi = {
  getAccommodations: (params: {
    lat: number;
    lng: number;
    radius_km?: number;
    min_stars?: number;
    kinds?: AccommodationKind[];
  }) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius_km != null)
      query.set("radius_km", String(params.radius_km));
    if (params.min_stars != null)
      query.set("min_stars", String(params.min_stars));
    if (params.kinds && params.kinds.length > 0) {
      query.set("kinds", params.kinds.join(","));
    }
    return apiFetch<AccommodationsResponse>(
      `/poi/accommodations?${query.toString()}`,
    );
  },
  getAlongRoute: (data: {
    route: Array<{ lat: number; lng: number }>;
    buffer_km?: number;
    kinds?: PoiKind[];
  }) =>
    apiFetch<AlongRoutePoisResponse>("/poi/along-route", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

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
  ride_type: string;
  started_at: string;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  avg_curviness: number | null;
  duration_min: number | null;
  view_count: number;
  route_geometry: Array<{ lat: number; lng: number }> | null;
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
};

// ── Mountain passes endpoints (US-40 seasonal closures & pass status) ──

export interface CheckRoutePassesResponse {
  passes: MountainPass[];
  closed_count: number;
  unknown_count: number;
}

export const passesApi = {
  checkRoute: (
    data: {
      route: Array<{ lat: number; lng: number }>;
      buffer_m?: number;
      for_month?: number;
    },
    init?: RequestInit,
  ) =>
    apiFetch<CheckRoutePassesResponse>("/passes/check-route", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// ── Road reviews endpoints (US-55) ──

export interface RoadReview {
  id: string;
  user_display_name: string;
  rating: number;
  comment: string | null;
  bike_model: string | null;
  photos: string[];
  created_at: string;
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
  is_mine: boolean;
}

export interface ReviewVoteResult {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

export interface UpsertRoadReviewInput {
  rating: number;
  comment?: string;
  bike_model?: string;
  photos?: string[];
}

export const roadsApi = {
  getReviews: (segmentId: string, init?: RequestInit) =>
    apiFetch<RoadReview[]>(
      `/roads/${encodeURIComponent(segmentId)}/reviews`,
      init,
    ),
  createReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    apiFetch<RoadReview>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    apiFetch<RoadReview>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteReview: (segmentId: string, init?: RequestInit) =>
    apiFetch<void>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "DELETE",
    }),
  voteOnReview: (reviewId: string, isHelpful: boolean, init?: RequestInit) =>
    apiFetch<ReviewVoteResult>(
      `/roads/reviews/${encodeURIComponent(reviewId)}/vote`,
      {
        ...init,
        method: "POST",
        body: JSON.stringify({ is_helpful: isHelpful }),
      },
    ),
  clearReviewVote: (reviewId: string, init?: RequestInit) =>
    apiFetch<ReviewVoteResult>(
      `/roads/reviews/${encodeURIComponent(reviewId)}/vote`,
      {
        ...init,
        method: "DELETE",
      },
    ),
};

// ── Users endpoints (US-59 profile) ──

export interface UserProfileResponse {
  id: string;
  email: string;
  display_name: string;
  phone: string | null;
  avatar_url: string | null;
  bio: string | null;
  home_region: string | null;
  home_location: { lat: number; lng: number } | null;
  work_location: { lat: number; lng: number } | null;
  preferences: Record<string, unknown>;
  created_at: string;
}

export interface UpdateProfileInput {
  display_name?: string;
  phone?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  home_region?: string | null;
}

export const usersApi = {
  getMe: (init?: RequestInit) =>
    apiFetch<UserProfileResponse>("/users/me", init),
  uploadAvatar: async (file: File) => {
    const token = useAuthStore.getState().accessToken;
    const body = new FormData();
    body.append("file", file);

    const res = await fetch(`${API_BASE}/users/me/avatar`, {
      method: "POST",
      body,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (!res.ok) {
      if (res.status === 401) useAuthStore.getState().clearSession();
      const payload = await res.json().catch(() => ({}));
      throw new ApiError(
        (payload as { message?: string }).message ??
          `Request failed (${res.status})`,
        res.status,
        payload,
      );
    }

    return { data: (await res.json()) as UserProfileResponse };
  },
  updateMe: (data: UpdateProfileInput) =>
    apiFetch<UserProfileResponse>("/users/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};

// ── Account endpoints (not yet in spec) ──
export interface DataExportRequestView {
  id: string;
  status: "queued" | "processing" | "ready" | "failed" | "expired";
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
  byteSize: number | null;
  errorMessage: string | null;
}

export const accountApi = {
  updateProfile: (data: unknown) =>
    apiFetch("/account/profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getSubscription: () => apiFetch("/account/subscription"),
  createCheckoutSession: (data: { tier: "premium" | "pro" }) =>
    apiFetch<{ url: string }>("/account/subscription/checkout", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  createPortalSession: (data?: {
    flow?:
      | "manage"
      | "payment_method_update"
      | "subscription_cancel"
      | "subscription_update";
  }) =>
    apiFetch<{ url: string }>("/account/subscription/portal", {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    }),
  getBikes: () => apiFetch("/account/bikes"),
  addBike: (data: unknown) =>
    apiFetch("/account/bikes", { method: "POST", body: JSON.stringify(data) }),
  updateBike: (id: string, data: unknown) =>
    apiFetch(`/account/bikes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBike: (id: string) =>
    apiFetch(`/account/bikes/${id}`, { method: "DELETE" }),
  requestDataExport: () =>
    apiFetch<DataExportRequestView>("/account/data-export", {
      method: "POST",
    }),
  getDataExport: (id: string) =>
    apiFetch<DataExportRequestView>(`/account/data-export/${id}`),
  deleteAccount: (input: { password: string; reason?: string }) =>
    apiFetch<{
      status: "scheduled";
      scheduled_for: string;
      grace_period_days: number;
    }>("/account", {
      method: "DELETE",
      body: JSON.stringify(input),
    }),
  getNotificationPreferences: () =>
    apiFetch("/account/notification-preferences"),
  updateNotificationPreferences: (data: unknown) =>
    apiFetch("/account/notification-preferences", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getPrivacySettings: () => apiFetch("/account/privacy-settings"),
  updatePrivacySettings: (data: unknown) =>
    apiFetch("/account/privacy-settings", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};
