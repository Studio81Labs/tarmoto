"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  Images,
  Loader2,
  Pencil,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ApiError,
  roadsApi,
  type RoadReview,
  type UpsertRoadReviewInput,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

const MAX_REVIEW_PHOTOS = 5;
const MAX_REVIEW_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const REVIEW_COMMENT_MAX_LENGTH = 1000;

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
  photoUrls: [],
};

export function RoadReviewsPanel({ segmentId }: { segmentId: string }) {
  const canLoadReviews = isUuid(segmentId);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const viewerId = useAuthStore((state) => state.user?.id ?? null);
  const viewerKey = isAuthenticated
    ? (viewerId ?? "authenticated")
    : "anonymous";
  const [reviews, setReviews] = useState<RoadReview[]>([]);
  const [loading, setLoading] = useState(canLoadReviews);
  const [error, setError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_REVIEW_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const activeSegmentRef = useRef(segmentId);
  const activeViewerKeyRef = useRef(viewerKey);
  const editorModeRef = useRef<"create" | "edit" | null>(null);
  const requestGenerationRef = useRef(0);
  const mutationAttemptRef = useRef(0);
  const localMyReviewRef = useRef<RoadReview | null>(null);
  const deletedMyReviewIdRef = useRef<string | null>(null);

  // Mirror editorMode into a ref so async callbacks (uploadReviewPhotos)
  // can compare the value at resolve time without restarting on every
  // editor-state transition.
  useEffect(() => {
    editorModeRef.current = editorMode;
  }, [editorMode]);

  useEffect(() => {
    activeSegmentRef.current = segmentId;
    activeViewerKeyRef.current = viewerKey;
    requestGenerationRef.current += 1;
    localMyReviewRef.current = null;
    deletedMyReviewIdRef.current = null;
    setDraft(EMPTY_REVIEW_DRAFT);
    setEditorMode(null);
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
        setReviews((current) =>
          mergeFetchedReviews(
            data,
            current,
            localMyReviewRef.current,
            deletedMyReviewIdRef.current,
          ),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setReviews([]);
        setError(
          err instanceof Error ? err.message : "Could not load reviews.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canLoadReviews, segmentId, viewerKey]);

  const averageRating = useMemo(() => {
    if (reviews.length === 0) return null;
    const total = reviews.reduce((sum, review) => sum + review.rating, 0);
    return total / reviews.length;
  }, [reviews]);

  const myReview = useMemo(
    () => reviews.find((review) => review.is_mine) ?? null,
    [reviews],
  );

  const patchReview = (reviewId: string, next: Partial<RoadReview>) => {
    setReviews((current) =>
      current.map((review) =>
        review.id === reviewId ? { ...review, ...next } : review,
      ),
    );
  };

  const openCreate = () => {
    setDraft(EMPTY_REVIEW_DRAFT);
    setSubmitError(null);
    setEditorMode("create");
  };

  const openEdit = () => {
    if (!myReview) return;
    setDraft({
      rating: myReview.rating,
      comment: myReview.comment ?? "",
      bikeModel: myReview.bike_model ?? "",
      photoUrls: Array.isArray(myReview.photos) ? [...myReview.photos] : [],
    });
    setSubmitError(null);
    setEditorMode("edit");
  };

  const closeEditor = () => {
    if (submitting) return;
    setEditorMode(null);
    setSubmitError(null);
  };

  /**
   * Owns the upload roundtrip + draft mutation so the same staleness
   * checks the submit handler relies on (segment, viewer, generation,
   * editor session) also gate uploaded URLs from leaking into a draft
   * the user no longer cares about — closed editor, segment switch,
   * viewer change. Errors propagate to the editor so it can render a
   * local toast; stale successes resolve silently.
   */
  const handleUploadPhotos = async (files: File[]): Promise<void> => {
    if (!editorModeRef.current) return;

    const requestSegmentId = segmentId;
    const requestViewerKey = viewerKey;
    const requestGeneration = requestGenerationRef.current;

    const { data } = await roadsApi.uploadReviewPhotos(segmentId, files);

    if (
      requestSegmentId !== activeSegmentRef.current ||
      requestViewerKey !== activeViewerKeyRef.current ||
      requestGeneration !== requestGenerationRef.current ||
      editorModeRef.current === null
    ) {
      // Editor was closed, the segment / viewer changed, or the segment
      // was navigated away and back — the URLs the user is trying to
      // attach belong to a draft that no longer exists. Drop them rather
      // than poisoning whatever draft is open now (or sticking photos
      // onto a closed-editor draft that re-emerges on the next
      // openCreate/openEdit). The files themselves stay on disk and get
      // swept by the orphan cleanup tracked separately.
      return;
    }

    setDraft((current) => ({
      ...current,
      photoUrls: [...current.photoUrls, ...data.photos].slice(
        0,
        MAX_REVIEW_PHOTOS,
      ),
    }));
    setSubmitError(null);
  };

  const handleSubmitReview = async () => {
    if (
      !canLoadReviews ||
      !isAuthenticated ||
      loading ||
      submitting ||
      !editorMode
    ) {
      return;
    }

    const normalized = normalizeDraft(draft);
    if (!normalized.ok) {
      setSubmitError(normalized.error);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    const requestGeneration = requestGenerationRef.current;
    const requestSegmentId = segmentId;
    const requestViewerKey = viewerKey;
    mutationAttemptRef.current += 1;
    const mutationAttempt = mutationAttemptRef.current;

    try {
      const payload =
        editorMode === "edit"
          ? { ...normalized.data, photos: normalized.data.photos ?? [] }
          : normalized.data;
      const { data } =
        editorMode === "edit"
          ? await roadsApi.updateReview(segmentId, payload)
          : await roadsApi.createReview(segmentId, payload);

      if (
        requestSegmentId !== activeSegmentRef.current ||
        requestViewerKey !== activeViewerKeyRef.current ||
        mutationAttempt !== mutationAttemptRef.current
      ) {
        return;
      }

      const didReturnToSameSegment =
        requestGeneration !== requestGenerationRef.current;

      setError(null);
      setSubmitError(null);
      localMyReviewRef.current = data.is_mine ? data : null;
      deletedMyReviewIdRef.current = null;
      setReviews((current) => upsertReview(current, data));

      if (!didReturnToSameSegment) {
        setDraft(EMPTY_REVIEW_DRAFT);
        setEditorMode(null);
      } else if (data.is_mine) {
        setEditorMode((current) => (current === "create" ? "edit" : current));
      }
    } catch (err) {
      if (
        requestSegmentId !== activeSegmentRef.current ||
        requestViewerKey !== activeViewerKeyRef.current ||
        mutationAttempt !== mutationAttemptRef.current
      ) {
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : "Could not save your review.",
      );
    } finally {
      if (
        requestSegmentId === activeSegmentRef.current &&
        requestViewerKey === activeViewerKeyRef.current &&
        mutationAttempt === mutationAttemptRef.current
      ) {
        setSubmitting(false);
      }
    }
  };

  const handleDeleteReview = async () => {
    if (
      !canLoadReviews ||
      !isAuthenticated ||
      loading ||
      submitting ||
      !myReview
    ) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    const requestSegmentId = segmentId;
    const requestViewerKey = viewerKey;
    const reviewId = myReview.id;
    mutationAttemptRef.current += 1;
    const mutationAttempt = mutationAttemptRef.current;

    try {
      await roadsApi.deleteReview(segmentId);

      if (
        requestSegmentId !== activeSegmentRef.current ||
        requestViewerKey !== activeViewerKeyRef.current ||
        mutationAttempt !== mutationAttemptRef.current
      ) {
        return;
      }

      setError(null);
      setSubmitError(null);
      localMyReviewRef.current = null;
      deletedMyReviewIdRef.current = reviewId;
      setReviews((current) =>
        current.filter((review) => review.id !== reviewId),
      );
      setDraft(EMPTY_REVIEW_DRAFT);
      setEditorMode(null);
    } catch (err) {
      if (
        requestSegmentId !== activeSegmentRef.current ||
        requestViewerKey !== activeViewerKeyRef.current ||
        mutationAttempt !== mutationAttemptRef.current
      ) {
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : "Could not delete your review.",
      );
    } finally {
      if (
        requestSegmentId === activeSegmentRef.current &&
        requestViewerKey === activeViewerKeyRef.current &&
        mutationAttempt === mutationAttemptRef.current
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

      {canLoadReviews && !loading && (
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
                  onClick={handleDeleteReview}
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
          remainingPhotoSlots={Math.max(
            0,
            MAX_REVIEW_PHOTOS - draft.photoUrls.length,
          )}
          draft={draft}
          disabled={loading || submitting}
          error={submitError}
          onRatingChange={(rating) => {
            setDraft((current) => ({ ...current, rating }));
            setSubmitError(null);
          }}
          onCommentChange={(comment) => {
            setDraft((current) => ({
              ...current,
              comment: comment.slice(0, REVIEW_COMMENT_MAX_LENGTH),
            }));
            setSubmitError(null);
          }}
          onBikeModelChange={(bikeModel) => {
            setDraft((current) => ({
              ...current,
              bikeModel: bikeModel.slice(0, 100),
            }));
            setSubmitError(null);
          }}
          onUploadPhotos={handleUploadPhotos}
          onRemovePhoto={(index) => {
            setDraft((current) => ({
              ...current,
              photoUrls: current.photoUrls.filter((_, idx) => idx !== index),
            }));
            setSubmitError(null);
          }}
          onCancel={closeEditor}
          onSubmit={handleSubmitReview}
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

function mergeFetchedReviews(
  fetched: RoadReview[],
  current: RoadReview[],
  localMyReview: RoadReview | null,
  deletedMyReviewId: string | null,
): RoadReview[] {
  const nextFetched = deletedMyReviewId
    ? fetched.filter((review) => review.id !== deletedMyReviewId)
    : fetched;

  if (current.length === 0 && !localMyReview) {
    return nextFetched;
  }

  const fetchedIds = new Set(nextFetched.map((review) => review.id));
  const localOnlyReviews = current.filter(
    (review) => review.id !== deletedMyReviewId && !fetchedIds.has(review.id),
  );

  const merged = [...localOnlyReviews, ...nextFetched];
  return localMyReview ? upsertReview(merged, localMyReview) : merged;
}

function upsertReview(current: RoadReview[], next: RoadReview): RoadReview[] {
  const remaining = current.filter(
    (review) => review.id !== next.id && !(next.is_mine && review.is_mine),
  );
  return [next, ...remaining];
}

function ReviewEditor({
  mode,
  remainingPhotoSlots,
  draft,
  disabled,
  error,
  onRatingChange,
  onCommentChange,
  onBikeModelChange,
  onUploadPhotos,
  onRemovePhoto,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  remainingPhotoSlots: number;
  draft: ReviewDraft;
  disabled: boolean;
  error: string | null;
  onRatingChange: (rating: number) => void;
  onCommentChange: (comment: string) => void;
  onBikeModelChange: (bikeModel: string) => void;
  onUploadPhotos: (files: File[]) => Promise<void>;
  onRemovePhoto: (index: number) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const photoInputDisabled = disabled || uploading || remainingPhotoSlots === 0;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSelectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const selected = Array.from(input.files ?? []);
    // Reset the input value before any await so the next selection (even
    // of the exact same filename) still fires `change` and lets the user
    // retry after a validation failure.
    input.value = "";
    if (selected.length === 0) return;

    const validation = validateSelectedPhotos(selected, remainingPhotoSlots);
    if ("error" in validation) {
      setUploadError(validation.error);
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      // Parent owns the upload roundtrip and decides whether to apply
      // the returned URLs to the draft (see `handleUploadPhotos`). Stale
      // successes resolve here as a normal void return — the spinner
      // just clears.
      await onUploadPhotos(validation.files);
    } catch (err) {
      if (!mountedRef.current) return;
      setUploadError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not upload photos.",
      );
    } finally {
      // Editor may have unmounted while the upload was in flight (e.g.
      // user closed it or switched segments) — skip the state update so
      // React doesn't warn about setState on an unmounted component.
      if (mountedRef.current) {
        setUploading(false);
      }
    }
  };

  return (
    <section className="mb-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">
            {mode === "create" ? "Write a review" : "Edit your review"}
          </p>
          <p className="text-xs text-slate-500">
            Rate this road and add quick notes for the next rider.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-tarmoto-cyan px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-tarmoto-cyan-light disabled:cursor-not-allowed disabled:opacity-60"
          >
            {disabled ? <Loader2 size={12} className="animate-spin" /> : null}
            {mode === "create" ? "Submit review" : "Save review"}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5].map((rating) => {
          const active = draft.rating === rating;
          return (
            <button
              key={rating}
              type="button"
              aria-label={`${rating} ${rating === 1 ? "star" : "stars"}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onRatingChange(rating)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
                active
                  ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <Star size={12} className={active ? "fill-current" : ""} />
              <span>{rating}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Comment
          </span>
          <textarea
            value={draft.comment}
            onChange={(event) => onCommentChange(event.target.value)}
            disabled={disabled}
            maxLength={REVIEW_COMMENT_MAX_LENGTH}
            rows={4}
            aria-label="Comment"
            placeholder="What should other riders know about this road?"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-tarmoto-cyan focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="mt-1 block text-right text-[11px] text-slate-500">
            {draft.comment.length}/{REVIEW_COMMENT_MAX_LENGTH}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Bike model
          </span>
          <input
            type="text"
            value={draft.bikeModel}
            onChange={(event) => onBikeModelChange(event.target.value)}
            disabled={disabled}
            maxLength={100}
            aria-label="Bike model"
            placeholder="Optional"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-tarmoto-cyan focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <div>
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-slate-400">Photos</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={photoInputDisabled}
              className="inline-flex items-center gap-1 text-xs text-slate-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Upload review photos"
            >
              {uploading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              Upload photos
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_PHOTO_MIME_TYPES.join(",")}
            multiple
            disabled={photoInputDisabled}
            onChange={handleSelectFiles}
            aria-label="Select review photos"
            className="sr-only"
          />
          {draft.photoUrls.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {draft.photoUrls.map((photo, index) => (
                <div
                  key={`${photo}-${index}`}
                  className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-800 bg-slate-900"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo}
                    alt={`Review photo ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => onRemovePhoto(index)}
                    disabled={disabled || uploading}
                    className="absolute right-1 top-1 rounded-full bg-slate-950/80 p-1 text-slate-300 transition hover:bg-rose-500/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Remove photo ${index + 1}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            Up to {MAX_REVIEW_PHOTOS} JPEG, PNG, or WebP photos (max{" "}
            {Math.round(MAX_REVIEW_PHOTO_BYTES / (1024 * 1024))} MB each).
          </p>
          {uploadError && (
            <p className="mt-1 text-xs text-rose-300" role="alert">
              {uploadError}
            </p>
          )}
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

function validateSelectedPhotos(
  files: File[],
  remainingSlots: number,
): { files: File[] } | { error: string } {
  if (files.length > remainingSlots) {
    return {
      error: `You can attach up to ${MAX_REVIEW_PHOTOS} photos in total.`,
    };
  }
  for (const file of files) {
    if (!(ACCEPTED_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
      return {
        error: "Photos must be JPEG, PNG, or WebP images.",
      };
    }
    if (file.size > MAX_REVIEW_PHOTO_BYTES) {
      return {
        error: `Each photo must be smaller than ${Math.round(
          MAX_REVIEW_PHOTO_BYTES / (1024 * 1024),
        )} MB.`,
      };
    }
  }
  return { files };
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
    if (pendingVote || review.is_mine) return;

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

function normalizeDraft(
  draft: ReviewDraft,
): { ok: true; data: UpsertRoadReviewInput } | { ok: false; error: string } {
  if (draft.rating < 1 || draft.rating > 5) {
    return { ok: false, error: "Choose a star rating before you submit." };
  }

  if (draft.photoUrls.length > MAX_REVIEW_PHOTOS) {
    return {
      ok: false,
      error: `You can attach up to ${MAX_REVIEW_PHOTOS} photos.`,
    };
  }

  const comment = draft.comment.trim();
  const bikeModel = draft.bikeModel.trim();

  return {
    ok: true,
    data: {
      rating: draft.rating,
      ...(comment ? { comment } : {}),
      ...(bikeModel ? { bike_model: bikeModel } : {}),
      ...(draft.photoUrls.length > 0 ? { photos: draft.photoUrls } : {}),
    },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
