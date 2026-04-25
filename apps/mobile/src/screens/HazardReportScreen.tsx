/**
 * HazardReportScreen — US-4.
 *
 * The mid-ride hazard reporting flow. Goal: minimum saddle-time. The
 * rider taps a hazard type tile (large hit target), confirms severity,
 * optionally adds a one-line note or a photo, and hits Submit. The
 * location is auto-captured from the active GPS feed; the rider can see
 * lat/lng + accuracy and re-pull a fresh fix before submitting.
 *
 * Network handling lives in `services/hazardQueue` — we always hand the
 * payload to `api.submitHazardReport`, which decides between live POST
 * and offline queueing. Either outcome counts as success from the
 * rider's perspective; the modal closes with haptic feedback so the
 * rider can keep their eyes on the road.
 *
 * Photo attachment goes through `services/photoCapture` so this screen
 * stays free of Android `PermissionsAndroid` plumbing. The picker
 * library hasn't landed yet — until it does the launcher returns
 * `unavailable` and the screen shows a gentle "coming soon" line.
 *
 * Realtime broadcast: we add the freshly-uploaded hazard to
 * `useHazardStore` immediately so the map shows it on the next tab
 * switch without waiting for the WebSocket fan-out (the store
 * subscription will dedupe by id when the broadcast arrives).
 */

import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  hazardIcons,
  shadows,
  spacing,
} from "@/theme";
import { api } from "@/services/api";
import { locationService } from "@/services/location";
import {
  capturePhoto,
  type CapturedPhoto,
  type PhotoSource,
} from "@/services/photoCapture";
import { useHazardStore } from "@/stores";
import { HAZARD_TYPE_LABELS, HAZARD_TYPE_ORDER } from "@/constants/hazards";
import type { HazardType, Severity } from "@/types";
import type { RideStackParamList } from "@/navigation/RootNavigator";

type IconName = ComponentProps<typeof Icon>["name"];

// `RideStackParamList` is the canonical shape; MapStack mirrors it, so
// either tab's HazardReport route is structurally compatible.
type HazardReportRoute = RouteProp<RideStackParamList, "HazardReport">;
type HazardReportNav = NativeStackNavigationProp<
  RideStackParamList,
  "HazardReport"
>;

const SEVERITIES: { value: Severity; label: string; color: string }[] = [
  { value: "low", label: "Low", color: colors.quality.fair },
  { value: "medium", label: "Medium", color: colors.warning },
  { value: "high", label: "High", color: colors.danger },
];

/** Sensible cap so the note stays a glanceable one-liner on the map card. */
const NOTE_MAX_CHARS = 140;

/**
 * Treat fixes older than this as stale — the rider is moving, so a
 * coordinate from minutes ago could be hundreds of metres off the
 * actual hazard. The form blocks submission on stale data and the UI
 * surfaces a "Refresh" affordance.
 */
const LOCATION_STALE_AFTER_MS = 30_000;

interface ResolvedLocation {
  lat: number;
  lng: number;
  accuracy: number;
  /** When the underlying GPS fix was acquired (ms epoch). */
  timestamp: number;
}

export default function HazardReportScreen() {
  const navigation = useNavigation<HazardReportNav>();
  const { params } = useRoute<HazardReportRoute>();
  const addHazard = useHazardStore((s) => s.addHazard);

  const [hazardType, setHazardType] = useState<HazardType | null>(
    params?.preselectedType ?? null,
  );
  const [severity, setSeverity] = useState<Severity>("medium");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [photoCapturing, setPhotoCapturing] = useState(false);

  // Two-stage location strategy:
  //   1. Seed with the cached `lastLocation` for instant feedback when
  //      the modal opens during an active ride (the watch is running,
  //      the value is fresh).
  //   2. Always kick off a one-shot `getCurrentLocation()` to get a
  //      brand-new fix. This is what saves the Map-tab path: the
  //      location service isn't running there, so the cache may be
  //      `null` or arbitrarily stale. The async refresh lands a real
  //      coordinate before the rider taps Submit.
  //
  // We re-render on every fresh fix (just one per request, not a
  // subscription) so the displayed coords / accuracy / staleness flag
  // stay accurate without the live-watch re-render churn.
  const [location, setLocation] = useState<ResolvedLocation | null>(() => {
    const last = locationService.getLastLocation();
    return last
      ? {
          lat: last.lat,
          lng: last.lng,
          accuracy: last.accuracy,
          timestamp: last.timestamp,
        }
      : null;
  });
  const [locationLoading, setLocationLoading] = useState(false);

  const refreshLocation = useCallback(async () => {
    setLocationLoading(true);
    try {
      const fresh = await locationService.getCurrentLocation();
      if (!fresh) return;
      setLocation({
        lat: fresh.lat,
        lng: fresh.lng,
        accuracy: fresh.accuracy,
        timestamp: fresh.timestamp,
      });
    } finally {
      setLocationLoading(false);
    }
  }, []);

  useEffect(() => {
    // Always pull a fresh fix on open — even if we have a cached
    // value, the rider may have moved since the watch last ticked
    // (or there was no watch running on the Map tab). Cancel guards
    // against a fast unmount; the resolver itself silently returns
    // the cached value on GPS failure so this never throws.
    let cancelled = false;
    void locationService.getCurrentLocation().then((fresh) => {
      if (cancelled || !fresh) return;
      setLocation({
        lat: fresh.lat,
        lng: fresh.lng,
        accuracy: fresh.accuracy,
        timestamp: fresh.timestamp,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedNote = note.trim();
  // Staleness check uses wall-clock time against the GPS fix
  // timestamp so a rider who left the modal open (or whose phone
  // background-suspended the JS thread) doesn't accidentally submit
  // a hazard at last hour's coordinate. Recomputed on every render
  // off `Date.now()`, but the form is ephemeral so this is cheap.
  const isLocationStale =
    location !== null &&
    Date.now() - location.timestamp > LOCATION_STALE_AFTER_MS;
  const canSubmit =
    hazardType !== null && location !== null && !isLocationStale && !submitting;

  const handleSelectType = useCallback((type: HazardType) => {
    setHazardType(type);
    setErrorMessage(null);
  }, []);

  const handleSelectSeverity = useCallback((value: Severity) => {
    setSeverity(value);
  }, []);

  const handleAddPhoto = useCallback(async (source: PhotoSource) => {
    setPhotoCapturing(true);
    setPhotoNotice(null);
    try {
      const result = await capturePhoto(source);
      switch (result.status) {
        case "captured":
          if (result.photo) {
            setPhoto(result.photo);
          }
          return;
        case "cancelled":
          return;
        case "permission-denied":
          setPhotoNotice(
            source === "camera"
              ? "Camera access denied. Enable it from Settings to attach a photo."
              : "Photo library access denied. Enable it from Settings to attach a photo.",
          );
          return;
        case "unavailable":
          setPhotoNotice(
            result.reason ??
              "Photo attachment isn't available on this build yet.",
          );
          return;
      }
    } finally {
      setPhotoCapturing(false);
    }
  }, []);

  const handleClearPhoto = useCallback(() => {
    setPhoto(null);
    setPhotoNotice(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (hazardType === null) {
      setErrorMessage("Pick a hazard type to report.");
      return;
    }
    if (location === null) {
      setErrorMessage("Waiting for GPS — try again in a moment.");
      return;
    }
    if (isLocationStale) {
      setErrorMessage("Location is stale — refresh GPS before submitting.");
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await api.submitHazardReport({
        lat: location.lat,
        lng: location.lng,
        hazardType,
        severity,
        note: trimmedNote.length > 0 ? trimmedNote : undefined,
        photoUri: photo?.uri,
      });

      // Optimistic store update so the rider's own report shows on the
      // map without a round-trip wait — works for both live and queued
      // outcomes. The `Hazard` shape isn't returned for queued
      // submissions, so we synthesise a minimal one with a temporary
      // id; when (if) the WebSocket broadcast arrives, the store can
      // reconcile by `id` (the queued report will eventually replace
      // the synthetic record after a successful drain).
      if (result.hazard) {
        addHazard(result.hazard);
      }

      // Friendly tactile confirmation — riders often have gloves on and
      // can't see the screen flash, but they always feel the buzz.
      ReactNativeHapticFeedback.trigger("notificationSuccess", {
        enableVibrateFallback: true,
        ignoreAndroidSystemSettings: false,
      });

      if (result.status === "queued") {
        // Don't block dismissal — the queue retries automatically. A
        // toast would be ideal but the app has no toast system yet, so
        // a one-shot Alert.OK is the lightweight fallback. Dismiss
        // first so the modal animates out before the alert lands.
        navigation.goBack();
        Alert.alert(
          "Report queued",
          "You're offline — we'll send the report once you're back on a connection.",
        );
        return;
      }
      navigation.goBack();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't submit the report.";
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    hazardType,
    location,
    isLocationStale,
    severity,
    trimmedNote,
    photo,
    addHazard,
    navigation,
  ]);

  const handleCancel = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const noteCharsLeft = NOTE_MAX_CHARS - note.length;

  const locationLine = useMemo(() => {
    if (!location) {
      return locationLoading ? "Acquiring GPS…" : "Waiting for GPS…";
    }
    const acc =
      Number.isFinite(location.accuracy) && location.accuracy > 0
        ? ` · ±${Math.round(location.accuracy)}m`
        : "";
    return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}${acc}`;
  }, [location, locationLoading]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Hazard type</Text>
          <View style={styles.typeGrid}>
            {HAZARD_TYPE_ORDER.map((type) => {
              const selected = hazardType === type;
              const label = HAZARD_TYPE_LABELS[type];
              return (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.typeTile,
                    selected ? styles.typeTileSelected : null,
                  ]}
                  onPress={() => handleSelectType(type)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Hazard type ${label}`}
                >
                  <Icon
                    name={(hazardIcons[type] ?? "alert-circle") as IconName}
                    size={28}
                    color={selected ? colors.textInverse : colors.primary}
                  />
                  <Text
                    style={[
                      styles.typeTileLabel,
                      selected ? styles.typeTileLabelSelected : null,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Severity</Text>
          <View style={styles.severityRow}>
            {SEVERITIES.map(({ value, label, color }) => {
              const selected = severity === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[
                    styles.severityChip,
                    selected
                      ? { backgroundColor: color, borderColor: color }
                      : null,
                  ]}
                  onPress={() => handleSelectSeverity(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${label} severity`}
                >
                  <Text
                    style={[
                      styles.severityLabel,
                      selected ? styles.severityLabelSelected : null,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.locationCard}>
            <Icon
              name="map-marker"
              size={20}
              color={
                isLocationStale
                  ? colors.warning
                  : location
                    ? colors.primary
                    : colors.textTertiary
              }
            />
            <Text style={styles.locationText} numberOfLines={1}>
              {locationLine}
            </Text>
            {locationLoading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <TouchableOpacity
                onPress={() => void refreshLocation()}
                accessibilityRole="button"
                accessibilityLabel="Refresh location"
                hitSlop={10}
              >
                <Icon name="refresh" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
          {isLocationStale ? (
            <Text style={styles.locationStaleNotice}>
              Last fix is more than 30s old — refresh to use your current
              position.
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Note (optional)</Text>
          <TextInput
            style={styles.noteInput}
            placeholder="One short note — e.g. 'left lane after bridge'"
            placeholderTextColor={colors.textTertiary}
            value={note}
            onChangeText={setNote}
            maxLength={NOTE_MAX_CHARS}
            multiline={false}
            returnKeyType="done"
            accessibilityLabel="Note"
          />
          <Text style={styles.noteCounter}>{noteCharsLeft}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Photo (optional)</Text>
          {photo ? (
            <View style={styles.photoCard}>
              <Icon name="image-check" size={20} color={colors.primary} />
              <Text style={styles.photoLabel} numberOfLines={1}>
                {photo.fileName ?? "Photo attached"}
              </Text>
              <TouchableOpacity
                onPress={handleClearPhoto}
                accessibilityRole="button"
                accessibilityLabel="Remove attached photo"
                hitSlop={10}
              >
                <Icon name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.photoButtons}>
              <Pressable
                style={styles.photoButton}
                onPress={() => handleAddPhoto("camera")}
                disabled={photoCapturing}
                accessibilityRole="button"
                accessibilityLabel="Take photo with camera"
              >
                <Icon name="camera" size={20} color={colors.textPrimary} />
                <Text style={styles.photoButtonLabel}>Camera</Text>
              </Pressable>
              <Pressable
                style={styles.photoButton}
                onPress={() => handleAddPhoto("library")}
                disabled={photoCapturing}
                accessibilityRole="button"
                accessibilityLabel="Pick photo from library"
              >
                <Icon name="image" size={20} color={colors.textPrimary} />
                <Text style={styles.photoButtonLabel}>Library</Text>
              </Pressable>
            </View>
          )}
          {photoNotice ? (
            <Text style={styles.photoNotice}>{photoNotice}</Text>
          ) : null}
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle" size={18} color={colors.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.actionButton, styles.cancelButton]}
            onPress={handleCancel}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[
              styles.actionButton,
              styles.submitButton,
              !canSubmit ? styles.submitButtonDisabled : null,
            ]}
            onPress={() => void handleSubmit()}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Submit hazard report"
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <>
                <Icon name="send" size={18} color={colors.textInverse} />
                <Text style={styles.submitLabel}>Submit</Text>
              </>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.section,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  typeTile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 88,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  typeTileSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    ...shadows.button,
  },
  typeTileLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textAlign: "center",
  },
  typeTileLabelSelected: {
    color: colors.textInverse,
  },
  severityRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  severityChip: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  severityLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  severityLabelSelected: {
    color: colors.textInverse,
  },
  locationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  locationText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },
  locationStaleNotice: {
    color: colors.warning,
    fontSize: fontSize.xs,
    lineHeight: 16,
  },
  noteInput: {
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
  },
  noteCounter: {
    alignSelf: "flex-end",
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  photoButtons: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  photoButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoButtonLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  photoCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },
  photoNotice: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    flex: 1,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
  },
  cancelButton: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  submitButton: {
    backgroundColor: colors.primary,
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
