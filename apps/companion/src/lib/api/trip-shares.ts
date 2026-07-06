import { api, openApiData } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

// ── Trip shares (US-35: read-only invite links, first slice) ──

export type TripShareResponse = JsonResponse<
  "/api/v1/trip-shares",
  "post",
  201
>;
export type TripSharePublic = JsonResponse<
  "/api/v1/trip-shares/{token}",
  "get",
  200
>;
export type TripShareListResponse = JsonResponse<
  "/api/v1/trip-shares/mine",
  "get",
  200
>;
export type TripShareJoinResponse = JsonResponse<
  "/api/v1/trip-shares/{token}/join",
  "post",
  201
>;

export const tripSharesApi = {
  create: (payload: JsonRequest<"/api/v1/trip-shares", "post">) =>
    openApiData<TripShareResponse>(
      api.POST("/api/v1/trip-shares", { body: payload }),
    ),
  listMine: () =>
    openApiData<TripShareListResponse>(api.GET("/api/v1/trip-shares/mine")),
  getByToken: (token: string) =>
    openApiData<TripSharePublic>(
      api.GET("/api/v1/trip-shares/{token}", {
        params: { path: { token } },
      }),
    ),
  joinByToken: (token: string) =>
    openApiData<TripShareJoinResponse>(
      api.POST("/api/v1/trip-shares/{token}/join", {
        params: { path: { token } },
      }),
    ),
  revoke: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/trip-shares/{id}", {
        params: { path: { id } },
      }),
    ),
};
