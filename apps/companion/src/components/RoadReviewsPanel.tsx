"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Images, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { roadsApi, type RoadReview } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";

export function RoadReviewsPanel({ segmentId }: { segmentId: string }) {
  const canLoadReviews = isUuid(segmentId);
  const [reviews, setReviews] = useState<RoadReview[]>([]);
  const [loading, setLoading] = useState(canLoadReviews);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
        setReviews(data);
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
