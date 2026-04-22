"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Images,
  Loader2,
  Plus,
  Star,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { roadsApi, type RoadReview } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";

const MAX_REVIEW_PHOTOS = 5;

type ReviewDraft = {
  rating: number;
  comment: string;
  bikeModel: string;
  photoUrls: string[];
};

const EMPTY_REVIEW_DRAFT: ReviewDraft = {
  rating: 0,
  comment: "",
  bikeModel: "",
  photoUrls: [""],
};

export function RoadReviewsPanel({ segmentId }: { segmentId: string }) {
  const canLoadReviews = isUuid(segmentId);
  const [reviews, setReviews] = useState<RoadReview[]>([]);
  const [loading, setLoading] = useState(canLoadReviews);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_REVIEW_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const activeSegmentRef = useRef(segmentId);
  const requestGenerationRef = useRef(0);
  const submitAttemptRef = useRef(0);

  useEffect(() => {
    activeSegmentRef.current = segmentId;
    requestGenerationRef.current += 1;
    setDraft(EMPTY_REVIEW_DRAFT);
    setSubmitError(null);
    setSubmitting(false);

    if (!canLoadReviews) {
      setReviews([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setReviews([]);
    setLoading(true);
    setError(null);

    roadsApi
      .getReviews(segmentId)
      .then(({ data }) => {
        if (cancelled) return;
        setReviews((current) => mergeFetchedReviews(data, current));
      })
      .catch((err) => {
        if (cancelled) return;
        setReviews([]);
        setError(
          err instanceof Error ? err.message : "Could not load reviews.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canLoadReviews, segmentId]);

  const averageRating = useMemo(() => {
    if (reviews.length === 0) return null;
    const total = reviews.reduce((sum, review) => sum + review.rating, 0);
    return total / reviews.length;
  }, [reviews]);

  const patchReview = (reviewId: string, next: Partial<RoadReview>) => {
    setReviews((current) =>
      current.map((review) =>
        review.id === reviewId ? { ...review, ...next } : review,
      ),
    );
  };

  const handleSubmitReview = async () => {
    if (loading || submitting) return;

    const rating = draft.rating;
    if (rating < 1 || rating > 5) {
      setSubmitError("Choose a star rating before posting.");
      return;
    }

    const photoResult = sanitizePhotoUrls(draft.photoUrls);
    if ("error" in photoResult) {
      setSubmitError(photoResult.error);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    const requestGeneration = requestGenerationRef.current;
    const requestSegmentId = segmentId;
    submitAttemptRef.current += 1;
    const submitAttempt = submitAttemptRef.current;

    try {
      const { data } = await roadsApi.createReview(segmentId, {
        rating,
        comment: draft.comment.trim() || undefined,
        bike_model: draft.bikeModel.trim() || undefined,
        photos: photoResult.photos.length > 0 ? photoResult.photos : undefined,
      });
      if (requestSegmentId !== activeSegmentRef.current) {
        return;
      }

      const didReturnToSameSegment =
        requestGeneration !== requestGenerationRef.current;
      const isLatestSubmit = submitAttempt === submitAttemptRef.current;
      setError(null);
      setReviews((current) => [
        data,
        ...current.filter((r) => r.id !== data.id),
      ]);

      if (isLatestSubmit) {
        setSubmitError(null);
      }

      if (isLatestSubmit && !didReturnToSameSegment) {
        setDraft(EMPTY_REVIEW_DRAFT);
      }
    } catch (err) {
      if (
        requestSegmentId !== activeSegmentRef.current ||
        submitAttempt !== submitAttemptRef.current
      ) {
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : "Could not post your review.",
      );
    } finally {
      if (
        requestGeneration === requestGenerationRef.current &&
        requestSegmentId === activeSegmentRef.current
      ) {
        setSubmitting(false);
      }
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            Road reviews
          </p>
          {!loading && canLoadReviews && (
            <p className="text-sm text-slate-300">
              {reviews.length === 1 ? "1 review" : `${reviews.length} reviews`}
            </p>
          )}
        </div>
        {!loading && averageRating != null && (
          <p className="text-sm font-medium text-amber-300">
            {averageRating.toFixed(1)} ★ average
          </p>
        )}
      </div>

      {canLoadReviews && (
        <ReviewComposer
          draft={draft}
          loading={loading}
          submitting={submitting}
          error={submitError}
          onRatingChange={(rating) => {
            setDraft((current) => ({ ...current, rating }));
            setSubmitError(null);
          }}
          onCommentChange={(comment) => {
            setDraft((current) => ({ ...current, comment }));
            setSubmitError(null);
          }}
          onBikeModelChange={(bikeModel) => {
            setDraft((current) => ({ ...current, bikeModel }));
            setSubmitError(null);
          }}
          onPhotoChange={(index, value) => {
            setDraft((current) => ({
              ...current,
              photoUrls: current.photoUrls.map((photo, idx) =>
                idx === index ? value : photo,
              ),
            }));
            setSubmitError(null);
          }}
          onAddPhoto={() => {
            setDraft((current) => {
              if (current.photoUrls.length >= MAX_REVIEW_PHOTOS) return current;
              return { ...current, photoUrls: [...current.photoUrls, ""] };
            });
            setSubmitError(null);
          }}
          onRemovePhoto={(index) => {
            setDraft((current) => ({
              ...current,
              photoUrls:
                current.photoUrls.length === 1
                  ? [""]
                  : current.photoUrls.filter((_, idx) => idx !== index),
            }));
            setSubmitError(null);
          }}
          onSubmit={handleSubmitReview}
        />
      )}

      {!canLoadReviews ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-4 text-xs text-slate-500">
          Community reviews become available when this segment maps to a saved
          Tarmoto road.
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
          <Loader2 size={14} className="animate-spin" />
          Loading reviews…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : reviews.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-4 text-xs text-slate-500">
          No reviews yet. Riders will start seeing community feedback here as
          soon as someone rates this road.
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              onChange={(next) => patchReview(review.id, next)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function mergeFetchedReviews(
  fetched: RoadReview[],
  current: RoadReview[],
): RoadReview[] {
  if (current.length === 0) {
    return fetched;
  }

  const fetchedIds = new Set(fetched.map((review) => review.id));
  const localOnlyReviews = current.filter(
    (review) => !fetchedIds.has(review.id),
  );

  return [...localOnlyReviews, ...fetched];
}

function ReviewComposer({
  draft,
  loading,
  submitting,
  error,
  onRatingChange,
  onCommentChange,
  onBikeModelChange,
  onPhotoChange,
  onAddPhoto,
  onRemovePhoto,
  onSubmit,
}: {
  draft: ReviewDraft;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  onRatingChange: (rating: number) => void;
  onCommentChange: (comment: string) => void;
  onBikeModelChange: (bikeModel: string) => void;
  onPhotoChange: (index: number, value: string) => void;
  onAddPhoto: () => void;
  onRemovePhoto: (index: number) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="mb-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">
            Share your ride feedback
          </p>
          <p className="text-xs text-slate-500">
            Rate this road and add quick notes for the next rider.
          </p>
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={loading || submitting}
          className="rounded-lg bg-tarmoto-cyan px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-tarmoto-cyan-light disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Post review"
        >
          {submitting ? "Posting…" : "Post review"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5].map((rating) => {
          const active = draft.rating === rating;
          return (
            <button
              key={rating}
              type="button"
              aria-label={`${rating} stars`}
              aria-pressed={active}
              onClick={() => onRatingChange(rating)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
                active
                  ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
              }`}
            >
              <Star size={12} className={active ? "fill-current" : ""} />
              <span>{rating}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <label
            htmlFor="road-review-comment"
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            Your review
          </label>
          <textarea
            id="road-review-comment"
            value={draft.comment}
            onChange={(event) => onCommentChange(event.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="What stood out about this segment?"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-tarmoto-cyan focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="road-review-bike-model"
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            Bike model
          </label>
          <input
            id="road-review-bike-model"
            type="text"
            value={draft.bikeModel}
            onChange={(event) => onBikeModelChange(event.target.value)}
            maxLength={100}
            placeholder="Optional"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-tarmoto-cyan focus:outline-none"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-3">
            <label className="block text-xs font-medium text-slate-400">
              Photo URLs
            </label>
            <button
              type="button"
              onClick={onAddPhoto}
              disabled={draft.photoUrls.length >= MAX_REVIEW_PHOTOS}
              className="inline-flex items-center gap-1 text-xs text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Add another photo"
            >
              <Plus size={12} />
              Add another photo
            </button>
          </div>
          <div className="space-y-2">
            {draft.photoUrls.map((photo, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  aria-label={`Photo URL ${index + 1}`}
                  type="url"
                  value={photo}
                  onChange={(event) => onPhotoChange(index, event.target.value)}
                  placeholder="https://cdn.example.com/road-shot.jpg"
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-tarmoto-cyan focus:outline-none"
                />
                {draft.photoUrls.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRemovePhoto(index)}
                    className="rounded-md p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
                    aria-label={`Remove photo URL ${index + 1}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Add up to {MAX_REVIEW_PHOTOS} hosted photos using secure HTTPS URLs.
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-xs text-rose-300" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ReviewCard({
  review,
  onChange,
}: {
  review: RoadReview;
  onChange: (next: Partial<RoadReview>) => void;
}) {
  const [pendingVote, setPendingVote] = useState<"up" | "down" | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const photos = Array.isArray(review.photos) ? review.photos : [];

  const submitVote = async (isHelpful: boolean) => {
    if (pendingVote) return;

    const wasSame = review.my_vote === isHelpful;
    const previous = {
      helpful_count: review.helpful_count,
      not_helpful_count: review.not_helpful_count,
      my_vote: review.my_vote,
    };

    setPendingVote(isHelpful ? "up" : "down");
    setVoteError(null);
    onChange(applyVoteDelta(review, wasSame ? null : isHelpful));

    try {
      const { data } = wasSame
        ? await roadsApi.clearReviewVote(review.id)
        : await roadsApi.voteOnReview(review.id, isHelpful);
      onChange(data);
      setVoteError(null);
    } catch (err) {
      onChange(previous);
      setVoteError(
        err instanceof Error ? err.message : "Could not submit vote.",
      );
    } finally {
      setPendingVote(null);
    }
  };

  return (
    <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">
            {review.user_display_name}
          </p>
          <p className="text-xs text-slate-500">
            {formatRelativeTime(review.created_at)}
          </p>
        </div>
        <p className="shrink-0 text-sm font-medium text-amber-300">
          {"★".repeat(Math.max(1, Math.min(5, Math.round(review.rating))))}
        </p>
      </div>

      {review.comment && (
        <p className="mt-2 text-sm text-slate-300">{review.comment}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {review.bike_model && <span>{review.bike_model}</span>}
        {photos.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Images size={12} />
            {photos.length} photo{photos.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${photo}-${index}`}
              src={photo}
              alt={`${review.user_display_name} review photo ${index + 1}`}
              className="aspect-[4/3] rounded-lg object-cover"
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <VoteButton
          label={
            review.my_vote === true
              ? "Remove helpful vote"
              : "Mark this review as helpful"
          }
          count={review.helpful_count}
          active={review.my_vote === true}
          pending={pendingVote === "up"}
          icon={<ThumbsUp size={12} />}
          onClick={() => submitVote(true)}
        />
        <VoteButton
          label={
            review.my_vote === false
              ? "Remove not-helpful vote"
              : "Mark this review as not helpful"
          }
          count={review.not_helpful_count}
          active={review.my_vote === false}
          pending={pendingVote === "down"}
          icon={<ThumbsDown size={12} />}
          onClick={() => submitVote(false)}
        />
      </div>

      {voteError && (
        <p className="mt-2 text-xs text-rose-300" role="alert">
          {voteError}
        </p>
      )}
    </article>
  );
}

function VoteButton({
  label,
  count,
  active,
  pending,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  pending: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={pending}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
        active
          ? "border-tarmoto-cyan/60 bg-tarmoto-cyan/10 text-tarmoto-cyan"
          : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {icon}
      <span>{count}</span>
    </button>
  );
}

function applyVoteDelta(
  review: RoadReview,
  nextVote: boolean | null,
): Pick<RoadReview, "helpful_count" | "not_helpful_count" | "my_vote"> {
  let helpful = review.helpful_count;
  let notHelpful = review.not_helpful_count;

  if (review.my_vote === true) helpful = Math.max(0, helpful - 1);
  if (review.my_vote === false) notHelpful = Math.max(0, notHelpful - 1);

  if (nextVote === true) helpful += 1;
  if (nextVote === false) notHelpful += 1;

  return {
    helpful_count: helpful,
    not_helpful_count: notHelpful,
    my_vote: nextVote,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function sanitizePhotoUrls(
  values: string[],
): { photos: string[] } | { error: string } {
  const photos: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") {
        return { error: "Photo URLs must start with https://" };
      }
      photos.push(trimmed);
    } catch {
      return { error: "Photo URLs must start with https://" };
    }
  }

  return { photos };
}
