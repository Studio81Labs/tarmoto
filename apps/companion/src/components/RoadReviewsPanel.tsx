"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Images,
  Loader2,
  Pencil,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { roadsApi, type RoadReview } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { formatRelativeTime } from "@/lib/utils";

interface ReviewDraft {
  rating: number;
  comment: string;
  bikeModel: string;
  photos: string[];
}

const EMPTY_DRAFT: ReviewDraft = {
  rating: 0,
  comment: "",
  bikeModel: "",
  photos: [],
};

export function RoadReviewsPanel({ segmentId }: { segmentId: string }) {
  const canLoadReviews = isUuid(segmentId);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  const viewerKey = isAuthenticated
    ? (viewerId ?? "authenticated")
    : "anonymous";
  const [reviews, setReviews] = useState<RoadReview[]>([]);
  const [loading, setLoading] = useState(canLoadReviews);
  const [error, setError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const loadRequestRef = useRef(0);
  const myReview = useMemo(
    () => reviews.find((review) => review.is_mine) ?? null,
    [reviews],
  );

  const resetEditorState = useCallback(() => {
    setEditorMode(null);
    setDraft(EMPTY_DRAFT);
    setSubmitError(null);
    setSubmitting(false);
  }, []);

  const loadReviews = useCallback(async () => {
    const requestId = ++loadRequestRef.current;

    if (!canLoadReviews) {
      if (requestId !== loadRequestRef.current) return;
      setReviews([]);
      setError(null);
      setLoading(false);
      return;
    }

    setReviews([]);
    setLoading(true);
    setError(null);

    try {
      const { data } = await roadsApi.getReviews(segmentId);
      if (requestId !== loadRequestRef.current) return;
      setReviews(data);
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      setReviews([]);
      setError(err instanceof Error ? err.message : "Could not load reviews.");
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }, [canLoadReviews, segmentId]);

  useEffect(() => {
    resetEditorState();
    void loadReviews();

    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadReviews, resetEditorState, segmentId, viewerKey]);

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

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setSubmitError(null);
    setEditorMode("create");
  };

  const openEdit = () => {
    if (!myReview) return;
    setDraft({
      rating: myReview.rating,
      comment: myReview.comment ?? "",
      bikeModel: myReview.bike_model ?? "",
      photos: Array.isArray(myReview.photos) ? [...myReview.photos] : [],
    });
    setSubmitError(null);
    setEditorMode("edit");
  };

  const closeEditor = () => {
    if (submitting) return;
    setEditorMode(null);
    setSubmitError(null);
  };

  const handleSubmit = async () => {
    if (!canLoadReviews || submitting) return;

    const normalized = normalizeDraft(draft);
    if (!normalized.ok) {
      setSubmitError(normalized.error);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      if (editorMode === "edit") {
        await roadsApi.updateReview(segmentId, {
          ...normalized.data,
          photos: [...draft.photos],
        });
      } else {
        await roadsApi.createReview(segmentId, normalized.data);
      }
      setEditorMode(null);
      await loadReviews();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not save your review.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!canLoadReviews || submitting || !myReview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await roadsApi.deleteReview(segmentId);
      setEditorMode(null);
      await loadReviews();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not delete your review.",
      );
    } finally {
      setSubmitting(false);
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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {isAuthenticated ? (
            myReview ? (
              <>
                <button
                  type="button"
                  onClick={openEdit}
                  disabled={submitting}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Edit your review"
                >
                  <Pencil size={12} />
                  Edit your review
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={submitting}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Delete your review"
                >
                  {submitting && editorMode === null ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Delete your review
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={openCreate}
                disabled={submitting}
                className="inline-flex items-center gap-1 rounded-full border border-tarmoto-cyan/40 bg-tarmoto-cyan/10 px-3 py-1.5 text-xs text-tarmoto-cyan transition hover:bg-tarmoto-cyan/15 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="Write a review for this road"
              >
                <Pencil size={12} />
                Write a review
              </button>
            )
          ) : (
            <p className="text-xs text-slate-500">
              Sign in to rate this road and share your feedback.
            </p>
          )}
        </div>
      )}

      {editorMode && (
        <ReviewEditor
          mode={editorMode}
          draft={draft}
          disabled={submitting}
          error={submitError}
          onChange={setDraft}
          onCancel={closeEditor}
          onSubmit={handleSubmit}
        />
      )}

      {!editorMode && submitError && (
        <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
          {submitError}
        </div>
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

      {review.is_mine ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>This is your review.</span>
        </div>
      ) : (
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
      )}

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

function ReviewEditor({
  mode,
  draft,
  disabled,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  draft: ReviewDraft;
  disabled: boolean;
  error: string | null;
  onChange: (next: ReviewDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">
            {mode === "create" ? "Write a review" : "Edit your review"}
          </p>
          <p className="text-xs text-slate-500">
            Rate this road from your own ride experience. Photo upload will land
            once media storage is wired.
          </p>
        </div>
      </div>

      <div className="mb-3">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
          Rating
        </p>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }, (_, index) => index + 1).map((rating) => {
            const active = draft.rating === rating;
            return (
              <button
                key={rating}
                type="button"
                onClick={() => onChange({ ...draft, rating })}
                disabled={disabled}
                aria-label={`${rating} ${rating === 1 ? "star" : "stars"}`}
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  active
                    ? "border-amber-400/60 bg-amber-400/10 text-amber-300"
                    : "border-slate-700 text-slate-300 hover:border-slate-500"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {rating} ★
              </button>
            );
          })}
        </div>
      </div>

      <label className="mb-3 block">
        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">
          Comment
        </span>
        <textarea
          value={draft.comment}
          onChange={(event) =>
            onChange({ ...draft, comment: event.target.value.slice(0, 500) })
          }
          disabled={disabled}
          rows={4}
          aria-label="Comment"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="What should other riders know about this road?"
        />
        <span className="mt-1 block text-right text-[11px] text-slate-500">
          {draft.comment.length}/500
        </span>
      </label>

      <label className="mb-3 block">
        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">
          Bike model
        </span>
        <input
          type="text"
          value={draft.bikeModel}
          onChange={(event) =>
            onChange({ ...draft, bikeModel: event.target.value.slice(0, 100) })
          }
          disabled={disabled}
          aria-label="Bike model"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="Optional — e.g. BMW R1250GS"
        />
      </label>

      {error && (
        <p className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="rounded-lg px-3 py-2 text-xs text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg bg-tarmoto-cyan px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-tarmoto-cyan-light disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? <Loader2 size={12} className="animate-spin" /> : null}
          {mode === "create" ? "Submit review" : "Save review"}
        </button>
      </div>
    </div>
  );
}

function normalizeDraft(draft: ReviewDraft):
  | {
      ok: true;
      data: { rating: number; comment?: string; bike_model?: string };
    }
  | { ok: false; error: string } {
  if (draft.rating < 1 || draft.rating > 5) {
    return { ok: false, error: "Choose a star rating before you submit." };
  }

  const comment = draft.comment.trim();
  const bikeModel = draft.bikeModel.trim();

  return {
    ok: true,
    data: {
      rating: draft.rating,
      ...(comment ? { comment } : {}),
      ...(bikeModel ? { bike_model: bikeModel } : {}),
    },
  };
}
