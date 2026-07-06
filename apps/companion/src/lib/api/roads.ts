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
  getReviews: (segmentId: string, init?: RequestInit) =>
    openApiData<RoadReview[]>(
      api.GET("/api/v1/roads/{segmentId}/reviews", {
        params: { path: { segmentId } },
        ...reqSignal(init),
      }),
    ),
  uploadReviewPhotos: (segmentId: string, files: File[]) =>
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
