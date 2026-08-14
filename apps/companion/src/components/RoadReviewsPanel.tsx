"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage, type Translate } from "@/i18n";
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
  roadsApi,
  type RoadReview,
  type UpsertRoadReviewInput,
} from "@/lib/api";
import { Button } from "@tarmoto/ui";
import { toast } from "@/lib/toast";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch, useSystemSwitch } from "@/hooks/useEntitlements";
import { useAuthStore } from "@/stores/auth";
import { formatRelativeTimeLabel } from "@tarmoto/shared";
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

/**
 * Cream theme class set for the review panel — rendered on the trip-planner
 * card and the explore segment sidebar (both cream since the dark theme was
 * retired).
 */
const TC = {
  textPrimary: "text-ink",
  textBody: "text-fg-dim",
  textMute: "text-fg-mute",
  hover: "hover:text-ink",
  star: "text-amber-600",
  infoBox: "border border-dashed border-line-strong bg-paper text-fg-mute",
  loadingBox: "border border-line bg-paper text-fg-dim",
  outlineBtn: "border-line-strong text-ink hover:bg-paper",
  editorCard: "border-line bg-paper",
  input:
    "border-line-strong bg-cream text-ink placeholder:text-fg-mute focus:border-accent",
  reviewCard: "border-line bg-cream",
  chipInactive:
    "border-line-strong text-fg-dim hover:border-ink hover:text-ink",
  // Selected rating chips use the brand accent (not amber) per the spec.
  ratingActive: "border-accent bg-accent/15 text-ink",
  label: "text-fg-mute",
  dashedUpload: "border-line-strong bg-cream hover:border-ink",
  divider: "bg-line",
  photoTile: "border-line bg-paper",
} as const;

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
  hideHeader = false,
  onCountChange,
}: {
  segmentId: string;
  hideHeader?: boolean;
  /**
   * Reports the live review count whenever it changes (load, create, delete),
   * so a parent that renders the count out-of-band (e.g. the explore sidebar
   * header) stays in sync with the panel's local state.
   */
  onCountChange?: (count: number) => void;
}) {
  const t = useTranslation();
  const format = useFormat();
  const tc = TC;
  const canLoadReviews = isUuid(segmentId);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const viewerId = useAuthStore((state) => state.user?.id ?? null);
  const viewerKey = isAuthenticated
    ? (viewerId ?? "authenticated")
    : "anonymous";
  const [reviews, setReviews] = useState<RoadReview[]>([]);
  // Declared before the fetch effect below, which depends on it: while
  // `sys_poi_ratings` is off the backend returns ONLY the viewer's own review
  // (so it stays deletable — see `ReviewsService.listForSegment`), which makes
  // `reviews` a personal list rather than a community one. Every aggregate
  // derived from it has to stop deriving from it.
  const { enabled: ratingsEnabled } = useSystemSwitch("sys_poi_ratings");
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
        setError(getUserFacingErrorMessage(err, t("Could not load reviews.")));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // `ratingsEnabled` is a dependency: on an operator flip the server's answer
    // to this very request changes (community list -> own review only), so the
    // list has to be re-derived rather than left as the pre-flip snapshot.
  }, [t, canLoadReviews, segmentId, viewerKey, ratingsEnabled]);
  const averageRating = useMemo(() => {
    // One own review would otherwise render as the road's average rating.
    if (!ratingsEnabled) return null;
    if (reviews.length === 0) return null;
    const total = reviews.reduce((sum, review) => sum + review.rating, 0);
    return total / reviews.length;
  }, [reviews, ratingsEnabled]);
  const myReview = useMemo(
    () => reviews.find((review) => review.is_mine) ?? null,
    [reviews],
  );
  // Belt AND braces with the refetch above. A re-render from the flag query
  // arrives BEFORE the refetch it triggers resolves, and the refetch can fail
  // outright — either way the pre-flip community rows would keep rendering
  // underneath the "temporarily unavailable" notice, which is a worse state
  // than not gating at all. This projection is synchronous and cannot race.
  const visibleReviews = useMemo(
    () => (ratingsEnabled ? reviews : reviews.filter((r) => r.is_mine)),
    [reviews, ratingsEnabled],
  );
  // Surface the live count once a load settles and after every mutation, so a
  // parent-rendered count tracks create/delete instead of the stale fetch value.
  // Skip on a failed load: the catch clears `reviews` to [], and reporting 0
  // would wrongly blank a header that still has the segment's real count.
  //
  // Skip entirely while the switch is off: `SegmentDetailSidebar` binds this
  // straight to the road's review count, so a one-element own-review array
  // would publish "1 review" as the COMMUNITY total, overwriting the neutral
  // zero the backend deliberately serves.
  useEffect(() => {
    if (canLoadReviews && !loading && !error && ratingsEnabled)
      onCountChange?.(reviews.length);
  }, [reviews, loading, error, canLoadReviews, onCountChange, ratingsEnabled]);
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
    const normalized = normalizeDraft(draft, t);
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
        getUserFacingErrorMessage(err, t("Could not save your review.")),
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
        getUserFacingErrorMessage(err, t("Could not delete your review.")),
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
              {t("Road reviews")}
            </p>
            {/* Same reason as `onCountChange` above: while the switch is off
                this list is the viewer's own review, not the road's. */}
            {!loading && canLoadReviews && ratingsEnabled && (
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
                {/* Editing is 503'd by `@RequireSystemSwitch` while the switch
                    is off, so the affordance goes with it — a rider must not
                    fill in a form, upload photos and only then be refused.
                    DELETE stays: the backend deliberately leaves it open, and
                    this is the sole place either client exposes it from. */}
                {ratingsEnabled && (
                  <Button
                    variant="secondary"
                    uppercase
                    className="flex-1"
                    onClick={openEdit}
                    disabled={submitting}
                    leftIcon={<Pencil size={13} />}
                    aria-label={t("Edit your review")}
                  >
                    {t("Edit")}
                  </Button>
                )}
                <Button
                  variant="danger"
                  uppercase
                  className="flex-1"
                  onClick={handleDeleteReview}
                  disabled={submitting}
                  loading={submitting && editorMode === null}
                  leftIcon={<Trash2 size={13} />}
                  aria-label={t("Delete your review")}
                >
                  {t("Delete")}
                </Button>
              </>
            ) : (
              // Composing is 503'd at `roadsApi.createReview` while the switch
              // is off. Without this gate the rider writes the review, uploads
              // photos, submits, and meets the failure with the form still
              // full — the exact shape this epic exists to prevent.
              ratingsEnabled && (
                <Button
                  variant="secondary"
                  uppercase
                  block
                  onClick={openCreate}
                  disabled={submitting}
                  leftIcon={<Pencil size={13} />}
                  aria-label={t("Write a review for this road")}
                >
                  {t("Write a review")}
                </Button>
              )
            )
          ) : (
            <p className={`text-xs ${tc.textMute}`}>
              {t("Sign in to rate this road and share your feedback.")}
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
        <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-700">
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
              "Community reviews become available when this segment maps to a saved Tarmoto road.",
            )}
          </div>
        ) : loading ? (
          <div
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${tc.loadingBox}`}
          >
            <Loader2 size={14} className="animate-spin" />
            {t("Loading reviews…")}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-500">
            {error}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Classified from the SWITCH, never inferred from an empty list.
                While it is off the backend hides the community's reviews, so a
                road that genuinely has them would otherwise render "no reviews
                yet" — a silent empty state indistinguishable from real
                absence. The rider's own review still appears below it. */}
            {!ratingsEnabled && (
              <div
                className={`rounded-xl px-4 py-4 text-center text-xs leading-relaxed ${tc.infoBox}`}
              >
                {myReview
                  ? t(
                      "Community reviews are temporarily unavailable. Your own review is still shown below and can be deleted.",
                    )
                  : t(
                      "Community reviews are temporarily unavailable. Please try again later.",
                    )}
              </div>
            )}
            {ratingsEnabled && visibleReviews.length === 0 && (
              <div
                className={`rounded-xl px-4 py-4 text-center text-xs leading-relaxed ${tc.infoBox}`}
              >
                {t(
                  "No reviews yet. Riders see community feedback here as soon as someone rates this road.",
                )}
              </div>
            )}
            {visibleReviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
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
  const t = useTranslation();
  const format = useFormat();
  const tc = TC;
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
    const validation = validateSelectedPhotos(selected, remainingPhotoSlots, t);
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
        getUserFacingErrorMessage(err, t("Could not upload photos.")),
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
        {mode === "create" ? t("Write a review") : t("Edit your review")}
      </p>
      <p className={`mt-0.5 text-xs ${tc.textBody}`}>
        {t("Rate this road and add quick notes for the next rider.")}
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
                <span>{format.integer(rating)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Comment */}
      <label className="mt-3 block">
        <FieldLabel className={tc.label}>{t("Comment")}</FieldLabel>
        {/* eslint-disable-next-line no-restricted-syntax -- the review editor
            uses its own compact field chrome (`tc.input`) tuned to this
            panel's dense layout; migrating to the ui Textarea is a separate
            follow-up. */}
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
          {t("{current, number}/{max, number}", {
            current: draft.comment.length,
            max: REVIEW_COMMENT_MAX_LENGTH,
          })}
        </span>
      </label>

      {/* Bike model */}
      <label className="mt-3 block">
        <FieldLabel className={tc.label}>{t("Bike model")}</FieldLabel>
        {/* eslint-disable-next-line no-restricted-syntax -- review-editor
            field chrome, see the comment on the textarea above. */}
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
                  alt={t("Review photo {n}", { n: index + 1 })}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemovePhoto(index)}
                  disabled={disabled || uploading}
                  className="absolute right-1 top-1 rounded-full bg-ink/80 p-1 text-cream transition hover:bg-rose-500/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t("Remove photo {n}", { n: index + 1 })}
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
            {t("Upload photos")}
          </span>
          <span className={`text-[11px] ${tc.textMute}`}>
            {t(
              "Up to {count, plural, one {# photo} other {# photos}} · JPEG, PNG, or WebP · max {sizeMb} MB each",
              {
                count: MAX_REVIEW_PHOTOS,
                sizeMb: Math.round(MAX_REVIEW_PHOTO_BYTES / (1024 * 1024)),
              },
            )}
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
        <Button
          variant="secondary"
          uppercase
          onClick={onCancel}
          disabled={disabled}
        >
          {t("Cancel")}
        </Button>
        <Button
          variant="accent"
          uppercase
          className="flex-1"
          onClick={onSubmit}
          disabled={uploading}
          loading={disabled}
        >
          {mode === "create" ? t("Submit review") : t("Save changes")}
        </Button>
      </div>
    </section>
  );
}
function validateSelectedPhotos(
  files: File[],
  remainingSlots: number,
  t: Translate,
):
  | {
      files: File[];
    }
  | {
      error: string;
    } {
  if (files.length > remainingSlots) {
    return {
      error: t(
        "You can attach up to {count, plural, one {# photo} other {# photos}} in total.",
        { count: MAX_REVIEW_PHOTOS },
      ),
    };
  }
  for (const file of files) {
    if (!(ACCEPTED_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
      return {
        error: t("Photos must be JPEG, PNG, or WebP images."),
      };
    }
    if (file.size > MAX_REVIEW_PHOTO_BYTES) {
      return {
        error: t("Each photo must be smaller than {sizeMb, number} MB.", {
          sizeMb: Math.round(MAX_REVIEW_PHOTO_BYTES / (1024 * 1024)),
        }),
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
  const t = useTranslation();
  const format = useFormat();
  const { enabled: communityEnabled } =
    useFeatureKillSwitch("community_access");
  const tc = TC;
  const [pendingVote, setPendingVote] = useState<"up" | "down" | null>(null);
  const photos = Array.isArray(review.photos) ? review.photos : [];
  // No vote gate here, deliberately. While `sys_poi_ratings` is off the panel
  // renders ONLY the viewer's own review, and a rider cannot vote on their own
  // — so no vote control exists to disable. A guard that can never fire would
  // read as protection this component does not actually provide.
  //
  // The consequence is that withdrawing a vote already cast on someone else's
  // review is unreachable during a pause, even though the backend leaves
  // `clearVote` open for exactly that. It needs an authenticated "my votes"
  // discovery path, so it is filed as #1177 rather than faked here. Note this
  // predates the own-review read: the previous `return []` hid every review
  // too, so nothing regressed.
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
      toast.error(getUserFacingErrorMessage(err, t("Could not submit vote.")));
    } finally {
      setPendingVote(null);
    }
  };
  return (
    <article className={`rounded-xl border p-3 ${tc.reviewCard}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The name still shows when community is killed — only the
              navigation into the gated area goes. */}
          {review.user_id && !review.is_mine && communityEnabled ? (
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
            {formatRelativeTimeLabel(review.created_at, { format }, t)}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5"
          aria-label={t("{rating} out of {max}", {
            rating: format.integer(Math.round(review.rating)),
            max: format.integer(5),
          })}
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
              alt={t("{name} review photo {n}", {
                name: review.user_display_name,
                n: index + 1,
              })}
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
                ? t("Remove helpful vote")
                : t("Mark this review as helpful")
            }
            count={format.integer(review.helpful_count)}
            active={review.my_vote === true}
            pending={pendingVote === "up"}
            inactiveClass={tc.chipInactive}
            icon={<ThumbsUp size={12} />}
            onClick={() => submitVote(true)}
          />
          <VoteButton
            label={
              review.my_vote === false
                ? t("Remove not-helpful vote")
                : t("Mark this review as not helpful")
            }
            count={format.integer(review.not_helpful_count)}
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
  count: formattedValue,
  active,
  pending,
  inactiveClass,
  icon,
  onClick,
}: {
  label: string;
  count: string;
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
      <span>{formattedValue}</span>
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
  t: Translate,
):
  | {
      ok: true;
      data: UpsertRoadReviewInput;
    }
  | {
      ok: false;
      error: string;
    } {
  if (draft.rating < 1 || draft.rating > 5) {
    return {
      ok: false,
      error: t("Choose a star rating before you submit."),
    };
  }
  if (draft.photoUrls.length > MAX_REVIEW_PHOTOS) {
    return {
      ok: false,
      error: t(
        "You can attach up to {count, plural, one {# photo} other {# photos}}.",
        { count: MAX_REVIEW_PHOTOS },
      ),
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
