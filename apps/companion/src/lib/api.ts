import { getSession } from "next-auth/react";
import { createTarmotoClient } from "@tarmoto/openapi-client";
import { createTarmotoQueryClient } from "@tarmoto/openapi-client/react-query";
import type { paths } from "@tarmoto/openapi-client";
import type {
  InAppNotification,
  InAppNotificationListResponse,
  NotificationPreferences,
  PrivacyPreferences,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";
import type { PartialNotificationPreferences } from "./notification-preferences";
import type { MountainPass } from "./passes-summary";
import type { PartialPrivacySettings } from "./privacy-settings";
import type { PrivacySettings } from "./types";

// Typed openapi-fetch client for all spec-defined endpoints.
//
// `onUnauthorizedRetry` is the defense-in-depth pair to the
// SessionProvider `refetchInterval`: the poll keeps the access
// token fresh under normal continuous use, but a backgrounded
// tab can still wake up with a stale token and click Save before
// the focus-triggered session refresh lands. When that happens,
// `getSession()` forces the NextAuth `jwt` callback to rotate the
// token and we replay the request once with the new bearer —
// fully transparent to the caller. Only if THAT also 401s do we
// clear the session and bounce to /login.
export const api = createTarmotoClient({
  baseUrl: API_HOST,
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().clearSession(),
  onUnauthorizedRetry: async () => {
    const session = await getSession();
    if (!session?.accessToken) return null;
    // RefreshTokenError means the refresh round-trip failed — no
    // point replaying, just let the session clear normally.
    if (session.error === "RefreshTokenError") return null;
    // Hydrate the Zustand store inline so the raw-fetch helpers in
    // this file (`apiFetch`, FormData uploads, trip-share/collab
    // helpers) see the fresh token immediately — `AuthSync`'s
    // useEffect lands a tick later, and any caller firing in that
    // gap would otherwise read the stale token, hit 401, and clear
    // the session before the replayed typed-client call has had a
    // chance to succeed.
    if (session.user) {
      useAuthStore.getState().setSession(
        {
          id: session.user.id,
          email: session.user.email!,
          displayName: session.user.displayName,
          phone: session.user.phone,
        },
        session.accessToken,
      );
    }
    return session.accessToken;
  },
});

// React Query bindings on top of the same client. Hooks consume
// this as `$api.useQuery("get", "/api/v1/trips")` etc., inferring
// params + response shape from the generated `paths`.
export const $api = createTarmotoQueryClient(api);

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

// ── Transitional raw fetch helper ──
// Owner: companion web. Follow-up: #529 endpoint-family split for remaining
// raw helpers (auth bootstrap, trip folders/shares/collab, collections/map
// shares, hazards/closures/POI, community, passes, roads, users, notifications,
// and privacy) after the core trips/exploration/account contracts below.
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

type JsonResponse<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends number,
> = paths[Path][Method] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends { content: { "application/json": infer Body } }
      ? Body
      : void
    : never
  : never;

type JsonRequest<
  Path extends keyof paths,
  Method extends keyof paths[Path],
> = paths[Path][Method] extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

type OpenApiClientResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

async function openApiData<T>(
  resultPromise: Promise<OpenApiClientResult<T>>,
): Promise<{ data: T }> {
  const result = await resultPromise;
  if (result.error) {
    throw new ApiError(
      apiErrorMessage(result.error, result.response?.status ?? 0),
      result.response?.status ?? 0,
      result.error,
    );
  }
  return { data: result.data as T };
}

function apiErrorMessage(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return `Request failed (${status})`;
}

// ── Trip endpoints (generated OpenAPI contract) ──
export type ListTripsQuery = NonNullable<
  paths["/api/v1/trips"]["get"]["parameters"]["query"]
>;
export type TripSummaryResponse = JsonResponse<"/api/v1/trips", "get", 200>;
export type TripDetailResponse = JsonResponse<
  "/api/v1/trips/{tripId}",
  "get",
  200
>;
export type CreateTripInput = JsonRequest<"/api/v1/trips", "post">;
export type ImportTripInput = JsonRequest<"/api/v1/trips/import", "post">;
export type UpdateTripInput = JsonRequest<"/api/v1/trips/{tripId}", "patch">;
export type GenerateTripInput = JsonRequest<
  "/api/v1/trips/{tripId}/generate",
  "post"
>;
export type GenerateTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/generate",
  "post",
  201
>;
export type DuplicateTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/duplicate",
  "post",
  201
>;
export type InviteTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/invite",
  "post",
  202
>;
export type SaveRouteBody = JsonRequest<"/api/v1/trips/{tripId}/route", "put">;

export const tripsApi = {
  list: (params?: ListTripsQuery) =>
    openApiData<TripSummaryResponse>(
      api.GET("/api/v1/trips", params ? { params: { query: params } } : {}),
    ),
  get: (id: string) =>
    openApiData<TripDetailResponse>(
      api.GET("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
      }),
    ),
  create: (data: CreateTripInput) =>
    openApiData<TripDetailResponse>(api.POST("/api/v1/trips", { body: data })),
  importRoute: (data: ImportTripInput) =>
    openApiData<TripDetailResponse>(
      api.POST("/api/v1/trips/import", { body: data }),
    ),
  replaceImportedRoute: (id: string, data: ImportTripInput) =>
    openApiData<TripDetailResponse>(
      api.PUT("/api/v1/trips/{tripId}/import", {
        params: { path: { tripId: id } },
        body: data,
      }),
    ),
  update: (id: string, data: UpdateTripInput) =>
    openApiData<TripDetailResponse>(
      api.PATCH("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
        body: data,
      }),
    ),
  delete: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
      }),
    ),
  // POST /trips/:tripId/generate (US-7) — backend builds three preset
  // options (best-fit / scenic / fastest), persists the selected one,
  // and returns all three for side-by-side comparison.
  generate: (tripId: string, params: GenerateTripInput) =>
    openApiData<GenerateTripResponse>(
      api.POST("/api/v1/trips/{tripId}/generate", {
        params: { path: { tripId } },
        body: params,
      }),
    ),
  duplicate: (tripId: string) =>
    openApiData<DuplicateTripResponse>(
      api.POST("/api/v1/trips/{tripId}/duplicate", {
        params: { path: { tripId } },
      }),
    ),
  // POST /trips/:tripId/join — accept an invite by submitting the
  // trip id + invite code. Returns the trip detail on success and
  // 403s on a wrong code (folded with "no such trip" so the endpoint
  // can't be used to enumerate ids).
  join: (tripId: string, inviteCode: string) =>
    openApiData<TripDetailResponse>(
      api.POST("/api/v1/trips/{tripId}/join", {
        params: { path: { tripId } },
        body: { invite_code: inviteCode },
      }),
    ),
  // POST /trips/:tripId/invite — owner/admin only. Mail dispatch is
  // best-effort: the backend returns 202 + `{ status: "queued" }` once
  // the audit row lands, regardless of whether the email provider
  // accepted the message. The recipient does NOT need a Tarmoto
  // account; the email explains how to sign up and join.
  invite: (tripId: string, email: string, message?: string) =>
    openApiData<InviteTripResponse>(
      api.POST("/api/v1/trips/{tripId}/invite", {
        params: { path: { tripId } },
        body: message ? { email, message } : { email },
      }),
    ),
  // PUT /trips/:tripId/route — any trip member may submit waypoints;
  // the server re-routes via Valhalla, enriches via PostGIS, and
  // replaces day 1 atomically. Returns the full updated trip detail.
  saveRoute: (tripId: string, body: SaveRouteBody) =>
    openApiData<TripDetailResponse>(
      api.PUT("/api/v1/trips/{tripId}/route", {
        params: { path: { tripId } },
        body,
      }),
    ),
};

// ── Community trip endpoints (read-only, non-member view) ──
// Mirrors the way community ride detail reuses the ride read path. Backend
// gates visibility to trips exposed via a discoverable collection and masks
// the invite code + member roster (see PublicTripDetailDto).
export type PublicTripDetailResponse = JsonResponse<
  "/api/v1/community/trips/{tripId}",
  "get",
  200
>;

export const communityTripsApi = {
  getPublic: (tripId: string) =>
    openApiData<PublicTripDetailResponse>(
      api.GET("/api/v1/community/trips/{tripId}", {
        params: { path: { tripId } },
      }),
    ),
};

// ── Routing endpoint (generated OpenAPI contract) ──
export type RouteRequestBody = JsonRequest<"/api/v1/routing/route", "post">;
export type RouteResponse = JsonResponse<"/api/v1/routing/route", "post", 201>;

export const routingApi = {
  // POST /routing/route — road-snapped live preview through waypoints.
  // Accepts an optional AbortSignal via `init` so the live-planner hook
  // can cancel in-flight requests when waypoints change before the
  // previous response arrives.
  route: (body: RouteRequestBody, init?: { signal?: AbortSignal }) =>
    openApiData<RouteResponse>(
      api.POST("/api/v1/routing/route", { body, ...init }),
    ),
};

// ── Trip folders (US-37: rider-owned folders that sync across devices) ──

export interface TripFolderResponse {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface TripFolderListResponse {
  items: TripFolderResponse[];
  total: number;
}

export interface CreateTripFolderInput {
  name: string;
  color?: string | null;
}

export interface UpdateTripFolderInput {
  name?: string;
  color?: string | null;
  position?: number;
}

export const tripFoldersApi = {
  list: () => apiFetch<TripFolderListResponse>("/trip-folders"),
  create: (input: CreateTripFolderInput) =>
    apiFetch<TripFolderResponse>("/trip-folders", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: UpdateTripFolderInput) =>
    apiFetch<TripFolderResponse>(`/trip-folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/trip-folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

// ── Trip shares (US-35: read-only invite links, first slice) ──

export interface TripShareResponse {
  id: string;
  share_token: string;
  share_url: string;
  trip_id: string | null;
  title: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface TripSharePublic {
  share_token: string;
  trip_id: string | null;
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

export interface TripShareJoinResponse {
  trip_id: string;
  planner_url: string;
}

export const tripSharesApi = {
  create: (payload: {
    title: string;
    snapshot: Record<string, unknown>;
    trip_id?: string | null;
  }) =>
    apiFetch<TripShareResponse>("/trip-shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMine: () => apiFetch<TripShareListResponse>("/trip-shares/mine"),
  getByToken: (token: string) =>
    apiFetch<TripSharePublic>(`/trip-shares/${encodeURIComponent(token)}`),
  joinByToken: (token: string) =>
    apiFetch<TripShareJoinResponse>(
      `/trip-shares/${encodeURIComponent(token)}/join`,
      { method: "POST" },
    ),
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
  | "member_invited"
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

// ── Exploration endpoints (generated OpenAPI contract) ──
export type ExplorationStats = JsonResponse<
  "/api/v1/exploration/stats",
  "get",
  200
>;
export type UnriddenSegment = JsonResponse<
  "/api/v1/exploration/nearby-unridden",
  "get",
  200
>[number];
export type RiddenSegmentMeta = JsonResponse<
  "/api/v1/exploration/ridden-segments",
  "get",
  200
>["segments"][number];
export type NearbyUnriddenQuery = NonNullable<
  paths["/api/v1/exploration/nearby-unridden"]["get"]["parameters"]["query"]
>;

export const explorationApi = {
  getStats: () =>
    openApiData<ExplorationStats>(api.GET("/api/v1/exploration/stats")),
  getRiddenIds: () =>
    openApiData<JsonResponse<"/api/v1/exploration/ridden-ids", "get", 200>>(
      api.GET("/api/v1/exploration/ridden-ids"),
    ),
  getRiddenSegments: () =>
    openApiData<
      JsonResponse<"/api/v1/exploration/ridden-segments", "get", 200>
    >(api.GET("/api/v1/exploration/ridden-segments")),
  getNearbyUnridden: (params: NearbyUnriddenQuery) =>
    openApiData<
      JsonResponse<"/api/v1/exploration/nearby-unridden", "get", 200>
    >(
      api.GET("/api/v1/exploration/nearby-unridden", {
        params: { query: params },
      }),
    ),
};

// ── Route collections (US-56: cloud-synced shareable collections) ──

export type RouteCollectionVisibility = "private" | "unlisted" | "public";

export interface RouteCollectionSummary {
  id: string;
  /**
   * Owner uuid, or `null` when the owning rider has set
   * `profile_visibility = 'private'` and the viewer is not the
   * owner — masked alongside `owner_name` so the id can't be
   * cross-referenced to recover the rider's identity (#279 / #501).
   */
  owner_id: string | null;
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
  /** Riders following this collection. 0 for a brand-new collection. */
  follower_count: number;
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

/**
 * Map-preview payload for the public collection page (#358). Each item is a
 * collection_items row with the simplified polylines that should render on
 * the map. `lines` is empty when the underlying trip/ride was deleted or
 * has no recorded geometry — the map drops those silently while the list
 * still renders a placeholder row.
 */
export interface RouteCollectionPreviewItem {
  item_id: string;
  position: number;
  kind: "trip" | "ride";
  /**
   * UUID of the underlying trip (kind="trip") or ride (kind="ride"). Combined
   * with `kind` the client deep-links to the detail view (`/community/trips/:id`
   * or `/community/rides/:id`). Always set; may point at a since-deleted entity,
   * in which case `lines` is empty and the link 404s gracefully.
   */
  target_id: string | null;
  /** Each entry is a polyline as an array of [lng, lat] pairs (GeoJSON LineString). */
  lines: number[][][];
  // Per-item summary fields so a non-owner viewer — the public shared page and
  // the member discover view — can render the route rows without the viewer's
  // own trip/ride cache. All `null` for a deleted item; `num_days` is `null`
  // for rides (a single recorded day).
  title: string | null;
  num_days: number | null;
  distance_km: number | null;
  status: string | null;
  quality_avg: number | null;
}

export interface RouteCollectionPreviewResponse {
  routes: RouteCollectionPreviewItem[];
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
  getPreviewBySlug: (slug: string) =>
    apiFetch<RouteCollectionPreviewResponse>(
      `/collections/by-slug/${encodeURIComponent(slug)}/preview`,
    ),
  // Owner-by-id preview — per-item route geometry for the caller's own
  // collection (any visibility, incl. private). Powers the owner detail-page
  // route-row thumbnails.
  getPreviewById: (id: string) =>
    apiFetch<RouteCollectionPreviewResponse>(
      `/collections/${encodeURIComponent(id)}/preview`,
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
  reorderItems: (id: string, itemIds: readonly string[]) =>
    apiFetch<RouteCollectionDetail>(
      `/collections/${encodeURIComponent(id)}/items/reorder`,
      { method: "PATCH", body: JSON.stringify({ item_ids: itemIds }) },
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

// ── Hazards endpoints (public; transitional raw helper, follow-up #529) ──

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

export interface TrendPointResponse {
  month: string;
  score: number;
}

export interface QualityBreakdownResponse {
  excellent: number;
  good: number;
  fair: number;
  poor: number;
  very_poor: number;
}

export interface SegmentPointResponse {
  lat: number;
  lng: number;
}

export interface RoadSegmentDetailResponse {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
  reading_count: number;
  last_updated: string;
  geometry: SegmentPointResponse[];
  elevation_min: number | null;
  elevation_max: number | null;
  elevation_profile: number[] | null;
  quality_breakdown: QualityBreakdownResponse;
  active_hazards: HazardResponse[];
  active_hazard_count: number;
  recent_reviews: RoadReview[];
  review_count: number;
  avg_review_rating: number | null;
  riders_per_month: number;
  quality_history: TrendPointResponse[];
  regional_quality_history: TrendPointResponse[];
}

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
  getAccommodations: (
    params: {
      lat: number;
      lng: number;
      radius_km?: number;
      min_stars?: number;
      kinds?: AccommodationKind[];
    },
    init?: RequestInit,
  ) => {
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
      init,
    );
  },
  getAlongRoute: (
    data: {
      route: Array<{ lat: number; lng: number }>;
      buffer_km?: number;
      kinds?: PoiKind[];
    },
    init?: RequestInit,
  ) =>
    apiFetch<AlongRoutePoisResponse>("/poi/along-route", {
      ...init,
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
  /**
   * Photo URLs attached to the review. `null` when the author has
   * been masked (deleted, soft-deleted, or `profile_visibility =
   * 'private'` to a non-self viewer) — managed photo URLs embed
   * the author's id in their filename, so the backend suppresses
   * the array on masked surfaces to avoid leaking the rider's
   * UUID through the path even when `user_id` is null
   * (#279 / #501).
   */
  photos: string[] | null;
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
  getSegmentDetail: (segmentId: string, init?: RequestInit) =>
    apiFetch<RoadSegmentDetailResponse>(
      `/roads/${encodeURIComponent(segmentId)}`,
      init,
    ),
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

// ── Account endpoints (generated OpenAPI contract where available) ──
export type SubscriptionSnapshotResponse = JsonResponse<
  "/api/v1/account/subscription",
  "get",
  200
>;
export type CreateCheckoutSessionInput = JsonRequest<
  "/api/v1/account/subscription/checkout",
  "post"
>;
export type CreatePortalSessionInput = JsonRequest<
  "/api/v1/account/subscription/portal",
  "post"
>;
export type RedirectUrlResponse = JsonResponse<
  "/api/v1/account/subscription/checkout",
  "post",
  201
>;
export type BikeResponse = JsonResponse<
  "/api/v1/account/bikes",
  "get",
  200
>[number];
export type CreateBikeInput = JsonRequest<"/api/v1/account/bikes", "post">;
export type UpdateBikeInput = JsonRequest<
  "/api/v1/account/bikes/{id}",
  "patch"
>;
export type DataExportRequestView = JsonResponse<
  "/api/v1/account/data-export",
  "post",
  202
>;
export type DeleteAccountInput = JsonRequest<"/api/v1/account", "delete">;
export type DeleteAccountResponse = JsonResponse<
  "/api/v1/account",
  "delete",
  200
>;

export const accountApi = {
  // Profile updates use `usersApi.updateMe` (PATCH /users/me) — the
  // canonical path agreed across mobile + web. The previous
  // `accountApi.updateProfile` shim hit `/account/profile` which the
  // backend never exposed; it was a dead caller and has been removed.
  getSubscription: () =>
    openApiData<SubscriptionSnapshotResponse>(
      api.GET("/api/v1/account/subscription"),
    ),
  createCheckoutSession: (data: CreateCheckoutSessionInput) =>
    openApiData<RedirectUrlResponse>(
      api.POST("/api/v1/account/subscription/checkout", { body: data }),
    ),
  createPortalSession: (
    data: Partial<CreatePortalSessionInput> = { flow: "manage" },
  ) =>
    openApiData<RedirectUrlResponse>(
      api.POST("/api/v1/account/subscription/portal", {
        body: data as CreatePortalSessionInput,
      }),
    ),
  getBikes: () => openApiData<BikeResponse[]>(api.GET("/api/v1/account/bikes")),
  addBike: (data: CreateBikeInput) =>
    openApiData<BikeResponse>(
      api.POST("/api/v1/account/bikes", { body: data }),
    ),
  updateBike: (id: string, data: UpdateBikeInput) =>
    openApiData<BikeResponse>(
      api.PATCH("/api/v1/account/bikes/{id}", {
        params: { path: { id } },
        body: data,
      }),
    ),
  deleteBike: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/account/bikes/{id}", {
        params: { path: { id } },
      }),
    ),
  requestDataExport: () =>
    openApiData<DataExportRequestView>(api.POST("/api/v1/account/data-export")),
  getDataExport: (id: string) =>
    openApiData<DataExportRequestView>(
      api.GET("/api/v1/account/data-export/{id}", {
        params: { path: { id } },
      }),
    ),
  deleteAccount: (input: DeleteAccountInput) =>
    openApiData<DeleteAccountResponse>(
      api.DELETE("/api/v1/account", { body: input }),
    ),
  // Transitional raw helpers owned by companion/settings until #529 follow-up:
  // push notification preference endpoints are already represented in shared
  // DTOs, but the page still maps through local partial update types.
  getNotificationPreferences: () =>
    apiFetch<NotificationPreferences>("/me/notification-preferences"),
  updateNotificationPreferences: (data: PartialNotificationPreferences) =>
    apiFetch<NotificationPreferences>("/me/notification-preferences", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getNotifications: () =>
    apiFetch<InAppNotificationListResponse>("/me/notifications"),
  markNotificationRead: (id: string) =>
    apiFetch<InAppNotification>(
      `/me/notifications/${encodeURIComponent(id)}/read`,
      { method: "PATCH" },
    ),
  markAllNotificationsRead: () =>
    apiFetch<InAppNotificationListResponse>("/me/notifications/read-all", {
      method: "PATCH",
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
