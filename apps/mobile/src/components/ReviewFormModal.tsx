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
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import { capturePhoto, type CaptureResult } from "@/services/photoCapture";
import { useAuthStore } from "@/stores";
import type { RoadReview } from "@/types";

export const MAX_REVIEW_PHOTOS = 5;
export const MAX_REVIEW_COMMENT_LENGTH = 1000;
export const MAX_REVIEW_BIKE_MODEL_LENGTH = 100;

export interface ReviewFormSubmitResult {
  status: "uploaded" | "queued";
  review?: RoadReview;
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
  onSubmitted(result: ReviewFormSubmitResult): void | Promise<void>;
  onDeleted?(): void | Promise<void>;
  /**
   * Fired when the create POST returns 409 (the rider already has a
   * review on this segment). The parent should refetch personalised
   * reviews and update `initialReview` so the form can re-seed in
   * edit mode. The form stays visible across this transition.
   */
  onConflict?(): void | Promise<void>;
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
  fileName?: string;
  mimeType?: string;
}

function nextPhotoId(): string {
  // Good-enough uniqueness for at most MAX_REVIEW_PHOTOS entries that
  // only need to disambiguate within a single form lifetime — a UUID
  // dependency would be overkill.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildInitialPhotos(initial?: RoadReview | null): PhotoEntry[] {
  if (!initial) return [];
  return initial.photos.map((url) => ({
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
}: ReviewFormModalProps) {
  const isEditing = Boolean(initialReview);
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
  useEffect(() => {
    if (!visible) return;
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

  const canSubmit = rating >= 1 && rating <= 5 && !submitting;
  const photosUploading = photos.some((p) => p.uploading);
  const photosFull = photos.length >= MAX_REVIEW_PHOTOS;

  const updatePhoto = useCallback((id: string, patch: Partial<PhotoEntry>) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    );
  }, []);

  const handlePickPhoto = useCallback(
    async (source: "camera" | "library") => {
      if (photosFull) return;
      setPickerNotice(null);
      const result: CaptureResult = await capturePhoto(source);
      if (result.status === "cancelled") return;
      if (result.status === "permission-denied") {
        setPickerNotice(
          source === "camera"
            ? "Camera access was denied. Enable it in Settings to attach photos."
            : "Photo library access was denied. Enable it in Settings to attach photos.",
        );
        return;
      }
      if (result.status === "unavailable" || !result.photo) {
        setPickerNotice(
          result.reason ?? "Photo picker isn't available on this device.",
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
      setPhotos((prev) => [...prev, entry]);

      const abortController = new AbortController();
      uploadAbortControllers.current.set(entry.id, abortController);

      try {
        const { photos: urls } = await api.uploadReviewPhotos(
          segmentId,
          [
            {
              uri: result.photo.uri,
              mimeType: result.photo.mimeType,
              fileName: result.photo.fileName,
            },
          ],
          { signal: abortController.signal },
        );
        uploadAbortControllers.current.delete(entry.id);
        const url = urls[0];
        if (!url) {
          updatePhoto(entry.id, {
            uploading: false,
            error: "Upload failed — tap × to remove and try again.",
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
          error: "Upload failed — tap × to remove and try again.",
        });
      }
    },
    [photosFull, segmentId, updatePhoto],
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
      setError("Wait for photos to finish uploading.");
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
        "Some photos failed to upload — retry or remove them before submitting.",
      );
      return;
    }
    if (!currentUserId) {
      // The form should only be reachable while authenticated, but
      // guard so a stale-token edge case doesn't fall through to the
      // queue without an owner — without `userId` the entry would
      // get treated as foreign-user at drain time and never flush.
      setError("Sign in to submit your review.");
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
        await onSubmitted({ status: "uploaded", review });
      } else {
        // Create path can omit empty optional fields — there's no
        // existing row to "preserve."
        const result = await api.submitReviewWithQueue(
          {
            segmentId,
            rating,
            comment: trimmedComment || undefined,
            bikeModel: trimmedBike || undefined,
            photos: photoUrls.length > 0 ? photoUrls : undefined,
          },
          currentUserId,
        );
        await onSubmitted({ status: result.status, review: result.review });
      }
    } catch (e: unknown) {
      if (isConflictError(e)) {
        // 409 means the rider already has a review on this segment.
        // Don't bubble through `onSubmitted` (which closes the form).
        // Instead ask the parent to refresh. Once `initialReview`
        // updates the seeding effect re-pours the existing values
        // into the same visible form, merging in any photos the
        // rider just uploaded so they aren't orphaned on the backend.
        // The conflict banner is set ONLY after the parent refresh
        // succeeds — if `onConflict` rejects, the form stays in
        // create mode and we surface a regular error so the banner
        // text ("your existing review is loaded for editing") never
        // appears alongside an unchanged create-mode form.
        mergeStagedOnNextReseed.current = true;
        try {
          await onConflict?.();
          setConflictNotice(
            "You already reviewed this road — your existing review is loaded for editing.",
          );
        } catch {
          mergeStagedOnNextReseed.current = false;
          setError(
            "You already reviewed this road, but loading the existing review failed. Close and reopen to retry.",
          );
        }
      } else {
        const message = isAxiosError(e)
          ? (e.response?.data?.message ?? "Couldn't save your review.")
          : "Couldn't save your review.";
        setError(message);
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
  ]);

  const confirmDelete = useCallback(() => {
    if (!isEditing || submitting) return;
    Alert.alert(
      "Delete review?",
      "This permanently removes your review and any attached photos.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSubmitting(true);
            setError(null);
            try {
              await api.deleteReview(segmentId);
              // Same await rationale as the submit path: keep
              // `submitting` true until the parent's refresh lands.
              await onDeleted?.();
            } catch (e: unknown) {
              const message = isAxiosError(e)
                ? (e.response?.data?.message ?? "Couldn't delete your review.")
                : "Couldn't delete your review.";
              setError(message);
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  }, [isEditing, onDeleted, segmentId, submitting]);

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
            accessibilityLabel="Close review form"
            onPress={onClose}
            style={styles.headerButton}
          >
            <Icon name="close" size={24} color={colors.textPrimary} />
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEditing ? "Edit your review" : "Write a review"}
          </Text>
          <View style={styles.headerButton} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {conflictNotice ? (
            <View style={styles.conflictBanner}>
              <Icon
                name="information-outline"
                size={16}
                color={colors.primary}
              />
              <Text style={styles.conflictBannerText}>{conflictNotice}</Text>
            </View>
          ) : null}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Rating</Text>
            <RatingSelector value={rating} onChange={setRating} />
            <Text style={styles.fieldHint}>
              {rating > 0
                ? `${rating} out of 5`
                : "Tap a star to rate this road"}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput
              accessibilityLabel="Review notes"
              style={styles.commentInput}
              value={comment}
              onChangeText={setComment}
              maxLength={MAX_REVIEW_COMMENT_LENGTH}
              multiline
              numberOfLines={4}
              placeholder="What's the surface like? Any switchbacks worth flagging?"
              placeholderTextColor={colors.textTertiary}
              textAlignVertical="top"
            />
            <Text style={styles.fieldHint}>
              {comment.length}/{MAX_REVIEW_COMMENT_LENGTH}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Bike model (optional)</Text>
            <TextInput
              accessibilityLabel="Bike model"
              style={styles.bikeInput}
              value={bikeModel}
              onChangeText={setBikeModel}
              maxLength={MAX_REVIEW_BIKE_MODEL_LENGTH}
              placeholder="e.g. BMW R1250GS"
              placeholderTextColor={colors.textTertiary}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              Photos (optional, up to {MAX_REVIEW_PHOTOS})
            </Text>
            <PhotoStrip
              photos={photos}
              onRemove={removePhoto}
              full={photosFull}
            />
            <View style={styles.photoButtons}>
              <PhotoButton
                icon="camera"
                label="Camera"
                onPress={() => handlePickPhoto("camera")}
                disabled={photosFull || submitting}
              />
              <PhotoButton
                icon="image-multiple"
                label="Library"
                onPress={() => handlePickPhoto("library")}
                disabled={photosFull || submitting}
              />
            </View>
            {pickerNotice ? (
              <Text style={styles.pickerNotice}>{pickerNotice}</Text>
            ) : null}
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          {isEditing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete review"
              style={styles.deleteButton}
              onPress={confirmDelete}
              disabled={submitting}
            >
              <Icon name="trash-can-outline" size={20} color={colors.danger} />
              <Text style={styles.deleteLabel}>Delete</Text>
            </Pressable>
          ) : (
            <View style={styles.deleteButton} />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isEditing ? "Save review changes" : "Submit review"
            }
            accessibilityState={{ disabled: !canSubmit }}
            style={[
              styles.submitButton,
              !canSubmit && styles.submitButtonDisabled,
            ]}
            onPress={submit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={styles.submitLabel}>
                {isEditing ? "Save" : "Submit"}
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
}: {
  value: number;
  onChange(next: number): void;
}) {
  return (
    <View style={styles.ratingRow}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= value;
        return (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={`Set rating to ${star} ${
              star === 1 ? "star" : "stars"
            }`}
            accessibilityState={{ selected: filled }}
            onPress={() => onChange(star)}
            style={styles.ratingStar}
          >
            <Icon
              name={filled ? "star" : "star-outline"}
              size={36}
              color={filled ? colors.warning : colors.textTertiary}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function PhotoStrip({
  photos,
  onRemove,
  full,
}: {
  photos: PhotoEntry[];
  onRemove(id: string): void;
  full: boolean;
}) {
  if (photos.length === 0) {
    return (
      <Text style={styles.photoEmpty}>
        {full
          ? "Photo limit reached."
          : "No photos yet — add up to five with the camera or your library."}
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
              <ActivityIndicator color={colors.textInverse} />
            </View>
          ) : null}
          {photo.error ? (
            <View style={styles.photoOverlay}>
              <Icon
                name="alert-circle-outline"
                size={20}
                color={colors.danger}
              />
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove photo ${index + 1}`}
            onPress={() => onRemove(photo.id)}
            style={styles.photoRemove}
          >
            <Icon name="close" size={14} color={colors.textInverse} />
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add photo from ${label.toLowerCase()}`}
      onPress={onPress}
      disabled={disabled}
      style={[styles.photoButton, disabled && styles.photoButtonDisabled]}
    >
      <Icon
        name={icon}
        size={18}
        color={disabled ? colors.textTertiary : colors.textPrimary}
      />
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

function isAxiosError(
  error: unknown,
): error is { response?: { status?: number; data?: { message?: string } } } {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: unknown }).response === "object"
  );
}

function isConflictError(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 409;
}

/**
 * Detect a cancelled-via-AbortSignal axios error so the upload error
 * UI skips the rejection that the rider's own × tap caused. Axios v1+
 * sets `code === "ERR_CANCELED"` on cancellations; older versions emit
 * a `CanceledError` whose name we also accept defensively.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; name?: string; message?: string };
  return (
    e.code === "ERR_CANCELED" ||
    e.name === "CanceledError" ||
    e.name === "AbortError" ||
    /aborted/i.test(e.message ?? "")
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  body: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  field: {
    gap: spacing.sm,
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  fieldHint: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  ratingRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  ratingStar: {
    paddingVertical: spacing.xs,
  },
  commentInput: {
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.md,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 96,
  },
  bikeInput: {
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.md,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  photoStrip: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  photoItem: {
    width: 96,
    height: 96,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgElevated,
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
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontStyle: "italic",
  },
  photoButtons: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  photoButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgElevated,
  },
  photoButtonDisabled: {
    opacity: 0.5,
  },
  photoButtonLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  photoButtonLabelDisabled: {
    color: colors.textTertiary,
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.primaryAlpha15,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  conflictBannerText: {
    flex: 1,
    color: colors.primary,
    fontSize: fontSize.sm,
  },
  pickerNotice: {
    color: colors.warning,
    fontSize: fontSize.xs,
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  deleteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  deleteLabel: {
    color: colors.danger,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  submitButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
