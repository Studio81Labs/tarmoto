import type { paths } from "@tarmoto/openapi-client";
import { api, openApiData } from "./client";
import type { JsonResponse } from "./client";

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
