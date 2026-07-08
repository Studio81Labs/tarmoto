import type { components } from "@tarmoto/openapi-client";
import { api, openApiData } from "./client";
import type { JsonRequest } from "./client";

// ── Route collections (US-56: cloud-synced shareable collections) ──

export type RouteCollectionSummary =
  components["schemas"]["RouteCollectionSummaryDto"];
export type RouteCollectionVisibility = RouteCollectionSummary["visibility"];
export type RouteCollectionItemResponse =
  components["schemas"]["RouteCollectionItemResponseDto"];
export type RouteCollectionDetail =
  components["schemas"]["RouteCollectionDetailDto"];
export type RouteCollectionFollowResponse =
  components["schemas"]["RouteCollectionFollowResponseDto"];
export type RouteCollectionLibraryResponse =
  components["schemas"]["RouteCollectionLibraryResponseDto"];
export type RouteCollectionListResponse =
  components["schemas"]["RouteCollectionListResponseDto"];
export type RouteCollectionPreviewItem =
  components["schemas"]["RouteCollectionPreviewItemDto"];
export type RouteCollectionPreviewResponse =
  components["schemas"]["RouteCollectionPreviewResponseDto"];
export type CreateRouteCollectionInput = JsonRequest<
  "/api/v1/collections",
  "post"
>;
export type UpdateRouteCollectionInput = JsonRequest<
  "/api/v1/collections/{id}",
  "patch"
>;

export const routeCollectionsApi = {
  listMine: () =>
    openApiData<RouteCollectionListResponse>(api.GET("/api/v1/collections/me")),
  listLibrary: () =>
    openApiData<RouteCollectionLibraryResponse>(
      api.GET("/api/v1/collections/me/library"),
    ),
  create: (input: CreateRouteCollectionInput) =>
    openApiData<RouteCollectionDetail>(
      api.POST("/api/v1/collections", { body: input }),
    ),
  get: (id: string) =>
    openApiData<RouteCollectionDetail>(
      api.GET("/api/v1/collections/{id}", { params: { path: { id } } }),
    ),
  getBySlug: (slug: string) =>
    openApiData<RouteCollectionDetail>(
      api.GET("/api/v1/collections/by-slug/{slug}", {
        params: { path: { slug } },
      }),
    ),
  getPreviewBySlug: (slug: string) =>
    openApiData<RouteCollectionPreviewResponse>(
      api.GET("/api/v1/collections/by-slug/{slug}/preview", {
        params: { path: { slug } },
      }),
    ),
  // Owner-by-id preview — per-item route geometry for the caller's own
  // collection (any visibility, incl. private). Powers the owner detail-page
  // route-row thumbnails.
  getPreviewById: (id: string) =>
    openApiData<RouteCollectionPreviewResponse>(
      api.GET("/api/v1/collections/{id}/preview", {
        params: { path: { id } },
      }),
    ),
  update: (id: string, input: UpdateRouteCollectionInput) =>
    openApiData<RouteCollectionDetail>(
      api.PATCH("/api/v1/collections/{id}", {
        params: { path: { id } },
        body: input,
      }),
    ),
  delete: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/collections/{id}", { params: { path: { id } } }),
    ),
  // Collections hold rides only; `ride_id` is the sole (required) target.
  addItem: (id: string, input: { ride_id: string }) =>
    openApiData<RouteCollectionItemResponse>(
      api.POST("/api/v1/collections/{id}/items", {
        params: { path: { id } },
        body: input,
      }),
    ),
  removeItem: (id: string, itemId: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/collections/{id}/items/{itemId}", {
        params: { path: { id, itemId } },
      }),
    ),
  reorderItems: (id: string, itemIds: readonly string[]) =>
    openApiData<RouteCollectionDetail>(
      api.PATCH("/api/v1/collections/{id}/items/reorder", {
        params: { path: { id } },
        body: { item_ids: [...itemIds] },
      }),
    ),
  follow: (id: string) =>
    openApiData<RouteCollectionFollowResponse>(
      api.POST("/api/v1/collections/{id}/follow", { params: { path: { id } } }),
    ),
  unfollow: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/collections/{id}/follow", {
        params: { path: { id } },
      }),
    ),
};
