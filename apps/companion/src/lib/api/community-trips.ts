import { api, openApiData } from "./client";
import type { JsonResponse } from "./client";

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
