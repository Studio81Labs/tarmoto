import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonRequest } from "./client";

// ── Road reviews endpoints (US-55) ──

export type RoadReview = components["schemas"]["ReviewResponseDto"];
export type ReviewVoteResult = components["schemas"]["ReviewVoteResultDto"];
export type ReviewPhotosResponse =
  components["schemas"]["ReviewPhotosResponseDto"];
export type UpsertRoadReviewInput = JsonRequest<
  "/api/v1/roads/{segmentId}/reviews",
  "post"
>;

// ── Route quality overlay (planner, #862) ──

export type RouteQualityRequest = JsonRequest<
  "/api/v1/roads/route-quality",
  "post"
>;
export type RouteQualityResponse =
  components["schemas"]["RouteQualityResponseDto"];
export type RouteQualitySegment =
  components["schemas"]["RouteQualitySegmentDto"];

// ── Road segment detail ──

export type RoadSegmentDetailResponse =
  components["schemas"]["RoadSegmentDetailDto"];
export type QualityBreakdownResponse =
  RoadSegmentDetailResponse["quality_breakdown"];
export type SegmentPointResponse =
  RoadSegmentDetailResponse["geometry"][number];
export type TrendPointResponse =
  RoadSegmentDetailResponse["quality_history"][number];

export const roadsApi = {
  getSegmentDetail: (segmentId: string, init?: RequestInit) =>
    openApiData<RoadSegmentDetailResponse>(
      api.GET("/api/v1/roads/{segmentId}", {
        params: { path: { segmentId } },
        ...reqSignal(init),
      }),
    ),
  /**
   * Per-segment surface quality for a routed polyline (planner overlay).
   * Returns quality spans ordered along the route, or an empty list when no
   * imported segments cover the route (caller renders the whole line as
   * "no data").
   */
  getRouteQuality: (data: RouteQualityRequest, init?: RequestInit) =>
    openApiData<RouteQualityResponse>(
      api.POST("/api/v1/roads/route-quality", {
        body: data,
        ...reqSignal(init),
      }),
    ),
  getReviews: (segmentId: string, init?: RequestInit) =>
    openApiData<RoadReview[]>(
      api.GET("/api/v1/roads/{segmentId}/reviews", {
        params: { path: { segmentId } },
        ...reqSignal(init),
      }),
    ),
  /**
   * The optional `init` carries an abort `signal` (openapi-fetch forwards it
   * to `fetch`) so callers can cancel an upload whose result they no longer
   * want — otherwise the backend persists a file whose URL is thrown away,
   * an orphan (#1210).
   */
  uploadReviewPhotos: (segmentId: string, files: File[], init?: RequestInit) =>
    openApiData<ReviewPhotosResponse>(
      api.POST("/api/v1/roads/{segmentId}/reviews/photos", {
        params: { path: { segmentId } },
        // Multipart: the schema types the body as `{ files: string[] }`, but we
        // send real `File`s. Route them through a FormData bodySerializer so the
        // browser sets the multipart boundary — openapi-fetch skips its JSON
        // Content-Type when the serialized body is a FormData.
        body: { files } as unknown as { files: string[] },
        bodySerializer(body) {
          const form = new FormData();
          for (const file of (body as unknown as { files: File[] }).files) {
            form.append("files", file);
          }
          return form;
        },
        ...reqSignal(init),
      }),
    ),
  createReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    openApiData<RoadReview>(
      api.POST("/api/v1/roads/{segmentId}/reviews", {
        params: { path: { segmentId } },
        body: data,
        ...reqSignal(init),
      }),
    ),
  updateReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    openApiData<RoadReview>(
      api.PUT("/api/v1/roads/{segmentId}/reviews", {
        params: { path: { segmentId } },
        body: data,
        ...reqSignal(init),
      }),
    ),
  deleteReview: (segmentId: string, init?: RequestInit) =>
    openApiData<void>(
      api.DELETE("/api/v1/roads/{segmentId}/reviews", {
        params: { path: { segmentId } },
        ...reqSignal(init),
      }),
    ),
  voteOnReview: (reviewId: string, isHelpful: boolean, init?: RequestInit) =>
    openApiData<ReviewVoteResult>(
      api.POST("/api/v1/roads/reviews/{reviewId}/vote", {
        params: { path: { reviewId } },
        body: { is_helpful: isHelpful },
        ...reqSignal(init),
      }),
    ),
  clearReviewVote: (reviewId: string, init?: RequestInit) =>
    openApiData<ReviewVoteResult>(
      api.DELETE("/api/v1/roads/reviews/{reviewId}/vote", {
        params: { path: { reviewId } },
        ...reqSignal(init),
      }),
    ),
};
