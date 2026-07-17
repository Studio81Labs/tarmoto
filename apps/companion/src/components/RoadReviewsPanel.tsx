"use client";
import { t } from "@/i18n";
import Link from "next/link";
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
import { toast } from "@/lib/toast";
import { useFormat } from "@/format/FormatProvider";
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

export type ReviewsTone = "dark" | "cream";

/**
 * Theme class sets so this panel can render on the dark trip-planner card
 * (`RoadPreviewCard`) and the cream explore segment sidebar from one component.
 * Defaults to `dark` so the existing planner usage is untouched.
 */
function reviewToneClasses(tone: ReviewsTone) {
  const cream = tone === "cream";
  return {
    cream,
    textPrimary: cream ? "text-ink" : "text-white",
    textBody: cream ? "text-fg-dim" : "text-slate-300",
    textMute: cream ? "text-fg-mute" : "text-slate-500",
    hover: cream ? "hover:text-ink" : "hover:text-white",
    star: cream ? "text-amber-600" : "text-amber-300",
    infoBox: cream
      ? "border border-dashed border-line-strong bg-paper text-fg-mute"
      : "border border-slate-800 bg-slate-950/40 text-slate-500",
    loadingBox: cream
      ? "border border-line bg-paper text-fg-dim"
      : "border border-slate-800 bg-slate-950/60 text-slate-400",
    outlineBtn: cream
      ? "border-line-strong text-ink hover:bg-paper"
      : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white",
    editorCard: cream
      ? "border-line bg-paper"
      : "border-slate-800 bg-slate-950/60",
    input: cream
      ? "border-line-strong bg-cream text-ink placeholder:text-fg-mute focus:border-accent"
      : "border-slate-700 bg-slate-900 text-white placeholder:text-slate-500 focus:border-accent",
    reviewCard: cream
      ? "border-line bg-cream"
      : "border-slate-800 bg-slate-950/50",
    chipInactive: cream
      ? "border-line-strong text-fg-dim hover:border-ink hover:text-ink"
      : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white",
    // Selected rating chips use the brand accent (not amber) per the spec.
    ratingActive: cream
      ? "border-accent bg-accent/15 text-ink"
      : "border-accent bg-accent/15 text-white",
    label: cream ? "text-fg-mute" : "text-slate-400",
    dashedUpload: cream
      ? "border-line-strong bg-cream hover:border-ink"
      : "border-slate-700 bg-slate-950/40 hover:border-slate-500",
    divider: cream ? "bg-line" : "bg-slate-800",
    photoTile: cream ? "border-line bg-paper" : "border-slate-800 bg-slate-900",
  };
}

/** Mono all-caps field label used inside the review editor. */
function FieldLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`block font-mono text-[10px] font-bold uppercase tracking-[1.6px] ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export function RoadReviewsPanel({
  segmentId,
  tone = "dark",
  hideHeader = false,
  onCountChange,
}: {
  segmentId: string;
  tone?: ReviewsTone;
  hideHeader?: boolean;
  /**
   * Reports the live review count whenever it changes (load, create, delete),
   * so a parent that renders the count out-of-band (e.g. the explore sidebar
   * header) stays in sync with the panel's local state.
   */
  onCountChange?: (count: number) => void;
}) {
  const format = useFormat();
  const tc = reviewToneClasses(tone);
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
  // Bumps every time the editor opens or closes, so a stale upload from
  // a canceled draft can't leak into a brand-new editor session opened
  // on the same segment+viewer. `editorModeRef === null` alone wasn't
  // enough — close + reopen leaves the mode non-null again.
  const editorSessionRef = useRef(0);
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
    // Bump session too — the segment-change reset blanks the draft, so
    // any in-flight upload tied to the previous draft session must be
    // treated as stale even if the segment ends up matching again on
    // subsequent navigation.
    editorSessionRef.current += 1;
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
  // Surface the live count once a load settles and after every mutation, so a
  // parent-rendered count tracks create/delete instead of the stale fetch value.
  // Skip on a failed load: the catch clears `reviews` to [], and reporting 0
  // would wrongly blank a header that still has the segment's real count.
  useEffect(() => {
    if (canLoadReviews && !loading && !error) onCountChange?.(reviews.length);
  }, [reviews, loading, error, canLoadReviews, onCountChange]);
  const patchReview = (reviewId: string, next: Partial<RoadReview>) => {
    setReviews((current) =>
      current.map((review) =>
        review.id === reviewId ? { ...review, ...next } : review,
      ),
    );
  };
  const openCreate = () => {
    // Each open is a fresh editor session — the upload guard uses this
    // to reject results that resolved after a previous draft was
    // canceled, even if the user reopens the editor on the same
    // segment + viewer before the request lands.
    editorSessionRef.current += 1;
    setDraft(EMPTY_REVIEW_DRAFT);
    setSubmitError(null);
    setEditorMode("create");
  };
  const openEdit = () => {
    if (!myReview) return;
    editorSessionRef.current += 1;
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
    // Bump on close too so an upload kicked off in this session is
    // already invalidated before any reopen — the editor-mode null check
    // alone races with reopens that flip the flag back to non-null
    // before the upload resolves.
    editorSessionRef.current += 1;
    setEditorMode(null);
    setSubmitError(null);
  };
  /**
   * Owns the upload roundtrip + draft mutation so the same staleness
   * checks the submit handler relies on (segment, viewer, generation)
   * plus a per-editor-open `editorSessionRef` gate uploaded URLs from
   * leaking into a draft the user no longer cares about — closed
   * editor, close + reopen on the same segment, segment switch, viewer
   * change. Errors propagate to the editor so it can render a local
   * toast; stale successes resolve silently.
   */
  const handleUploadPhotos = async (files: File[]): Promise<void> => {
    if (!editorModeRef.current) return;
    const requestSegmentId = segmentId;
    const requestViewerKey = viewerKey;
    const requestGeneration = requestGenerationRef.current;
    const requestEditorSession = editorSessionRef.current;
    const { data } = await roadsApi.uploadReviewPhotos(segmentId, files);
    if (
      requestSegmentId !== activeSegmentRef.current ||
      requestViewerKey !== activeViewerKeyRef.current ||
      requestGeneration !== requestGenerationRef.current ||
      requestEditorSession !== editorSessionRef.current ||
      editorModeRef.current === null
    ) {
      // Editor was closed (and possibly reopened — same segment, new
      // session), the segment / viewer changed, or the segment was
      // navigated away and back — the URLs the user is trying to attach
      // belong to a draft that no longer exists. Drop them rather than
      // poisoning whatever draft is open now (or sticking photos onto a
      // closed-editor draft that re-emerges on the next
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
      {!hideHeader && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p
              className={`text-[11px] uppercase tracking-wider ${tc.textMute}`}
            >
              {t("Road reviews ")}
            </p>
            {!loading && canLoadReviews && (
              <p className={`text-sm ${tc.textBody}`}>
                {t("{count, plural, one {# review} other {# reviews}}", {
                  count: reviews.length,
                })}
              </p>
            )}
          </div>
          {!loading && averageRating != null && (
            <p className={`text-sm font-medium ${tc.star}`}>
              {t("{rating} ★ average", {
                rating: format.decimal(averageRating, 1),
              })}
            </p>
          )}
        </div>
      )}

      {canLoadReviews && !loading && !editorMode && (
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          {isAuthenticated ? (
            myReview ? (
              <>
                <button
                  type="button"
                  onClick={openEdit}
                  disabled={submitting}
                  className={
                    tc.cream
                      ? `inline-flex flex-1 items-center justify-center gap-2 rounded-[10px] border px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] transition disabled:cursor-not-allowed disabled:opacity-60 ${tc.outlineBtn}`
                      : `inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-60 ${tc.outlineBtn}`
                  }
                  aria-label={t("Edit your review")}
                >
                  <Pencil size={tc.cream ? 13 : 12} />
                  {tc.cream ? t("Edit ") : t("Edit your review ")}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteReview}
                  disabled={submitting}
                  className={
                    tc.cream
                      ? "inline-flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-rose-500/40 px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-rose-600 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      : "inline-flex items-center gap-1 rounded-full border border-rose-500/30 px-3 py-1.5 text-xs text-rose-500 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  }
                  aria-label={t("Delete your review")}
                >
                  {submitting && editorMode === null ? (
                    <Loader2
                      size={tc.cream ? 13 : 12}
                      className="animate-spin"
                    />
                  ) : (
                    <Trash2 size={tc.cream ? 13 : 12} />
                  )}
                  {tc.cream ? t("Delete ") : t("Delete your review ")}
                </button>
              </>
            ) : tc.cream ? (
              <button
                type="button"
                onClick={openCreate}
                disabled={submitting}
                className={`inline-flex w-full items-center justify-center gap-2 rounded-[10px] border px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] transition disabled:cursor-not-allowed disabled:opacity-60 ${tc.outlineBtn}`}
                aria-label={t("Write a review for this road")}
              >
                <Pencil size={13} />
                {t("Write a review ")}
              </button>
            ) : (
              <button
                type="button"
                onClick={openCreate}
                disabled={submitting}
                className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent transition hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={t("Write a review for this road")}
              >
                <Pencil size={12} />
                {t("Write a review ")}
              </button>
            )
          ) : (
            <p className={`text-xs ${tc.textMute}`}>
              {t("Sign in to rate this road and share your feedback. ")}
            </p>
          )}
        </div>
      )}

      {editorMode && (
        <ReviewEditor
          mode={editorMode}
          tone={tone}
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

      {/* Hide the review list while the editor is open — the form replaces it. */}
      {!editorMode &&
        (!canLoadReviews ? (
          <div
            className={`rounded-xl px-3 py-4 text-center text-xs leading-relaxed ${tc.infoBox}`}
          >
            {t(
              "Community reviews become available when this segment maps to a saved Tarmoto road. ",
            )}
          </div>
        ) : loading ? (
          <div
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${tc.loadingBox}`}
          >
            <Loader2 size={14} className="animate-spin" />
            {t("Loading reviews\u2026 ")}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-500">
            {error}
          </div>
        ) : reviews.length === 0 ? (
          <div
            className={`rounded-xl px-4 py-4 text-center text-xs leading-relaxed ${tc.infoBox}`}
          >
            {t(
              "No reviews yet. Riders see community feedback here as soon as someone rates this road. ",
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                tone={tone}
                onChange={(next) => patchReview(review.id, next)}
              />
            ))}
          </div>
        ))}
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
  tone,
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
  tone: ReviewsTone;
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
  const tc = reviewToneClasses(tone);
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
    <section className={`mb-3 rounded-xl border p-4 ${tc.editorCard}`}>
      <p className={`text-[15px] font-bold ${tc.textPrimary}`}>
        {mode === "create" ? "Write a review" : "Edit your review"}
      </p>
      <p className={`mt-0.5 text-xs ${tc.textBody}`}>
        {t("Rate this road and add quick notes for the next rider. ")}
      </p>

      {/* Rating — cumulative star fill up to the chosen score */}
      <div className="mt-4">
        <FieldLabel className={tc.label}>{t("Your rating")}</FieldLabel>
        <div className="mt-2 grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((rating) => {
            const active = rating <= draft.rating;
            return (
              <button
                key={rating}
                type="button"
                aria-label={t("{count, plural, one {# star} other {# stars}}", {
                  count: rating,
                })}
                aria-pressed={draft.rating === rating}
                disabled={disabled}
                onClick={() => onRatingChange(rating)}
                className={`inline-flex items-center justify-center gap-1.5 rounded-[10px] border py-2 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  active ? tc.ratingActive : tc.chipInactive
                }`}
              >
                <Star
                  size={13}
                  className={active ? "fill-accent text-accent" : ""}
                />
                <span>{rating}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Comment */}
      <label className="mt-3 block">
        <FieldLabel className={tc.label}>{t("Comment")}</FieldLabel>
        {/* eslint-disable-next-line no-restricted-syntax -- road-detail pages
            are still the raw dark-slate theme (`tc.*` classes); cream-only
            fieldChrome doesn't apply until the road pages move to v2. */}
        <textarea
          value={draft.comment}
          onChange={(event) => onCommentChange(event.target.value)}
          disabled={disabled}
          maxLength={REVIEW_COMMENT_MAX_LENGTH}
          rows={4}
          aria-label={t("Comment")}
          placeholder={t("What should other riders know about this road?")}
          className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${tc.input}`}
        />
        <span className={`mt-1 block text-right text-[11px] ${tc.textMute}`}>
          {draft.comment.length}/{REVIEW_COMMENT_MAX_LENGTH}
        </span>
      </label>

      {/* Bike model */}
      <label className="mt-3 block">
        <FieldLabel className={tc.label}>{t("Bike model")}</FieldLabel>
        {/* eslint-disable-next-line no-restricted-syntax -- dark-theme road
            page, see the comment on the textarea above. */}
        <input
          type="text"
          value={draft.bikeModel}
          onChange={(event) => onBikeModelChange(event.target.value)}
          disabled={disabled}
          maxLength={100}
          aria-label={t("Bike model")}
          placeholder={t("Optional")}
          className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${tc.input}`}
        />
      </label>

      {/* Photos */}
      <div className="mt-3">
        <FieldLabel className={tc.label}>{t("Photos")}</FieldLabel>
        {/* eslint-disable-next-line no-restricted-syntax -- hidden file picker
            (review photos); the ui library has no file control. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_PHOTO_MIME_TYPES.join(",")}
          multiple
          disabled={photoInputDisabled}
          onChange={handleSelectFiles}
          aria-label={t("Select review photos")}
          className="sr-only"
        />
        {draft.photoUrls.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {draft.photoUrls.map((photo, index) => (
              <div
                key={`${photo}-${index}`}
                className={`group relative aspect-[4/3] overflow-hidden rounded-lg border ${tc.photoTile}`}
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
                  className="absolute right-1 top-1 rounded-full bg-ink/80 p-1 text-cream transition hover:bg-rose-500/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={`Remove photo ${index + 1}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={photoInputDisabled}
          aria-label={t("Upload review photos")}
          className={`mt-2 flex w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition disabled:cursor-not-allowed disabled:opacity-50 ${tc.dashedUpload}`}
        >
          {uploading ? (
            <Loader2 size={16} className="animate-spin text-accent" />
          ) : (
            <Upload size={16} className="text-accent" />
          )}
          <span className="text-[13px] font-bold text-accent">
            {t("Upload photos ")}
          </span>
          <span className={`text-[11px] ${tc.textMute}`}>
            {t("Up to {count} · JPEG, PNG, or WebP · max {sizeMb} MB each", {
              count: MAX_REVIEW_PHOTOS,
              sizeMb: Math.round(MAX_REVIEW_PHOTO_BYTES / (1024 * 1024)),
            })}
          </span>
        </button>
        {uploadError && (
          <p className="mt-1 text-xs text-rose-500" role="alert">
            {uploadError}
          </p>
        )}
      </div>

      {error && (
        <p className="mt-3 text-xs text-rose-500" role="alert">
          {error}
        </p>
      )}

      {/* Footer actions */}
      <div className={`my-4 h-px w-full ${tc.divider}`} />
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className={`rounded-[10px] border px-5 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] transition disabled:cursor-not-allowed disabled:opacity-60 ${tc.outlineBtn}`}
        >
          {t("Cancel ")}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || uploading}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? <Loader2 size={13} className="animate-spin" /> : null}
          {mode === "create" ? "Submit review" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
function validateSelectedPhotos(
  files: File[],
  remainingSlots: number,
):
  | {
      files: File[];
    }
  | {
      error: string;
    } {
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
        error: `Each photo must be smaller than ${Math.round(MAX_REVIEW_PHOTO_BYTES / (1024 * 1024))} MB.`,
      };
    }
  }
  return { files };
}
function ReviewCard({
  review,
  tone,
  onChange,
}: {
  review: RoadReview;
  tone: ReviewsTone;
  onChange: (next: Partial<RoadReview>) => void;
}) {
  const format = useFormat();
  const tc = reviewToneClasses(tone);
  const [pendingVote, setPendingVote] = useState<"up" | "down" | null>(null);
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
    onChange(applyVoteDelta(review, wasSame ? null : isHelpful));
    try {
      const { data } = wasSame
        ? await roadsApi.clearReviewVote(review.id)
        : await roadsApi.voteOnReview(review.id, isHelpful);
      onChange(data);
    } catch (err) {
      onChange(previous);
      toast.error(
        err instanceof Error ? err.message : t("Could not submit vote."),
      );
    } finally {
      setPendingVote(null);
    }
  };
  return (
    <article className={`rounded-xl border p-3 ${tc.reviewCard}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {review.user_id && !review.is_mine ? (
            <Link
              href={`/community/${encodeURIComponent(review.user_id)}`}
              className={`text-sm font-medium transition hover:text-accent ${tc.textPrimary}`}
            >
              {review.user_display_name}
            </Link>
          ) : (
            <p className={`text-sm font-medium ${tc.textPrimary}`}>
              {review.user_display_name}
            </p>
          )}
          <p className={`text-xs ${tc.textMute}`}>
            {format.relativeTime(review.created_at)}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5"
          aria-label={`${Math.round(review.rating)} out of 5`}
        >
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= Math.round(review.rating);
            return (
              <Star
                key={n}
                size={14}
                aria-hidden="true"
                className={
                  filled ? "fill-accent text-accent" : "text-accent/30"
                }
              />
            );
          })}
        </div>
      </div>

      {review.comment && (
        <p className={`mt-2 text-sm ${tc.textBody}`}>{review.comment}</p>
      )}

      <div
        className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${tc.textMute}`}
      >
        {review.bike_model && <span>{review.bike_model}</span>}
        {photos.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Images size={12} />
            {t("{count, plural, one {# photo} other {# photos}}", {
              count: photos.length,
            })}
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
        <div
          className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${tc.textMute}`}
        >
          <span>{t("This is your review.")}</span>
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
            inactiveClass={tc.chipInactive}
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
            inactiveClass={tc.chipInactive}
            icon={<ThumbsDown size={12} />}
            onClick={() => submitVote(false)}
          />
        </div>
      )}
    </article>
  );
}
function VoteButton({
  label,
  count,
  active,
  pending,
  inactiveClass,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  pending: boolean;
  inactiveClass: string;
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
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? "border-accent/60 bg-accent/10 text-accent" : inactiveClass
      }`}
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
function normalizeDraft(draft: ReviewDraft):
  | {
      ok: true;
      data: UpsertRoadReviewInput;
    }
  | {
      ok: false;
      error: string;
    } {
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
