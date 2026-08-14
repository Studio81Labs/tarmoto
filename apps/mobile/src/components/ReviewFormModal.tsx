/**
 * Review composer modal — US-25.
 *
 * Riders open this from RoadPreviewScreen to write, edit, or delete a
 * review for the current segment. The form covers the AC matrix:
 *   - 5-star rating selector (required)
 *   - Optional multiline note (1000 char cap matching backend DTO)
 *   - Optional bike model free text (web parity — there is no bikes
 *     module in the backend yet)
 *   - Photo picker (camera + library) up to MAX_REVIEW_PHOTOS, each
 *     uploaded one at a time to /roads/:segmentId/reviews/photos
 *   - Submit posts via api.submitReviewWithQueue (offline-aware) for
 *     creates, or api.updateReview for edits (edits require a server
 *     review row, so they're live-only).
 *   - Delete in edit mode behind a confirmation Alert.
 *
 * Photo upload happens before submit: each picked URI is shipped to
 * the backend upload endpoint and the returned URL is collected into
 * the entry's `url` field. Doing it in two steps means a network drop
 * after upload but before submit can be retried by the offline queue
 * without re-uploading the bytes (or re-billing storage).
 */

import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from "react-native";
import { Icon } from "@/components/Icon";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import { capturePhoto, type CaptureResult } from "@/services/photoCapture";
import { useAuthStore } from "@/stores";
import type { RoadReview } from "@/types";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation, useI18n } from "@/i18n/I18nProvider";
import { formatDisplayLowerCase } from "@tarmoto/shared";

const t = brandColorsLight;

export const MAX_REVIEW_PHOTOS = 5;
export const MAX_REVIEW_COMMENT_LENGTH = 1000;
export const MAX_REVIEW_BIKE_MODEL_LENGTH = 100;

export interface ReviewFormSubmitResult {
  status: "uploaded" | "queued";
  review?: RoadReview | undefined;
}

export interface ReviewFormModalProps {
  visible: boolean;
  segmentId: string;
  /** Existing review when editing; undefined when creating. */
  initialReview?: RoadReview | null;
  onClose(): void;
  /**
   * Resolves with the server-side review (or `queued` when offline).
   * The form awaits this so the parent's refresh work can finish
   * before `submitting` drops back to false (avoids a "Saved" flash
   * with the previous data still on screen).
   */
  /**
   * Opaque token identifying the target this editor was opened against. It is
   * handed back with the completion, so the parent can discard results
   * belonging to a target it has since left. The parent cannot hold this
   * itself: reopening the editor would overwrite a single shared value before
   * the earlier callback ran.
   *
   * The capture is the CLOSURE — a running `submit`/`confirmDelete` keeps the
   * `session` from the render that created it, so a later reopen cannot change
   * what an in-flight request reports. `session` is therefore a dependency of
   * both callbacks; without it a stale closure would echo the wrong token.
   */
  session?: number;
  onSubmitted(
    result: ReviewFormSubmitResult,
    session: number | undefined,
  ): void | Promise<void>;
  onDeleted?(session: number | undefined): void | Promise<void>;
  /**
   * `sys_poi_ratings`. When false the operator has paused reviews: writing and
   * editing are 503'd server-side, but DELETE is deliberately left open, and
   * this modal is mobile's only path to it. So the form goes read-only rather
   * than unreachable — a kill switch must never trap user content.
   */
  ratingsEnabled?: boolean;
  /**
   * Fired when the create POST returns 409 (the rider already has a
   * review on this segment). The parent should refetch personalised
   * reviews and update `initialReview` so the form can re-seed in
   * edit mode.
   *
   * Must return `true` only when the existing review is loaded into
   * `initialReview` — the form uses this signal to switch to edit
   * mode and show the "your existing review is loaded for editing"
   * banner. Returning `false` (or rejecting) tells the form the
   * reload failed and it should stay in create mode and surface a
   * regular error. Returning `void` from a legacy caller is
   * coerced to `false` for safety.
   *
   * The parent's pull-to-refresh helper deliberately swallows fetch
   * errors so the segment screen keeps showing the last-good
   * payload — this signal is the only reliable way for the form to
   * know whether the conflict reload actually succeeded.
   */
  onConflict?(): boolean | Promise<boolean>;
}

interface PhotoEntry {
  /**
   * Stable id assigned at insertion. Used to patch the entry when the
   * async upload resolves: array indices shift if the rider removes
   * a sibling mid-upload, so an index-based update would land on the
   * wrong slot (or no-op out of bounds), corrupting the submitted
   * `photos` array.
   */
  id: string;
  /** Local URI shown in the thumbnail strip; empty string after upload. */
  localUri: string;
  /** Backend URL once the photo is persisted. */
  url: string | null;
  /** True while the photo is mid-upload. */
  uploading: boolean;
  /** Human-readable reason when an upload fails. */
  error?: string;
  fileName?: string | undefined;
  mimeType?: string | undefined;
}

function nextPhotoId(): string {
  // Good-enough uniqueness for at most MAX_REVIEW_PHOTOS entries that
  // only need to disambiguate within a single form lifetime — a UUID
  // dependency would be overkill.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildInitialPhotos(initial?: RoadReview | null): PhotoEntry[] {
  if (!initial) return [];
  // `photos` is nullable when the author is masked (#279 / #501);
  // editing your own review never hits the mask (self-view exempt
  // server-side), but a defensive `?? []` keeps the form happy if
  // the wire payload ever arrives unhydrated.
  return (initial.photos ?? []).map((url) => ({
    id: nextPhotoId(),
    localUri: url,
    url,
    uploading: false,
  }));
}

export default function ReviewFormModal({
  visible,
  segmentId,
  initialReview,
  onClose,
  onSubmitted,
  onDeleted,
  onConflict,
  ratingsEnabled = true,
  session,
}: ReviewFormModalProps) {
  const translate = useTranslation();
  // Tracks whether the form is in create or edit mode. Seeded from
  // the initial `initialReview` and then ONLY updated alongside the
  // field-seeding effect below, so it stays in lockstep with the
  // values actually rendered in the form. Without this stickiness,
  // `isEditing` would flip from false to true the moment a parent
  // race (e.g. mount-time queue drain landing a flushed review into
  // `myReview`) flipped `initialReview` to non-null while the rider
  // was mid-typing — routing submit through `updateReview` (no
  // offline queue + null-clobbers cleared optional fields) and
  // surfacing a Delete button the rider never asked for.
  const [isEditing, setIsEditing] = useState<boolean>(Boolean(initialReview));
  // Used to scope queued review payloads to the current session — a
  // queued submit must not upload under a different account if the
  // rider signs out and back in as someone else on the same device.
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [rating, setRating] = useState<number>(initialReview?.rating ?? 0);
  const [comment, setComment] = useState<string>(initialReview?.comment ?? "");
  const [bikeModel, setBikeModel] = useState<string>(
    initialReview?.bike_model ?? "",
  );
  const [photos, setPhotos] = useState<PhotoEntry[]>(() =>
    buildInitialPhotos(initialReview),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);
  /**
   * Persisted explanation banner shown when the create POST 409s and
   * the form auto-switches to edit mode. Kept separate from `error`
   * because the seeding effect below clears `error` on every prop
   * change — we want this notice to survive the re-seed so the rider
   * sees why their fields suddenly contain different content.
   */
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  /**
   * Per-entry AbortController for in-flight photo uploads, so removing
   * a photo (or hiding the modal) cancels the request before the
   * backend writes a file we'd then leak.
   */
  const uploadAbortControllers = useRef<Map<string, AbortController>>(
    new Map(),
  );
  /**
   * Set true when the next prop-driven re-seed should MERGE staged
   * (already-uploaded) photos with the loaded review's photos rather
   * than replacing. Flipped on by the 409 catch path so the rider's
   * just-uploaded attachments aren't dropped (and orphaned on the
   * backend) when the form auto-switches to edit mode.
   */
  const mergeStagedOnNextReseed = useRef(false);
  /**
   * True once the seeding effect has poured initial values into the
   * form during the current `visible: true` session. Reset when the
   * modal closes. Used to ignore subsequent `initialReview` prop
   * changes that don't come from the rider — e.g. the mount-time
   * queue drain in `RoadPreviewScreen` flushing a previously-queued
   * review and chaining through to `setMyReview(...)` while the form
   * is already open. Without this guard, the seeding effect would
   * silently overwrite the rider's unsaved input with the flushed
   * review's content.
   */
  const hasSeededWhileVisibleRef = useRef(false);

  function abortAllUploads(): void {
    for (const controller of uploadAbortControllers.current.values()) {
      controller.abort();
    }
    uploadAbortControllers.current.clear();
  }

  // Abort uploads whenever the modal is hidden or the component
  // unmounts. The parent renders ReviewFormModal unconditionally and
  // toggles `visible`, so unmount-only cleanup wouldn't fire on close
  // — backgrounded uploads would keep tying up the network and any
  // file the backend persisted between abort and unmount would leak.
  useEffect(() => {
    if (visible) return;
    abortAllUploads();
  }, [visible]);
  useEffect(() => {
    return () => abortAllUploads();
  }, []);

  // Re-seed when the modal re-opens or `initialReview` changes (e.g.
  // the rider tapped Edit on their own row after Cancel, or the
  // parent hand-promoted a 409 conflict into edit mode).
  //
  // Only reseed on the FIRST run after `visible` flips true, or when
  // the conflict path opted in via `mergeStagedOnNextReseed`. A bare
  // `initialReview` prop change while the form is already open is
  // treated as background noise (the queue drain at parent mount can
  // chain through to `setMyReview(...)` and flip `initialReview` from
  // null to a flushed review while the rider is mid-typing) and must
  // not silently clobber the rider's unsaved input.
  useEffect(() => {
    if (!visible) {
      hasSeededWhileVisibleRef.current = false;
      return;
    }
    if (hasSeededWhileVisibleRef.current && !mergeStagedOnNextReseed.current) {
      return;
    }
    hasSeededWhileVisibleRef.current = true;
    setIsEditing(Boolean(initialReview));
    setRating(initialReview?.rating ?? 0);
    setComment(initialReview?.comment ?? "");
    setBikeModel(initialReview?.bike_model ?? "");
    if (mergeStagedOnNextReseed.current) {
      mergeStagedOnNextReseed.current = false;
      // Conflict-driven reseed: keep already-uploaded staged photos
      // (their backend files are real and not yet referenced by any
      // review) and merge them with the existing review's photos.
      // Dedup by URL, cap at MAX. The rider can then remove unwanted
      // ones before tapping Save.
      setPhotos((prev) => {
        const staged = prev.filter((p) => p.url !== null);
        const seen = new Set(staged.map((p) => p.url));
        const merged: PhotoEntry[] = [...staged];
        for (const entry of buildInitialPhotos(initialReview)) {
          if (entry.url && seen.has(entry.url)) continue;
          merged.push(entry);
          if (merged.length >= MAX_REVIEW_PHOTOS) break;
        }
        return merged.slice(0, MAX_REVIEW_PHOTOS);
      });
    } else {
      setPhotos(buildInitialPhotos(initialReview));
    }
    setError(null);
    setPickerNotice(null);
    // Reset the submit-busy flag too. The submit's `finally { setSubmitting(false) }`
    // runs only after the parent's awaited `onSubmitted` resolves, so the
    // window between `setFormVisible(false)` and that resolution leaves
    // `submitting` true. Without this reset, re-opening the form via the
    // Edit affordance during that window would render a fresh-looking
    // form whose Submit button is stuck disabled with a spinner.
    setSubmitting(false);
  }, [visible, initialReview]);

  // Drop the conflict banner whenever the modal is closed so a fresh
  // open starts clean. Distinct from the seed effect above so the
  // banner survives the prop-driven re-seed that the conflict path
  // itself triggers.
  useEffect(() => {
    if (!visible) setConflictNotice(null);
  }, [visible]);

  // Blocked while the switch is off: `create` and `update` both 503, so
  // letting the rider fill the form and tap Save only to meet the failure is
  // exactly the shape this gate exists to prevent. `confirmDelete` below is
  // intentionally NOT gated.
  const canSubmit = rating >= 1 && rating <= 5 && !submitting && ratingsEnabled;
  // Disabling only Save leaves a form that still ACCEPTS edits — stars, text,
  // photo removal, and camera/library picks that hit the upload endpoint and
  // come back 503. A rider can spend real effort on changes that can never be
  // saved. Read-only means read-only; Close and Delete stay live.
  const readOnly = !ratingsEnabled;
  // The picker is a native, potentially long modal, and an upload is a network
  // round trip. Both can straddle an operator flip, so the async continuations
  // below must re-read the LIVE value rather than the one captured when they
  // started.
  /** The live session, for the native alert's callback: it outlives this modal
   *  being closed, so the target can change between opening the confirmation
   *  and confirming it. */
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (!readOnly) return;
    // Anything already uploading would land a photo the rider can no longer
    // save or remove — an orphan on the server. Drop it now.
    abortAllUploads();
    // ...and drop the rows with it. The abort handler deliberately returns
    // without touching state (it assumes the entry is going away anyway), so
    // leaving them would pin `uploading: true` forever: if the operator
    // restores ratings while this modal is still open, every Save would report
    // unfinished uploads until the rider removed and reselected each photo.
    setPhotos((current) => current.filter((photo) => !photo.uploading));
  }, [readOnly]);
  const photosUploading = photos.some((p) => p.uploading);
  const photosFull = photos.length >= MAX_REVIEW_PHOTOS;

  const updatePhoto = useCallback((id: string, patch: Partial<PhotoEntry>) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    );
  }, []);

  const handlePickPhoto = useCallback(
    async (source: "camera" | "library") => {
      if (photosFull || readOnlyRef.current) return;
      setPickerNotice(null);
      const result: CaptureResult = await capturePhoto(source);
      // The picker can sit open across a flip. Without this the continuation
      // uploads into the gated endpoint, taking a 503 the rider cannot clear
      // from a form that is now read-only — or worse, succeeds and orphans a
      // photo on a review that can never be saved.
      if (readOnlyRef.current) return;
      if (result.status === "cancelled") return;
      if (result.status === "permission-denied") {
        setPickerNotice(
          source === "camera"
            ? translate(
                "Camera access was denied. Enable it in Settings to attach photos.",
              )
            : translate(
                "Photo library access was denied. Enable it in Settings to attach photos.",
              ),
        );
        return;
      }
      if (result.status === "unavailable" || !result.photo) {
        setPickerNotice(
          result.reason ??
            translate("Photo picker isn't available on this device."),
        );
        return;
      }

      // Assign the id BEFORE inserting so the async upload resolution
      // can patch the same row even if the rider removes a sibling
      // photo mid-upload.
      const entry: PhotoEntry = {
        id: nextPhotoId(),
        localUri: result.photo.uri,
        url: null,
        uploading: true,
        fileName: result.photo.fileName,
        mimeType: result.photo.mimeType,
      };
      // Re-check the cap inside the functional updater. The earlier
      // `photosFull` guard reads the closure value captured BEFORE
      // `capturePhoto` awaited, so a background reseed (e.g. a queue
      // drain that promotes the rider to edit mode and seeds 5
      // existing photos while the picker UI is open) can race the
      // append and push the array past MAX_REVIEW_PHOTOS. The
      // functional check sees the latest state and silently drops
      // the late pick rather than corrupting the limit.
      let inserted = true;
      setPhotos((prev) => {
        if (prev.length >= MAX_REVIEW_PHOTOS) {
          inserted = false;
          return prev;
        }
        return [...prev, entry];
      });
      if (!inserted) return;

      const abortController = new AbortController();
      uploadAbortControllers.current.set(entry.id, abortController);

      try {
        const { photos: urls } = await api.uploadReviewPhotos(
          segmentId,
          [
            {
              uri: result.photo.uri,
              ...(result.photo.mimeType !== undefined
                ? { mimeType: result.photo.mimeType }
                : {}),
              ...(result.photo.fileName !== undefined
                ? { fileName: result.photo.fileName }
                : {}),
            },
          ],
          { signal: abortController.signal },
        );
        uploadAbortControllers.current.delete(entry.id);
        const url = urls[0];
        if (!url) {
          updatePhoto(entry.id, {
            uploading: false,
            error: translate("Upload failed — tap × to remove and try again."),
          });
          return;
        }
        updatePhoto(entry.id, { url, uploading: false });
      } catch (uploadError) {
        uploadAbortControllers.current.delete(entry.id);
        if (isAbortError(uploadError) || abortController.signal.aborted) {
          // Aborted uploads are intentional — entry is already gone or
          // about to be; skip the error UI.
          return;
        }
        updatePhoto(entry.id, {
          uploading: false,
          error: translate("Upload failed — tap × to remove and try again."),
        });
      }
    },
    [photosFull, segmentId, updatePhoto, translate],
  );

  const removePhoto = useCallback((id: string) => {
    // Cancel any in-flight upload for this entry. Aborting before the
    // backend writes the multipart body avoids leaking an orphaned
    // file for the common "tapped wrong photo, removed it before it
    // finished" case.
    //
    // Already-completed uploads (entries with `url !== null`) leave
    // a file on the backend with no review row referencing it. There
    // is no per-photo DELETE endpoint today, so we can't proactively
    // clean those up. US-55 (#304) explicitly accepts this as a
    // known orphan-leak and tracks an S3-backed lifecycle sweep
    // separately — adding a tactical client→server cleanup call here
    // would duplicate that work and couple the mobile flow to a
    // surface that's about to be replaced.
    const controller = uploadAbortControllers.current.get(id);
    if (controller) {
      controller.abort();
      uploadAbortControllers.current.delete(id);
    }
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    if (photosUploading) {
      setError(translate("Wait for photos to finish uploading."));
      return;
    }
    // Block submit when any photo entry has an upload error. The old
    // version filtered by `Boolean(p.url)` which silently dropped
    // failed entries — the rider would tap Submit thinking 5 photos
    // shipped and end up with a review missing the ones whose upload
    // had errored. Forcing the rider to retry or remove first means
    // the published review matches what they see in the form.
    const failedPhotos = photos.filter((p) => p.error);
    if (failedPhotos.length > 0) {
      setError(
        translate(
          "Some photos failed to upload — retry or remove them before submitting.",
        ),
      );
      return;
    }
    if (!currentUserId) {
      // The form should only be reachable while authenticated, but
      // guard so a stale-token edge case doesn't fall through to the
      // queue without an owner — without `userId` the entry would
      // get treated as foreign-user at drain time and never flush.
      setError(translate("Sign in to submit your review."));
      return;
    }
    const photoUrls = photos
      .map((p) => p.url)
      .filter((u): u is string => Boolean(u));
    const trimmedComment = comment.trim();
    const trimmedBike = bikeModel.trim();
    setSubmitting(true);
    setError(null);

    try {
      if (isEditing) {
        // Update path uses explicit `null` / `[]` for cleared
        // optional fields. `JSON.stringify` strips `undefined`,
        // which would let a permissive PUT handler interpret a
        // missing key as "keep existing value" — clearing the
        // rider's comment in the UI would silently leave the old
        // comment on the server. Sending the explicit empty form
        // keeps the wire payload unambiguous regardless of how the
        // backend reads PUT semantics.
        const review = await api.updateReview({
          segmentId,
          rating,
          comment: trimmedComment || null,
          bikeModel: trimmedBike || null,
          photos: photoUrls.length > 0 ? photoUrls : [],
        });
        // Await the parent's async work so `submitting` stays true
        // until the refresh + segment refetch land — otherwise the
        // form would flip to "Saved" while the parent list still
        // shows stale data.
        await onSubmitted({ status: "uploaded", review }, session);
      } else {
        // Create path can omit empty optional fields — there's no
        // existing row to "preserve."
        const result = await api.submitReviewWithQueue(
          {
            segmentId,
            rating,
            ...(trimmedComment ? { comment: trimmedComment } : {}),
            ...(trimmedBike ? { bikeModel: trimmedBike } : {}),
            ...(photoUrls.length > 0 ? { photos: photoUrls } : {}),
          },
          currentUserId,
        );
        await onSubmitted(
          { status: result.status, review: result.review },
          session,
        );
      }
    } catch (e: unknown) {
      if (isConflictError(e)) {
        // 409 means the rider already has a review on this segment.
        // Don't bubble through `onSubmitted` (which closes the form).
        // Instead ask the parent to refresh. Once `initialReview`
        // updates the seeding effect re-pours the existing values
        // into the same visible form, merging in any photos the
        // rider just uploaded so they aren't orphaned on the
        // backend.
        //
        // The conflict banner is set ONLY when `onConflict` reports
        // success (returns true). The parent's segment refresh
        // helper swallows fetch errors so a `void` return / never
        // throws would otherwise hide a failed reload behind the
        // banner; the explicit boolean signal lets us fall back to
        // a regular error and keep the form in create mode if the
        // reload didn't actually populate `initialReview`.
        mergeStagedOnNextReseed.current = true;
        let reloadSucceeded: boolean;
        try {
          reloadSucceeded = (await onConflict?.()) ?? false;
        } catch {
          reloadSucceeded = false;
        }
        if (reloadSucceeded) {
          setConflictNotice(
            translate(
              "You already reviewed this road — your existing review is loaded for editing.",
            ),
          );
        } else {
          mergeStagedOnNextReseed.current = false;
          setError(
            translate(
              "You already reviewed this road, but loading the existing review failed. Close and reopen to retry.",
            ),
          );
        }
      } else {
        setError(apiErrorMessage(e) ?? translate("Couldn't save your review."));
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    bikeModel,
    canSubmit,
    comment,
    currentUserId,
    isEditing,
    onConflict,
    onSubmitted,
    photos,
    photosUploading,
    rating,
    segmentId,
    session,
    translate,
  ]);

  const confirmDelete = useCallback(() => {
    if (!isEditing || submitting) return;
    // Captured now; compared against the live value before the DELETE is sent.
    const confirmationSession = session;
    Alert.alert(
      translate("Delete review?"),
      translate(
        "This permanently removes your review and any attached photos.",
      ),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Delete"),
          style: "destructive",
          onPress: async () => {
            // BEFORE the request, not after. Closing this modal does not
            // dismiss a native alert, so an account switch (or a move to
            // another road) between opening the confirmation and confirming it
            // would otherwise send a DELETE with the NEW rider's credentials
            // against the OLD target — destroying a review that was never the
            // one being confirmed. Echoing the session to `onDeleted` cannot
            // help here: by then the deletion has already happened.
            if (sessionRef.current !== confirmationSession) return;
            setSubmitting(true);
            setError(null);
            try {
              await api.deleteReview(segmentId);
              // Same await rationale as the submit path: keep
              // `submitting` true until the parent's refresh lands.
              await onDeleted?.(session);
            } catch (e: unknown) {
              setError(
                apiErrorMessage(e) ?? translate("Couldn't delete your review."),
              );
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  }, [isEditing, onDeleted, segmentId, session, submitting, translate]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("Close review form")}
            onPress={onClose}
            style={styles.headerButton}
          >
            <Icon name="close" size={24} color={t.fg} />
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEditing
              ? translate("Edit your review")
              : translate("Write a review")}
          </Text>
          <View style={styles.headerButton} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {conflictNotice ? (
            <View style={styles.conflictBanner}>
              <Icon name="information-outline" size={16} color={t.fg} />
              <Text style={styles.conflictBannerText}>{conflictNotice}</Text>
            </View>
          ) : null}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{translate("Rating")}</Text>
            <RatingSelector
              value={rating}
              onChange={setRating}
              disabled={readOnly}
            />
            <Text style={styles.fieldHint}>
              {rating > 0
                ? translate("{rating} out of {max}", {
                    rating,
                    max: 5,
                  })
                : translate("Tap a star to rate this road")}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              {translate("Notes (optional)")}
            </Text>
            <TextInput
              accessibilityLabel={translate("Review notes")}
              editable={!readOnly}
              style={styles.commentInput}
              value={comment}
              onChangeText={setComment}
              maxLength={MAX_REVIEW_COMMENT_LENGTH}
              multiline
              numberOfLines={4}
              placeholder={translate(
                "What's the surface like? Any switchbacks worth flagging?",
              )}
              placeholderTextColor={t.mute}
              textAlignVertical="top"
            />
            <Text style={styles.fieldHint}>
              {translate("{current, number}/{max, number}", {
                current: comment.length,
                max: MAX_REVIEW_COMMENT_LENGTH,
              })}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              {translate("Bike model (optional)")}
            </Text>
            <TextInput
              accessibilityLabel={translate("Bike model")}
              editable={!readOnly}
              style={styles.bikeInput}
              value={bikeModel}
              onChangeText={setBikeModel}
              maxLength={MAX_REVIEW_BIKE_MODEL_LENGTH}
              placeholder={translate("e.g. BMW R1250GS")}
              placeholderTextColor={t.mute}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              {translate("Photos (optional, up to {count})", {
                count: MAX_REVIEW_PHOTOS,
              })}
            </Text>
            <PhotoStrip
              disabled={readOnly}
              photos={photos}
              onRemove={removePhoto}
              full={photosFull}
            />
            <View style={styles.photoButtons}>
              <PhotoButton
                icon="camera"
                label={translate("Camera")}
                onPress={() => void handlePickPhoto("camera")}
                disabled={photosFull || submitting || readOnly}
              />
              <PhotoButton
                icon="image-multiple"
                label={translate("Library")}
                onPress={() => void handlePickPhoto("library")}
                disabled={photosFull || submitting || readOnly}
              />
            </View>
            {pickerNotice ? (
              <Text style={styles.pickerNotice}>{pickerNotice}</Text>
            ) : null}
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {!ratingsEnabled ? (
            <Text style={styles.errorText}>
              {translate(
                "Reviews are temporarily unavailable, so changes can't be saved right now. You can still delete your review.",
              )}
            </Text>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          {isEditing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={translate("Delete review")}
              style={styles.deleteButton}
              onPress={confirmDelete}
              disabled={submitting}
            >
              <Icon
                name="trash-can-outline"
                size={20}
                color={statusFg.danger}
              />
              <Text style={styles.deleteLabel}>{translate("Delete")}</Text>
            </Pressable>
          ) : (
            <View style={styles.deleteButton} />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isEditing
                ? translate("Save review changes")
                : translate("Submit review")
            }
            accessibilityState={{ disabled: !canSubmit }}
            style={[
              styles.submitButton,
              !canSubmit && styles.submitButtonDisabled,
            ]}
            onPress={() => void submit()}
            disabled={!canSubmit}
          >
            {submitting ? (
              <ActivityIndicator color={t.invFg} />
            ) : (
              <Text style={styles.submitLabel}>
                {isEditing ? translate("Save") : translate("Submit")}
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function RatingSelector({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange(next: number): void;
  disabled?: boolean;
}) {
  const translate = useTranslation();
  return (
    <View style={styles.ratingRow}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= value;
        return (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={translate(
              "Set rating to {count, plural, one {# star} other {# stars}}",
              {
                count: star,
              },
            )}
            accessibilityState={{
              selected: filled,
              disabled: disabled === true,
            }}
            disabled={disabled}
            onPress={() => onChange(star)}
            style={styles.ratingStar}
          >
            <Icon
              name="star"
              size={36}
              // Lucide's star is a single outline glyph, so the selected state
              // is the accent stroke *plus* an accent fill — matching the old
              // Material filled/outline pair. Empty stars are the required,
              // interactive rating target, so they use `dim` (~5:1) rather than
              // `faint` (~1.5:1) to stay discoverable.
              color={filled ? ACCENT_DARK : t.dim}
              fill={filled ? ACCENT_DARK : "none"}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function PhotoStrip({
  disabled,
  photos,
  onRemove,
  full,
}: {
  photos: PhotoEntry[];
  onRemove(id: string): void;
  disabled?: boolean;
  full: boolean;
}) {
  const translate = useTranslation();
  if (photos.length === 0) {
    return (
      <Text style={styles.photoEmpty}>
        {full
          ? translate("Photo limit reached.")
          : translate(
              "No photos yet — add up to five with the camera or your library.",
            )}
      </Text>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.photoStrip}
    >
      {photos.map((photo, index) => (
        <View key={photo.id} style={styles.photoItem}>
          <Image
            source={{ uri: photo.localUri }}
            style={styles.photoThumb}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
          {photo.uploading ? (
            <View style={styles.photoOverlay}>
              {/* On the dark photo scrim, cream/white reads cleanly. */}
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : null}
          {photo.error ? (
            <View style={styles.photoOverlay}>
              <Icon name="alert-circle-outline" size={20} color="#FF8A80" />
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("Remove photo {value0}", {
              value0: index + 1,
            })}
            onPress={() => onRemove(photo.id)}
            disabled={disabled}
            style={styles.photoRemove}
          >
            <Icon name="close" size={14} color="#FFFFFF" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

type IconName = ComponentProps<typeof Icon>["name"];

function PhotoButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  const translate = useTranslation();
  const { locale } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={translate("Add photo from {value0}", {
        value0: formatDisplayLowerCase(label, locale),
      })}
      onPress={onPress}
      disabled={disabled}
      style={[styles.photoButton, disabled && styles.photoButtonDisabled]}
    >
      <Icon name={icon} size={18} color={disabled ? t.faint : t.fg} />
      <Text
        style={[
          styles.photoButtonLabel,
          disabled && styles.photoButtonLabelDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Return the facade's cataloged display message. Raw backend prose stays in
 * `ApiError.body` for diagnostics and must never cross into rider-facing UI.
 */
function apiErrorMessage(error: unknown): string | undefined {
  const message = getUserFacingErrorMessage(error, "");
  return message || undefined;
}

function isConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Detect a cancelled-via-AbortSignal upload so the error UI skips
 * the rejection that the rider's own × tap caused. The typed-client
 * facade preserves the native `AbortError` for caller-driven cancels
 * (see `typedClient.withTimeout` — only the timer-driven path is
 * substituted with `TimeoutError`), so a name match is enough.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; message?: string };
  return e.name === "AbortError" || /aborted/i.test(e.message ?? "");
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.line,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  body: {
    padding: brandSpacing.s4,
    gap: brandSpacing.s4,
  },
  field: {
    gap: brandSpacing.s2,
  },
  fieldLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  fieldHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  ratingRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  ratingStar: {
    paddingVertical: brandSpacing.s1,
  },
  commentInput: {
    backgroundColor: t.sunken,
    borderRadius: brandRadii.sm,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    minHeight: 96,
  },
  bikeInput: {
    backgroundColor: t.sunken,
    borderRadius: brandRadii.sm,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
  },
  photoStrip: {
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s1,
  },
  photoItem: {
    width: 96,
    height: 96,
    borderRadius: brandRadii.sm,
    backgroundColor: t.raised2,
    overflow: "hidden",
    position: "relative",
  },
  photoThumb: {
    width: "100%",
    height: "100%",
  },
  photoOverlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoRemove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoEmpty: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  photoButtons: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  photoButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  photoButtonDisabled: {
    opacity: 0.5,
  },
  photoButtonLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "500",
  },
  photoButtonLabelDisabled: {
    color: t.dim,
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    backgroundColor: t.raised2,
    borderRadius: brandRadii.sm,
    padding: brandSpacing.s3,
  },
  conflictBannerText: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  pickerNotice: {
    color: statusFg.warning,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.line,
  },
  deleteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
  },
  deleteLabel: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  submitButton: {
    flex: 1,
    backgroundColor: t.invBg,
    borderRadius: brandRadii.pill,
    minHeight: 48,
    paddingVertical: brandSpacing.s3,
    alignItems: "center",
    justifyContent: "center",
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
