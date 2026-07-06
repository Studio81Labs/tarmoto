import { api, openApiData } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

// ── Trip folders (US-37: rider-owned folders that sync across devices) ──

export type TripFolderResponse = JsonResponse<
  "/api/v1/trip-folders",
  "post",
  201
>;
export type TripFolderListResponse = JsonResponse<
  "/api/v1/trip-folders",
  "get",
  200
>;
export type CreateTripFolderInput = JsonRequest<"/api/v1/trip-folders", "post">;
export type UpdateTripFolderInput = JsonRequest<
  "/api/v1/trip-folders/{id}",
  "patch"
>;

export const tripFoldersApi = {
  list: () =>
    openApiData<TripFolderListResponse>(api.GET("/api/v1/trip-folders")),
  create: (input: CreateTripFolderInput) =>
    openApiData<TripFolderResponse>(
      api.POST("/api/v1/trip-folders", { body: input }),
    ),
  update: (id: string, input: UpdateTripFolderInput) =>
    openApiData<TripFolderResponse>(
      api.PATCH("/api/v1/trip-folders/{id}", {
        params: { path: { id } },
        body: input,
      }),
    ),
  delete: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trip-folders/{id}", {
        params: { path: { id } },
      }),
    ),
};
