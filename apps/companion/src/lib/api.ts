import { createApiClient } from "@tarmoto/openapi/client";
import type {
  NotificationPreferences,
  PrivacyPreferences,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";
import type { PartialNotificationPreferences } from "./notification-preferences";
import type { MountainPass } from "./passes-summary";
import type { PartialPrivacySettings } from "./privacy-settings";
import type { PrivacySettings } from "./types";

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

export interface RiddenSegmentMeta {
  id: string;
  last_ridden_at: string;
  last_quality_score: number | null;
  ride_count: number;
}

export const explorationApi = {
  getStats: () => apiFetch<ExplorationStats>("/exploration/stats"),
  getRiddenIds: () =>
    apiFetch<{ segment_ids: string[] }>("/exploration/ridden-ids"),
  getRiddenSegments: () =>
    apiFetch<{ segments: RiddenSegmentMeta[] }>("/exploration/ridden-segments"),
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

// ── Route collections (US-56: cloud-synced shareable collections) ──

export type RouteCollectionVisibility = "private" | "unlisted" | "public";

export interface RouteCollectionSummary {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  visibility: RouteCollectionVisibility;
  slug: string;
  item_count: number;
  /**
   * Display name of the owner. Populated for endpoints that surface other
   * riders' collections (e.g. the followed list); null on `/collections/me`
   * since the rider already knows their own name.
   */
  owner_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface RouteCollectionItemResponse {
  id: string;
  trip_id: string | null;
  ride_id: string | null;
  position: number;
  created_at: string;
}

export interface RouteCollectionDetail extends RouteCollectionSummary {
  items: RouteCollectionItemResponse[];
  // `owner_name` inherits `string | null` from the summary. The backend always
  // sends a string for detail responses (empty for soft-deleted owners, but
  // those 404 before reaching here), but keeping the looser type matches the
  // OpenAPI schema and frees consumers from a redundant override.
  /**
   * Personalised flags. Anonymous viewers always see `false` for both. The
   * server reads the optional Bearer token on `/collections/by-slug/:slug`
   * to populate them.
   */
  viewer_is_owner: boolean;
  viewer_is_following: boolean;
}

export interface RouteCollectionFollowResponse {
  collection_id: string;
  followed_at: string;
}

export interface RouteCollectionLibraryResponse {
  owned: RouteCollectionSummary[];
  followed: RouteCollectionSummary[];
}

export interface CreateRouteCollectionInput {
  title: string;
  description?: string;
  visibility?: RouteCollectionVisibility;
}

export interface UpdateRouteCollectionInput {
  title?: string;
  description?: string | null;
  visibility?: RouteCollectionVisibility;
}

export interface RouteCollectionListResponse {
  items: RouteCollectionSummary[];
  total: number;
}

export const routeCollectionsApi = {
  listMine: () => apiFetch<RouteCollectionListResponse>("/collections/me"),
  listLibrary: () =>
    apiFetch<RouteCollectionLibraryResponse>("/collections/me/library"),
  create: (input: CreateRouteCollectionInput) =>
    apiFetch<RouteCollectionDetail>("/collections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  get: (id: string) =>
    apiFetch<RouteCollectionDetail>(`/collections/${encodeURIComponent(id)}`),
  getBySlug: (slug: string) =>
    apiFetch<RouteCollectionDetail>(
      `/collections/by-slug/${encodeURIComponent(slug)}`,
    ),
  update: (id: string, input: UpdateRouteCollectionInput) =>
    apiFetch<RouteCollectionDetail>(`/collections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/collections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  addItem: (id: string, input: { trip_id?: string; ride_id?: string }) =>
    apiFetch<RouteCollectionItemResponse>(
      `/collections/${encodeURIComponent(id)}/items`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  removeItem: (id: string, itemId: string) =>
    apiFetch<void>(
      `/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { method: "DELETE" },
    ),
  follow: (id: string) =>
    apiFetch<RouteCollectionFollowResponse>(
      `/collections/${encodeURIComponent(id)}/follow`,
      { method: "POST" },
    ),
  unfollow: (id: string) =>
    apiFetch<void>(`/collections/${encodeURIComponent(id)}/follow`, {
      method: "DELETE",
    }),
};

// ── Map shares (US-50: read-only personal road-map snapshots) ──

export interface MapShareResponse {
  id: string;
  share_token: string;
  share_url: string;
  title: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface MapSharePublic {
  share_token: string;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface MapShareListResponse {
  items: MapShareResponse[];
  total: number;
}

export const mapSharesApi = {
  create: (payload: { title: string; snapshot: Record<string, unknown> }) =>
    apiFetch<MapShareResponse>("/map-shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMine: () => apiFetch<MapShareListResponse>("/map-shares/mine"),
  getByToken: (token: string) =>
    apiFetch<MapSharePublic>(`/map-shares/${encodeURIComponent(token)}`),
  revoke: (id: string) =>
    apiFetch(`/map-shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ── Hazards endpoints (public; not yet in spec) ──

export interface HazardResponse {
  id: string;
  lat: number;
  lng: number;
  hazard_type: string;
  severity: string;
  note: string | null;
  /** Public URL of the rider-attached photo, when present. */
  photo_url: string | null;
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
  /**
   * Author user id, used to deep-link the review byline to
   * `/community/[riderId]`. `null` when the author has been soft-deleted
   * (paired with the masked "Deleted user" display name) — the card
   * should render the name as plain text instead of a link.
   */
  user_id: string | null;
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

export interface ReviewPhotosResponse {
  photos: string[];
}

export const roadsApi = {
  getReviews: (segmentId: string, init?: RequestInit) =>
    apiFetch<RoadReview[]>(
      `/roads/${encodeURIComponent(segmentId)}/reviews`,
      init,
    ),
  uploadReviewPhotos: async (
    segmentId: string,
    files: File[],
  ): Promise<{ data: ReviewPhotosResponse }> => {
    // Multipart upload bypasses `apiFetch` because it forces a JSON
    // Content-Type — letting the browser set its own boundary header is
    // mandatory for the multer parser on the backend to find the files.
    const token = useAuthStore.getState().accessToken;
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }

    const res = await fetch(
      `${API_BASE}/roads/${encodeURIComponent(segmentId)}/reviews/photos`,
      {
        method: "POST",
        body,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );

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

    return { data: (await res.json()) as ReviewPhotosResponse };
  },
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
    apiFetch<NotificationPreferences>("/me/notification-preferences"),
  updateNotificationPreferences: (data: PartialNotificationPreferences) =>
    apiFetch<NotificationPreferences>("/me/notification-preferences", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  // #279: typed `/account/privacy` endpoint (GET/PUT). The backend
  // uses snake_case keys; the companion's UI types are camelCase, so
  // we translate at the boundary to keep the page code unchanged.
  getPrivacySettings: async (): Promise<{ data: PrivacySettings }> => {
    const { data } = await apiFetch<PrivacyPreferences>("/account/privacy");
    return { data: privacyFromBackend(data) };
  },
  updatePrivacySettings: async (
    data: PartialPrivacySettings,
  ): Promise<{ data: PrivacySettings }> => {
    const body = privacyToBackend(data);
    const { data: updated } = await apiFetch<PrivacyPreferences>(
      "/account/privacy",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    return { data: privacyFromBackend(updated) };
  },
};

function privacyFromBackend(p: PrivacyPreferences): PrivacySettings {
  return {
    profileVisibility: p.profile_visibility,
    defaultRideSharing: p.default_ride_sharing,
    roadDataContribution: p.road_data_contribution,
    locationRetention: p.location_retention,
    analyticsConsent: p.analytics_consent,
    personalizedRecommendationsConsent: p.personalized_recommendations_consent,
  };
}

function privacyToBackend(
  p: PartialPrivacySettings,
): Partial<PrivacyPreferences> {
  const out: Partial<PrivacyPreferences> = {};
  if (p.profileVisibility !== undefined) {
    out.profile_visibility = p.profileVisibility;
  }
  if (p.defaultRideSharing !== undefined) {
    out.default_ride_sharing = p.defaultRideSharing;
  }
  if (p.roadDataContribution !== undefined) {
    out.road_data_contribution = p.roadDataContribution;
  }
  if (p.locationRetention !== undefined) {
    out.location_retention = p.locationRetention;
  }
  if (p.analyticsConsent !== undefined) {
    out.analytics_consent = p.analyticsConsent;
  }
  if (p.personalizedRecommendationsConsent !== undefined) {
    out.personalized_recommendations_consent =
      p.personalizedRecommendationsConsent;
  }
  return out;
}
