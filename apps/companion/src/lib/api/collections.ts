import { apiFetch } from "./client";

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
  description?: string | undefined;
  visibility?: RouteCollectionVisibility | undefined;
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
