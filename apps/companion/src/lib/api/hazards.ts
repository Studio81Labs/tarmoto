import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";

// ── Hazards endpoints (public) ──

export type HazardResponse = components["schemas"]["HazardResponseDto"];

export const hazardsApi = {
  findNearby: (
    params: { lat: number; lng: number; radius?: number; types?: string },
    init?: RequestInit,
  ) =>
    openApiData<HazardResponse[]>(
      api.GET("/api/v1/hazards", {
        params: { query: params },
        ...reqSignal(init),
      }),
    ),
};
