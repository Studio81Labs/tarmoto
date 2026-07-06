import { api, openApiData } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

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
