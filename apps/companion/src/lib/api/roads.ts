import { useAuthStore } from "@/stores/auth";
import { API_BASE } from "@/lib/config";
import { apiFetch, ApiError } from "./client";
import type { HazardResponse } from "./hazards";

// ── Road reviews endpoints (US-55) ──

export interface RoadReview {
  id: string;
  /**
   * Author user id, used to deep-link the review byline to
   * `/community/[riderId]`. `null` when the author has been soft-deleted
   * (paired with the masked "Deleted user" display name) — the card
   * should render the name as plain text instead of a link.
   */
  user_id: string | null;
  user_display_name: string;
  rating: number;
  comment: string | null;
  bike_model: string | null;
  /**
   * Photo URLs attached to the review. `null` when the author has
   * been masked (deleted, soft-deleted, or `profile_visibility =
   * 'private'` to a non-self viewer) — managed photo URLs embed
   * the author's id in their filename, so the backend suppresses
   * the array on masked surfaces to avoid leaking the rider's
   * UUID through the path even when `user_id` is null
   * (#279 / #501).
   */
  photos: string[] | null;
  created_at: string;
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
  is_mine: boolean;
}

export interface ReviewVoteResult {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

export interface UpsertRoadReviewInput {
  rating: number;
  comment?: string;
  bike_model?: string;
  photos?: string[];
}

export interface ReviewPhotosResponse {
  photos: string[];
}

// ── Road segment detail ──

export interface TrendPointResponse {
  month: string;
  score: number;
}

export interface QualityBreakdownResponse {
  excellent: number;
  good: number;
  fair: number;
  poor: number;
  very_poor: number;
}

export interface SegmentPointResponse {
  lat: number;
  lng: number;
}

export interface RoadSegmentDetailResponse {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  segment_length_m: number;
  confidence: number;
  reading_count: number;
  last_updated: string;
  geometry: SegmentPointResponse[];
  elevation_min: number | null;
  elevation_max: number | null;
  elevation_profile: number[] | null;
  quality_breakdown: QualityBreakdownResponse;
  active_hazards: HazardResponse[];
  active_hazard_count: number;
  recent_reviews: RoadReview[];
  review_count: number;
  avg_review_rating: number | null;
  riders_per_month: number;
  quality_history: TrendPointResponse[];
  regional_quality_history: TrendPointResponse[];
}

export const roadsApi = {
  getSegmentDetail: (segmentId: string, init?: RequestInit) =>
    apiFetch<RoadSegmentDetailResponse>(
      `/roads/${encodeURIComponent(segmentId)}`,
      init,
    ),
  getReviews: (segmentId: string, init?: RequestInit) =>
    apiFetch<RoadReview[]>(
      `/roads/${encodeURIComponent(segmentId)}/reviews`,
      init,
    ),
  uploadReviewPhotos: async (
    segmentId: string,
    files: File[],
  ): Promise<{ data: ReviewPhotosResponse }> => {
    // Multipart upload bypasses `apiFetch` because it forces a JSON
    // Content-Type — letting the browser set its own boundary header is
    // mandatory for the multer parser on the backend to find the files.
    const token = useAuthStore.getState().accessToken;
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }

    const res = await fetch(
      `${API_BASE}/roads/${encodeURIComponent(segmentId)}/reviews/photos`,
      {
        method: "POST",
        body,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    );

    if (!res.ok) {
      if (res.status === 401) useAuthStore.getState().clearSession();
      const payload = await res.json().catch(() => ({}));
      throw new ApiError(
        (payload as { message?: string }).message ??
          `Request failed (${res.status})`,
        res.status,
        payload,
      );
    }

    return { data: (await res.json()) as ReviewPhotosResponse };
  },
  createReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    apiFetch<RoadReview>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateReview: (
    segmentId: string,
    data: UpsertRoadReviewInput,
    init?: RequestInit,
  ) =>
    apiFetch<RoadReview>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteReview: (segmentId: string, init?: RequestInit) =>
    apiFetch<void>(`/roads/${encodeURIComponent(segmentId)}/reviews`, {
      ...init,
      method: "DELETE",
    }),
  voteOnReview: (reviewId: string, isHelpful: boolean, init?: RequestInit) =>
    apiFetch<ReviewVoteResult>(
      `/roads/reviews/${encodeURIComponent(reviewId)}/vote`,
      {
        ...init,
        method: "POST",
        body: JSON.stringify({ is_helpful: isHelpful }),
      },
    ),
  clearReviewVote: (reviewId: string, init?: RequestInit) =>
    apiFetch<ReviewVoteResult>(
      `/roads/reviews/${encodeURIComponent(reviewId)}/vote`,
      {
        ...init,
        method: "DELETE",
      },
    ),
};
