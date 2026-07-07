import type { components, paths } from "@tarmoto/openapi-client";
import { api, openApiData } from "./client";

// ── Community feed endpoints (US-53 companion feed) ──

export type CommunityRidePage =
  components["schemas"]["CommunityRidesResponseDto"];
export type CommunityRide = CommunityRidePage["items"][number];
export type RideLikeResult = components["schemas"]["RideLikeResponseDto"];
export type CloneRideResult = components["schemas"]["CloneRideResponseDto"];
export type CommunityRideQuery = NonNullable<
  paths["/api/v1/rides/community"]["get"]["parameters"]["query"]
>;
export type CommunityRideSort = NonNullable<CommunityRideQuery["sort"]>;

export const communityApi = {
  list: (params: CommunityRideQuery) =>
    openApiData<CommunityRidePage>(
      api.GET("/api/v1/rides/community", { params: { query: params } }),
    ),
  like: (rideId: string) =>
    openApiData<RideLikeResult>(
      api.POST("/api/v1/rides/{rideId}/like", {
        params: { path: { rideId } },
      }),
    ),
  unlike: (rideId: string) =>
    openApiData<RideLikeResult>(
      api.DELETE("/api/v1/rides/{rideId}/like", {
        params: { path: { rideId } },
      }),
    ),
  clone: (rideId: string) =>
    openApiData<CloneRideResult>(
      api.POST("/api/v1/rides/{rideId}/clone", {
        params: { path: { rideId } },
      }),
    ),
};
