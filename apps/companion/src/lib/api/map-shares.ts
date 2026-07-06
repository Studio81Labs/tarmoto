import type { components } from "@tarmoto/openapi-client";
import { api, openApiData } from "./client";
import type { JsonRequest } from "./client";

// ── Map shares (US-50: read-only personal road-map snapshots) ──

export type MapShareResponse = components["schemas"]["MapShareResponseDto"];
export type MapSharePublic = components["schemas"]["MapSharePublicDto"];
export type MapShareListResponse =
  components["schemas"]["MapShareListResponseDto"];

export const mapSharesApi = {
  create: (payload: JsonRequest<"/api/v1/map-shares", "post">) =>
    openApiData<MapShareResponse>(
      api.POST("/api/v1/map-shares", { body: payload }),
    ),
  listMine: () =>
    openApiData<MapShareListResponse>(api.GET("/api/v1/map-shares/mine")),
  getByToken: (token: string) =>
    openApiData<MapSharePublic>(
      api.GET("/api/v1/map-shares/{token}", { params: { path: { token } } }),
    ),
  revoke: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/map-shares/{id}", { params: { path: { id } } }),
    ),
};
