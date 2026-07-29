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
 *
 * Brand: migrated onto the cream + ink brand system (Phase 3). Status
 * colours use the accessible `statusFg` tokens; the quality ramp backs
 * the severity fills. See docs/design/mobile-spec/README.md.
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
import { Icon } from "@/components/Icon";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { hazardIcons } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  QUALITY_COLORS,
  statusFg,
} from "@/theme/brand";
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
import { getUserFacingErrorMessage, type EnglishMessageKey } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

type IconName = ComponentProps<typeof Icon>["name"];

// `RideStackParamList` is the canonical shape; MapStack mirrors it, so
// either tab's HazardReport route is structurally compatible.
type HazardReportRoute = RouteProp<RideStackParamList, "HazardReport">;
type HazardReportNav = NativeStackNavigationProp<
  RideStackParamList,
  "HazardReport"
>;

const t = brandColorsLight;
const INK = "#0E0E10";

// Severity fills come from the quality ramp (Q4 → Q2 → Q1), matching the
// design prototype; ink text sits on the selected fill.
const SEVERITIES: {
  value: Severity;
  label: EnglishMessageKey;
  color: string;
}[] = [
  { value: "low", label: "Low", color: QUALITY_COLORS[3] },
  { value: "medium", label: "Medium", color: QUALITY_COLORS[1] },
  { value: "high", label: "High", color: QUALITY_COLORS[0] },
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
  const format = useFormat();
  const translate = useTranslation();
  const navigation = useNavigation<HazardReportNav>();
  const { params } = useRoute<HazardReportRoute>();
  const addHazard = useHazardStore((s) => s.addHazard);

  // Operator kill switch (`hazard_reporting`). The FAB is already hidden when
  // this is off, but the deep-link / CarPlay-voice entry
  // (`tarmoto://hazard/report`) opens this screen directly, so close it if the
  // switch is (or goes) off while the form is open.
  const reportingEnabled = useFeatureKillSwitchActive("hazard_reporting");
  useEffect(() => {
    if (!reportingEnabled) navigation.goBack();
  }, [reportingEnabled, navigation]);

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

  const handleAddPhoto = useCallback(
    async (source: PhotoSource) => {
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
                ? translate(
                    "Camera access denied. Enable it from Settings to attach a photo.",
                  )
                : translate(
                    "Photo library access denied. Enable it from Settings to attach a photo.",
                  ),
            );
            return;
          case "unavailable":
            setPhotoNotice(
              result.reason ??
                translate(
                  "Photo attachment isn't available on this build yet.",
                ),
            );
            return;
        }
      } finally {
        setPhotoCapturing(false);
      }
    },
    [translate],
  );

  const handleClearPhoto = useCallback(() => {
    setPhoto(null);
    setPhotoNotice(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    // Belt-and-braces: a form left open when the operator flips
    // `hazard_reporting` off (the navigate-back effect races the tap) must not
    // still POST. Re-read the switch synchronously at submit time.
    if (!isFeatureKillSwitchActive("hazard_reporting")) {
      navigation.goBack();
      return;
    }
    if (hazardType === null) {
      setErrorMessage(translate("Pick a hazard type to report."));
      return;
    }
    if (location === null) {
      setErrorMessage(translate("Waiting for GPS — try again in a moment."));
      return;
    }
    // Recompute staleness against the wall clock at submit time. The
    // render-time `isLocationStale` drives the disabled-state UI, but
    // an idle-but-open form (preselected type, no further interaction)
    // can sit past the 30s threshold without a re-render, so the
    // captured boolean would lie. This second check is the
    // authoritative gate.
    if (Date.now() - location.timestamp > LOCATION_STALE_AFTER_MS) {
      setErrorMessage(
        translate("Location is stale — refresh GPS before submitting."),
      );
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
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        ...(photo?.uri !== undefined ? { photoUri: photo.uri } : {}),
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
          translate("Report queued"),
          translate(
            "You're offline — we'll send the report once you're back on a connection.",
          ),
        );
        return;
      }
      navigation.goBack();
    } catch (err) {
      const message = getUserFacingErrorMessage(
        err,
        translate("Couldn't submit the report."),
      );
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    hazardType,
    location,
    severity,
    trimmedNote,
    photo,
    addHazard,
    navigation,
    translate,
  ]);

  const handleCancel = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const noteCharsLeft = NOTE_MAX_CHARS - note.length;

  const locationLine = useMemo(() => {
    if (!location) {
      return locationLoading
        ? translate("Acquiring GPS…")
        : translate("Waiting for GPS…");
    }
    const acc =
      Number.isFinite(location.accuracy) && location.accuracy > 0
        ? ` · ±${format.distanceM(location.accuracy)}`
        : "";
    return `${format.decimal(location.lat, 5)}, ${format.decimal(location.lng, 5)}${acc}`;
  }, [format, location, locationLoading, translate]);

  const locationIconColor = isLocationStale
    ? statusFg.warning
    : location
      ? statusFg.success
      : t.dim;

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
          <Text style={styles.sectionTitle}>{translate("Hazard type")}</Text>
          <View style={styles.typeGrid}>
            {HAZARD_TYPE_ORDER.map((type) => {
              const selected = hazardType === type;
              const label = translate(HAZARD_TYPE_LABELS[type]);
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
                  accessibilityLabel={translate("Hazard type {value0}", {
                    value0: label,
                  })}
                >
                  <Icon
                    name={(hazardIcons[type] ?? "alert-circle") as IconName}
                    size={28}
                    color={selected ? INK : t.fg}
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
          <Text style={styles.sectionTitle}>{translate("Severity")}</Text>
          <View style={styles.severityRow}>
            {SEVERITIES.map(({ value, label, color }) => {
              const selected = severity === value;
              const translatedLabel = translate(label);
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
                  accessibilityLabel={translate("{value0} severity", {
                    value0: translatedLabel,
                  })}
                >
                  <Text
                    style={[
                      styles.severityLabel,
                      selected ? styles.severityLabelSelected : null,
                    ]}
                  >
                    {translatedLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{translate("Location")}</Text>
          <View style={styles.locationCard}>
            <Icon name="map-marker" size={20} color={locationIconColor} />
            <Text style={styles.locationText} numberOfLines={1}>
              {locationLine}
            </Text>
            {locationLoading ? (
              <ActivityIndicator size="small" color={t.dim} />
            ) : (
              <TouchableOpacity
                onPress={() => void refreshLocation()}
                accessibilityRole="button"
                accessibilityLabel={translate("Refresh location")}
                hitSlop={12}
              >
                <Icon name="refresh" size={20} color={t.dim} />
              </TouchableOpacity>
            )}
          </View>
          {isLocationStale ? (
            <Text style={styles.locationStaleNotice}>
              {translate(
                "Last fix is more than {seconds, plural, one {# second} other {# seconds}} old — refresh to use your current position.",
                { seconds: 30 },
              )}
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {translate("Note (optional)")}
          </Text>
          <TextInput
            style={styles.noteInput}
            placeholder={translate(
              "One short note — e.g. 'left lane after bridge'",
            )}
            placeholderTextColor={t.mute}
            value={note}
            onChangeText={setNote}
            maxLength={NOTE_MAX_CHARS}
            multiline={false}
            returnKeyType="done"
            accessibilityLabel={translate("Note")}
          />
          <Text style={styles.noteCounter}>
            {format.integer(noteCharsLeft)}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {translate("Photo (optional)")}
          </Text>
          {photo ? (
            <View style={styles.photoCard}>
              <Icon name="image-check" size={20} color={statusFg.success} />
              <Text style={styles.photoLabel} numberOfLines={1}>
                {photo.fileName ?? translate("Photo attached")}
              </Text>
              <TouchableOpacity
                onPress={handleClearPhoto}
                accessibilityRole="button"
                accessibilityLabel={translate("Remove attached photo")}
                hitSlop={12}
              >
                <Icon name="close" size={20} color={t.dim} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.photoButtons}>
              <Pressable
                style={styles.photoButton}
                onPress={() => handleAddPhoto("camera")}
                disabled={photoCapturing}
                accessibilityRole="button"
                accessibilityLabel={translate("Take photo with camera")}
              >
                <Icon name="camera" size={20} color={t.fg} />
                <Text style={styles.photoButtonLabel}>
                  {translate("Camera")}
                </Text>
              </Pressable>
              <Pressable
                style={styles.photoButton}
                onPress={() => handleAddPhoto("library")}
                disabled={photoCapturing}
                accessibilityRole="button"
                accessibilityLabel={translate("Pick photo from library")}
              >
                <Icon name="image" size={20} color={t.fg} />
                <Text style={styles.photoButtonLabel}>
                  {translate("Library")}
                </Text>
              </Pressable>
            </View>
          )}
          {photoNotice ? (
            <Text style={styles.photoNotice}>{photoNotice}</Text>
          ) : null}
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle" size={18} color={statusFg.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.actionButton, styles.cancelButton]}
            onPress={handleCancel}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={translate("Cancel")}
          >
            <Text style={styles.cancelLabel}>{translate("Cancel")}</Text>
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
            accessibilityLabel={translate("Submit hazard report")}
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator color={INK} />
            ) : (
              <>
                <Icon name="send" size={18} color={INK} />
                <Text style={styles.submitLabel}>{translate("Submit")}</Text>
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
    backgroundColor: t.bg,
  },
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
  },
  section: {
    gap: brandSpacing.s2,
  },
  sectionTitle: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
  },
  typeTile: {
    flexBasis: "30%",
    flexGrow: 1,
    minHeight: 88,
    paddingVertical: brandSpacing.s3,
    paddingHorizontal: brandSpacing.s2,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s1,
  },
  typeTileSelected: {
    backgroundColor: t.accent,
    borderColor: t.accent,
  },
  typeTileLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 12.5,
    fontWeight: "700",
    textAlign: "center",
  },
  typeTileLabelSelected: {
    color: INK,
  },
  severityRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  severityChip: {
    flex: 1,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    alignItems: "center",
    justifyContent: "center",
  },
  severityLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  severityLabelSelected: {
    color: INK,
  },
  locationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  locationText: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 13,
  },
  locationStaleNotice: {
    color: statusFg.warning,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    lineHeight: 16,
  },
  noteInput: {
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
    color: t.fg,
    fontFamily: brandFonts.sans,
    borderRadius: brandRadii.md,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    fontSize: 14,
  },
  noteCounter: {
    alignSelf: "flex-end",
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 11,
  },
  photoButtons: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  photoButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  photoButtonLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  photoCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  photoLabel: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  photoNotice: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    lineHeight: 18,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: statusFg.danger,
    backgroundColor: "rgba(179,38,30,0.08)",
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  actionRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s2,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
  },
  cancelButton: {
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  cancelLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  submitButton: {
    backgroundColor: t.accent,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: INK,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
});
