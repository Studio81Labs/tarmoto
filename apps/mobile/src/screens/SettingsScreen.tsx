import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";
import { Icon } from "@/components/Icon";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { qualityLabel } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { Card, Stamp, Toggle } from "@/components/brand";
import QualityThresholdSlider from "@/components/QualityThresholdSlider";
import FuelRangePicker from "@/components/FuelRangePicker";
import {
  type DistanceUnitPref,
  type VoiceNavLanguage,
  useAuthStore,
  useOfflineStore,
  usePreferencesStore,
} from "@/stores";
import { usePendingHazardReports, usePendingUploads } from "@/hooks";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { useEntitlements, useFeature } from "@/hooks/useEntitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { ApiError, api } from "@/services/api";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import {
  getUserFacingErrorMessage,
  LOCALES,
  SUPPORTED_LOCALES,
  type EnglishMessageKey,
  type SupportedLocale,
  type Translate,
} from "@/i18n";
import { useTranslation, useI18n } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";

type SettingsNav = NativeStackNavigationProp<ProfileStackParamList, "Settings">;

// Brand palette (Atlas / light). Settings is the first screen migrated onto
// the cream + ink brand system — see docs/design/mobile-spec/README.md.
// Status text/icons use the accessible `statusFg` tokens (not the quality
// ramp, whose fills fail WCAG contrast as foreground on the white Card).
const t = brandColorsLight;
const WARNING = statusFg.warning;
const SUCCESS = statusFg.success;
const DANGER = statusFg.danger;

export default function SettingsScreen() {
  const translate = useTranslation();
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const setMinQuality = usePreferencesStore((s) => s.setMinQuality);
  const fuelRangeKm = usePreferencesStore((s) => s.fuelRangeKm);
  const setFuelRangeKm = usePreferencesStore((s) => s.setFuelRangeKm);
  const weatherAlertsEnabled = usePreferencesStore(
    (s) => s.weatherAlertsEnabled,
  );
  const setWeatherAlertsEnabled = usePreferencesStore(
    (s) => s.setWeatherAlertsEnabled,
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{translate("Settings")}</Text>

      <LocaleCard />

      <Card raised pad={brandSpacing.s4} style={styles.card}>
        {/* These stamps are the section headings — use the readable `dim`
            tone (AA on white), not the default muted eyebrow colour. */}
        <Stamp color={t.dim}>{translate("Route quality")}</Stamp>
        <Text style={styles.sectionBody}>
          {translate(
            "Routes and road segments below your minimum are grayed out so you can focus on the roads you actually want to ride.",
          )}
        </Text>

        <QualityThresholdSlider
          value={minQuality}
          onChange={setMinQuality}
          label={translate("Minimum quality")}
          helpText={translate("Currently showing {quality} and above.", {
            quality: qualityLabel(minQuality),
          })}
        />
      </Card>

      <Card raised pad={brandSpacing.s4} style={styles.card}>
        <Stamp color={t.dim}>{translate("Fuel range")}</Stamp>
        <Text style={styles.sectionBody}>
          {translate(
            "How far your bike comfortably goes on a tank. Trip days with a stretch longer than this between fuel stops will trigger a warning.",
          )}
        </Text>

        <FuelRangePicker
          value={fuelRangeKm}
          onChange={setFuelRangeKm}
          label={translate("Fuel range")}
          helpText={translate("Tap a distance to match your bike.")}
        />
      </Card>

      <Card raised pad={brandSpacing.s4} style={styles.card}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleBody}>
            <Text style={styles.sectionTitle}>
              {translate("Weather alerts")}
            </Text>
            <Text style={styles.sectionBody}>
              {translate(
                "Surface storms, ice, wet roads, and high wind ahead while navigating. Critical alerts (storm, ice) are also read aloud.",
              )}
            </Text>
          </View>
          <Toggle
            on={weatherAlertsEnabled}
            onToggle={setWeatherAlertsEnabled}
            accessibilityLabel={translate(
              "Toggle real-time weather alerts during navigation",
            )}
          />
        </View>
      </Card>

      <VoiceNavigationCard />

      <SafetyCard />

      <OfflineRegionsCard />

      <BulkExportCard />

      <PendingUploadsCard />

      <PendingHazardReportsCard />
    </ScrollView>
  );
}

/** Hidden for the English-only MVP; activates automatically with locale #2. */
function LocaleCard() {
  const { locale, t: localize } = useI18n();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const pendingLocale = usePreferencesStore(
    (state) => state.pendingUiLocaleSync,
  );
  const selectUiLocale = usePreferencesStore((state) => state.selectUiLocale);

  if (SUPPORTED_LOCALES.length <= 1) return null;

  const handleChange = (next: SupportedLocale) => {
    if (next === locale) return;
    selectUiLocale(next, userId);
  };

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <Stamp color={t.dim}>{localize("Language")}</Stamp>
      <SegmentedRow
        options={SUPPORTED_LOCALES.map((value) => ({
          value,
          label: LOCALES[value].label,
        }))}
        value={locale}
        onChange={handleChange}
        ariaLabel={localize("Language")}
      />
      {pendingLocale ? (
        <>
          <ActivityIndicator color={t.accent} size="small" />
          <Text style={styles.sectionBody}>
            {localize(
              "Language saved on this device. Account sync is pending.",
            )}
          </Text>
        </>
      ) : null}
    </Card>
  );
}

/**
 * US-20: bulk-export every recorded ride as either a single GPX bundle
 * (for re-importing into Garmin / Komoot / RideWithGPS) or a CSV summary
 * (for spreadsheets and fitness analytics tools). The XML/CSV is fetched
 * as text and written to the OS temp directory before being handed to
 * the share sheet — `Share.share({ message })` would deliver the bytes
 * as plain text and most importers reject that, so we always go through
 * the file path.
 */
function BulkExportCard() {
  const translate = useTranslation();
  const [busy, setBusy] = useState<"gpx" | "csv" | null>(null);
  // Synchronous re-entrancy guard. `busy` only flips on the next
  // render, so two same-frame taps would otherwise both pass the
  // `busy !== null` check and trigger duplicate API calls + share
  // sheets. Mirrors `importingRef` on `TripCreateScreen`.
  const busyRef = useRef(false);
  // GPX-only gate — CSV export stays free (US-20 unaffected).
  const { enabled: gpxEnabled, isResolved: gpxResolved } =
    useFeature("gpx_export");
  const { tier } = useEntitlements();
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const handleExport = useCallback(
    async (format: "gpx" | "csv") => {
      if (busyRef.current) return;
      // Proactive gate: once the entitlement snapshot is resolved, a
      // non-entitled rider gets the upgrade prompt instead of a doomed
      // request. CSV is never gated.
      if (format === "gpx" && gpxResolved && !gpxEnabled) {
        setUpgradeVisible(true);
        return;
      }
      busyRef.current = true;
      setBusy(format);
      const filename =
        format === "gpx" ? "tarmoto-rides.gpx" : "tarmoto-rides.csv";
      const tempPath = `${RNFS.TemporaryDirectoryPath}/${filename}`.replace(
        /\/{2,}/g,
        "/",
      );
      try {
        const data =
          format === "gpx"
            ? await api.exportAllRidesGpx()
            : await api.exportAllRidesCsv();
        await RNFS.writeFile(tempPath, data, "utf8");
        await RNShare.open({
          url: Platform.OS === "android" ? `file://${tempPath}` : tempPath,
          type: format === "gpx" ? "application/gpx+xml" : "text/csv",
          filename,
          title:
            format === "gpx"
              ? translate("Export all rides as GPX")
              : translate("Export all rides as CSV"),
          // failOnCancel=false: dismissing the sheet is a normal outcome,
          // not an error worth toasting.
          failOnCancel: false,
        });
      } catch (err) {
        // Safety net for a stale client-side entitlement snapshot: the
        // endpoint is server-enforced, so a non-entitled rider can still
        // reach here and gets a 403 with no `code` (feature-guard body,
        // not the `FEATURE_LIMIT_EXCEEDED` limit shape) — show the same
        // upgrade prompt instead of a generic error toast.
        if (format === "gpx" && err instanceof ApiError && err.status === 403) {
          setUpgradeVisible(true);
        } else {
          Alert.alert(
            translate("Couldn't export"),
            getUserFacingErrorMessage(
              err,
              translate("Unable to export rides."),
            ),
          );
        }
      } finally {
        // Same rationale as the per-ride export: leave the temp file in
        // place so deferred consumers (Mail, Files, third-party importers)
        // can read it lazily. The OS reaps `TemporaryDirectoryPath`.
        busyRef.current = false;
        setBusy(null);
      }
    },
    [gpxEnabled, gpxResolved, translate],
  );

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon name="export-variant" size={22} color={t.fg} />
        <Text style={styles.sectionTitle}>{translate("Export rides")}</Text>
      </View>
      <Text style={styles.sectionBody}>
        {translate(
          "Download your full ride history as GPX (for Garmin / RideWithGPS) or CSV (for spreadsheets).",
        )}
      </Text>
      <View style={styles.exportRow}>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={() => void handleExport("gpx")}
          disabled={busy !== null || !gpxResolved}
          accessibilityRole="button"
          accessibilityLabel={translate("Export all rides as GPX")}
        >
          {busy === "gpx" ? (
            <ActivityIndicator color={t.accent} size="small" />
          ) : (
            <>
              <Icon name="download-outline" size={18} color={t.fg} />
              <Text style={styles.exportBtnLabel}>{translate("GPX")}</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={() => void handleExport("csv")}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={translate("Export all rides as CSV")}
        >
          {busy === "csv" ? (
            <ActivityIndicator color={t.accent} size="small" />
          ) : (
            <>
              <Icon name="table" size={18} color={t.fg} />
              <Text style={styles.exportBtnLabel}>{translate("CSV")}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
      <UpgradePrompt
        visible={upgradeVisible}
        capability={{ feature: "gpx_export" }}
        currentTier={tier ?? "free"}
        message={translate("GPX export is a Pro feature.")}
        onClose={() => setUpgradeVisible(false)}
      />
    </Card>
  );
}

// US-16 AC #4: surface the voice-navigation preferences. The toggle
// is the master switch, language picks the spoken voice (auto follows
// the device locale), volume is a coarse 4-step picker (0/33/66/100%
// — a slider would need an extra native dep), and the verbose toggle
// flips the rider-friendly "in 300 m, turn left onto Hlavní" against
// the concise "turn left now" phrasing for riders who prefer minimal
// chatter. Display units stay visible even when voice is disabled because
// they also control every formatter-backed screen and vehicle surface.
function VoiceNavigationCard() {
  const format = useFormat();
  const translate = useTranslation();
  const user = useAuthStore((s) => s.user);
  const applyProfileUpdate = useAuthStore((s) => s.applyProfileUpdate);
  const enabled = usePreferencesStore((s) => s.voiceNavEnabled);
  const setEnabled = usePreferencesStore((s) => s.setVoiceNavEnabled);
  const volume = usePreferencesStore((s) => s.voiceNavVolume);
  const setVolume = usePreferencesStore((s) => s.setVoiceNavVolume);
  const language = usePreferencesStore((s) => s.voiceNavLanguage);
  const setLanguage = usePreferencesStore((s) => s.setVoiceNavLanguage);
  const verbose = usePreferencesStore((s) => s.voiceNavVerbose);
  const setVerbose = usePreferencesStore((s) => s.setVoiceNavVerbose);
  const distanceUnit = usePreferencesStore((s) => s.distanceUnit);
  const setDistanceUnit = usePreferencesStore((s) => s.setDistanceUnit);
  const [unitPending, setUnitPending] = useState(false);
  const [unitError, setUnitError] = useState<string | null>(null);

  const handleDistanceUnitChange = useCallback(
    async (next: DistanceUnitPref) => {
      if (unitPending || next === distanceUnit) return;
      const previous = distanceUnit;
      setDistanceUnit(next);
      if (!user) return;

      setUnitPending(true);
      setUnitError(null);
      try {
        const updated = await api.updateProfile({
          preferences: { units: next },
        });
        applyProfileUpdate(updated);
      } catch {
        setDistanceUnit(previous);
        setUnitError(translate("Couldn't update preference."));
      } finally {
        setUnitPending(false);
      }
    },
    [
      distanceUnit,
      setDistanceUnit,
      applyProfileUpdate,
      unitPending,
      user,
      translate,
    ],
  );

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon name="volume-high" size={22} color={enabled ? t.accent : t.fg} />
        <Text style={styles.sectionTitle}>{translate("Voice navigation")}</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleBody}>
          <Text style={styles.toggleLabel}>
            {translate("Speak turn-by-turn cues")}
          </Text>
          <Text style={styles.sectionBody}>
            {translate(
              "Read maneuvers aloud through the helmet headset, with motorcycle-friendly early warnings about {distance} before each turn.",
              { distance: format.distanceM(300) },
            )}
          </Text>
        </View>
        <Toggle
          on={enabled}
          onToggle={setEnabled}
          accessibilityLabel={translate("Enable voice navigation")}
        />
      </View>

      {enabled ? (
        <>
          <View style={styles.toggleRow}>
            <View style={styles.toggleBody}>
              <Text style={styles.toggleLabel}>
                {translate("Verbose phrasing")}
              </Text>
              <Text style={styles.sectionBody}>
                {translate(
                  'Off speaks just the imperative ("Turn left now"); on adds the upcoming road name and stay-left/right hints on sharp turns.',
                )}
              </Text>
            </View>
            <Toggle
              on={verbose}
              onToggle={setVerbose}
              accessibilityLabel={translate(
                "Toggle verbose voice navigation phrasing",
              )}
            />
          </View>

          <View style={styles.toggleBody}>
            <Text style={styles.toggleLabel}>{translate("Volume")}</Text>
            <SegmentedRow
              options={VOICE_VOLUME_OPTIONS.map((option) => ({
                ...option,
                label: translate(option.label),
              }))}
              value={volumeBucket(volume)}
              onChange={(bucket) => setVolume(VOLUME_BY_BUCKET[bucket])}
              ariaLabel={translate("Voice navigation volume")}
            />
          </View>

          <View style={styles.toggleBody}>
            <Text style={styles.toggleLabel}>
              {translate("Spoken language")}
            </Text>
            <SegmentedRow
              options={VOICE_LANGUAGE_OPTIONS.map((option) => ({
                ...option,
                label: translate(option.label),
              }))}
              value={language}
              onChange={(v) => setLanguage(v as VoiceNavLanguage)}
              ariaLabel={translate("Voice navigation language")}
            />
          </View>
        </>
      ) : null}

      <View style={styles.toggleBody}>
        <Text style={styles.toggleLabel}>{translate("Distance units")}</Text>
        <SegmentedRow
          options={DISTANCE_UNIT_OPTIONS.map((option) => ({
            ...option,
            label: translate(option.label),
          }))}
          value={distanceUnit}
          onChange={(v) => void handleDistanceUnitChange(v)}
          ariaLabel={translate("Distance units")}
        />
        {unitPending ? (
          <ActivityIndicator color={t.accent} size="small" />
        ) : null}
        {unitError ? <Text style={styles.errorText}>{unitError}</Text> : null}
      </View>
    </Card>
  );
}

type VolumeBucket = "off" | "low" | "med" | "high";

const VOLUME_BY_BUCKET: Record<VolumeBucket, number> = {
  off: 0,
  low: 0.33,
  med: 0.66,
  high: 1,
};

const VOICE_VOLUME_OPTIONS: ReadonlyArray<{
  value: VolumeBucket;
  label: EnglishMessageKey;
}> = [
  { value: "off", label: "Mute" },
  { value: "low", label: "Low" },
  { value: "med", label: "Med" },
  { value: "high", label: "Full" },
];

const VOICE_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: VoiceNavLanguage;
  label: EnglishMessageKey;
}> = [
  { value: "auto", label: "Auto" },
  { value: "en", label: "EN" },
  { value: "cs", label: "CS" },
  { value: "sk", label: "SK" },
  { value: "de", label: "DE" },
];

const DISTANCE_UNIT_OPTIONS: ReadonlyArray<{
  value: DistanceUnitPref;
  label: EnglishMessageKey;
}> = [
  { value: "metric", label: "Metric" },
  { value: "imperial", label: "Imperial" },
];

/**
 * Map a stored voice volume (0..1) to the closest discrete bucket.
 * The persisted value is the source of truth; this only affects which
 * pill renders highlighted.
 */
function volumeBucket(volume: number): VolumeBucket {
  if (volume <= 0.05) return "off";
  if (volume <= 0.5) return "low";
  if (volume <= 0.85) return "med";
  return "high";
}

/**
 * Single-row pill segmented control. Generic over the value type so the
 * volume / language / distance-unit pickers all share styling and
 * a11y treatment without each rolling its own JSX.
 */
function SegmentedRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <View style={styles.segmentRow} accessibilityLabel={ariaLabel}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.segmentPill,
              selected ? styles.segmentPillSelected : null,
            ]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.label}
          >
            <Text
              style={[
                styles.segmentLabel,
                selected ? styles.segmentLabelSelected : null,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// US-12 AC #5: surface the crash-detection toggle and a CTA into the
// emergency-contacts screen. Toggle persists via PATCH /users/me so the
// rider's preference is durable across devices.
function SafetyCard() {
  const translate = useTranslation();
  const navigation = useNavigation<SettingsNav>();
  const user = useAuthStore((s) => s.user);
  const applyProfileUpdate = useAuthStore((s) => s.applyProfileUpdate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to false when the user hasn't been hydrated yet — the toggle
  // is disabled in that case so we never PATCH a pref against a missing
  // user.
  const enabled = user?.preferences?.crash_detection ?? false;

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!user) return;
      setPending(true);
      setError(null);
      try {
        const updated = await api.updateProfile({
          preferences: { crash_detection: next },
        });
        applyProfileUpdate(updated);
      } catch (err) {
        setError(
          getUserFacingErrorMessage(
            err,
            translate("Couldn't update preference."),
          ),
        );
      } finally {
        setPending(false);
      }
    },
    [user, applyProfileUpdate, translate],
  );

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon
          name="shield-alert-outline"
          size={22}
          color={enabled ? t.accent : t.fg}
        />
        <Text style={styles.sectionTitle}>{translate("Safety")}</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.toggleLabel}>{translate("Crash detection")}</Text>
          <Text style={styles.sectionBody}>
            {translate(
              "Tarmoto will fire a {seconds, plural, one {#-second countdown} other {#-second countdown}} if it detects a hard impact and call your emergency contacts if you don't cancel.",
              { seconds: 30 },
            )}
          </Text>
        </View>
        <Toggle
          on={enabled}
          onToggle={(v) => void handleToggle(v)}
          disabled={pending || !user}
          accessibilityLabel={translate("Enable crash detection")}
        />
      </View>

      {pending ? <ActivityIndicator color={t.accent} size="small" /> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <TouchableOpacity
        style={styles.linkRow}
        onPress={() => navigation.navigate("EmergencyContacts")}
        accessibilityRole="button"
        accessibilityLabel={translate("Manage emergency contacts")}
      >
        <Icon name="account-multiple-outline" size={20} color={t.accent} />
        <Text style={styles.linkLabel}>{translate("Emergency contacts")}</Text>
        <Icon
          name="chevron-right"
          size={20}
          color={t.faint}
          style={styles.chevron}
        />
      </TouchableOpacity>
    </Card>
  );
}

// US-18 AC #1: surface the offline region manager from Settings. Keeping
// it here (vs a standalone tab) mirrors how iOS/Android apps expose
// "offline content" — Settings is where riders look for storage-shaped
// features. The screen itself lives at ProfileStack/OfflineRegions.
function OfflineRegionsCard() {
  const translate = useTranslation();
  const navigation = useNavigation<SettingsNav>();
  const regions = useOfflineStore((s) => s.regions);
  const downloading = regions.filter((r) => r.status === "downloading").length;
  const ready = regions.filter((r) => r.status === "complete").length;

  const summary =
    regions.length === 0
      ? translate(
          "Save map areas so the road-quality overlay keeps working without cell service.",
        )
      : downloading > 0
        ? translate(
            "{count, plural, one {# region} other {# regions}} downloading now.",
            { count: downloading },
          )
        : translate(
            "{ready} of {count, plural, one {# region} other {# regions}} ready offline.",
            { ready, count: regions.length },
          );

  return (
    <TouchableOpacity
      onPress={() => navigation.navigate("OfflineRegions")}
      accessibilityRole="button"
      accessibilityLabel={translate("Manage offline map regions")}
    >
      <Card raised pad={brandSpacing.s4} style={styles.card}>
        <View style={styles.uploadsHeader}>
          <Icon
            name="map-outline"
            size={22}
            color={downloading > 0 ? t.accent : t.fg}
          />
          <Text style={styles.sectionTitle}>{translate("Offline maps")}</Text>
          <Icon
            name="chevron-right"
            size={20}
            color={t.faint}
            style={styles.chevron}
          />
        </View>
        <Text style={styles.sectionBody}>{summary}</Text>
      </Card>
    </TouchableOpacity>
  );
}

// US-18 AC #4: surface the offline sensor-upload backlog so riders can
// see contributions queued from offline rides and trigger a manual retry
// without having to finish another ride just to flush the queue.
function PendingUploadsCard() {
  const translate = useTranslation();
  const { count, isRetrying, lastFlushed, retry } = usePendingUploads();

  const hasPending = count > 0;
  const description = hasPending
    ? translate(
        "{count, plural, one {# ride} other {# rides}} waiting to upload. We'll retry automatically next time you finish a ride.",
        { count },
      )
    : translate(
        "All your sensor contributions are synced to the Tarmoto community.",
      );

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon
          name={hasPending ? "cloud-upload-outline" : "cloud-check-outline"}
          size={22}
          color={hasPending ? WARNING : SUCCESS}
        />
        <Text style={styles.sectionTitle}>{translate("Offline uploads")}</Text>
      </View>
      <Text style={styles.sectionBody}>{description}</Text>

      {hasPending ? (
        <TouchableOpacity
          onPress={retry}
          disabled={isRetrying}
          style={[styles.retryBtn, isRetrying ? styles.retryBtnDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel={translate("Retry pending sensor uploads")}
          accessibilityState={{ disabled: isRetrying }}
        >
          {isRetrying ? (
            <ActivityIndicator color="#0E0E10" size="small" />
          ) : (
            <Text style={styles.retryBtnLabel}>{translate("Retry now")}</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {!isRetrying && lastFlushed !== null && lastFlushed > 0 && !hasPending ? (
        <Text style={styles.retrySuccess}>
          {translate(
            "Uploaded {count, plural, one {# pending ride} other {# pending rides}}.",
            { count: lastFlushed },
          )}
        </Text>
      ) : null}
    </Card>
  );
}

// US-4 follow-up: parallel surface to PendingUploadsCard, but for the
// hazard-report queue. Riders can submit hazards offline (tunnels,
// passes, dead-zones) and this is where they see the backlog and
// trigger a manual drain when they're back on a good network.
function PendingHazardReportsCard() {
  const translate = useTranslation();
  const { count, isRetrying, lastResult, retry } = usePendingHazardReports();
  // Operator `hazard_reporting` kill switch — hide the manual "Retry now" drain
  // (the hook also refuses to drain) so a rider can't push queued reports while
  // reporting is disabled during an abuse wave.
  const reportingEnabled = useFeatureKillSwitchActive("hazard_reporting");

  const hasPending = count > 0;
  const description = hasPending
    ? translate(
        "{count, plural, one {# hazard report} other {# hazard reports}} waiting to upload. We'll retry automatically next time you submit a report.",
        { count },
      )
    : translate("All your hazard reports are synced to the Tarmoto community.");

  const resultMessage = formatHazardRetryResult(
    lastResult,
    isRetrying,
    translate,
  );

  return (
    <Card raised pad={brandSpacing.s4} style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon
          name={hasPending ? "alert-outline" : "shield-check-outline"}
          size={22}
          color={hasPending ? WARNING : SUCCESS}
        />
        <Text style={styles.sectionTitle}>{translate("Hazard reports")}</Text>
      </View>
      <Text style={styles.sectionBody}>{description}</Text>

      {hasPending && reportingEnabled ? (
        <TouchableOpacity
          onPress={retry}
          disabled={isRetrying}
          style={[styles.retryBtn, isRetrying ? styles.retryBtnDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel={translate("Retry pending hazard reports")}
          accessibilityState={{ disabled: isRetrying }}
        >
          {isRetrying ? (
            <ActivityIndicator color="#0E0E10" size="small" />
          ) : (
            <Text style={styles.retryBtnLabel}>{translate("Retry now")}</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {resultMessage ? (
        <Text
          style={
            resultMessage.tone === "success"
              ? styles.retrySuccess
              : styles.retryWarning
          }
        >
          {resultMessage.text}
        </Text>
      ) : null}
    </Card>
  );
}

interface HazardRetryToast {
  text: string;
  tone: "success" | "warning";
}

// Builds a complete, independently translatable outcome message from a
// drain result. Returns null when there's nothing to show (no retry yet
// or one is in flight). Exported for direct unit testing — keeps the
// branching logic out of the JSX.
export function formatHazardRetryResult(
  lastResult: {
    flushed: number;
    failed: number;
    remaining: number;
    capReached: boolean;
  } | null,
  isRetrying: boolean,
  translate: Translate,
): HazardRetryToast | null {
  if (isRetrying || lastResult === null) return null;
  const { flushed, failed, remaining, capReached } = lastResult;
  if (flushed === 0 && failed === 0 && remaining === 0) return null;

  const values = { flushed, failed, remaining };

  // The drain stopped on the rolling `hazard_reports_per_day` cap — surface the
  // same daily-limit explanation the report screen shows so the rider knows
  // it's a rate limit that clears with time, not a connectivity failure they
  // should keep hammering "Retry now" against.
  if (capReached) {
    const text =
      flushed > 0
        ? translate(
            "Uploaded {flushed, plural, one {# report} other {# reports}} · daily limit reached. {remaining, plural, one {# report} other {# reports}} will retry later.",
            values,
          )
        : translate(
            "You've reached today's hazard-report limit. {remaining, plural, one {# report} other {# reports}} will retry later.",
            values,
          );
    return { text, tone: "warning" };
  }

  let text: string;
  if (flushed > 0 && failed > 0 && remaining > 0) {
    text = translate(
      "Uploaded {flushed, plural, one {# report} other {# reports}} · {failed} failed · {remaining} still queued.",
      values,
    );
  } else if (flushed > 0 && failed > 0) {
    text = translate(
      "Uploaded {flushed, plural, one {# report} other {# reports}} · {failed} failed.",
      values,
    );
  } else if (flushed > 0 && remaining > 0) {
    text = translate(
      "Uploaded {flushed, plural, one {# report} other {# reports}} · {remaining} still queued.",
      values,
    );
  } else if (failed > 0 && remaining > 0) {
    text = translate("{failed} failed · {remaining} still queued.", values);
  } else if (flushed > 0) {
    text = translate(
      "Uploaded {flushed, plural, one {# report} other {# reports}}.",
      values,
    );
  } else if (failed > 0) {
    text = translate("{failed} failed.", values);
  } else {
    text = translate("{remaining} still queued.", values);
  }
  // Pure-failure / pure-stuck outcomes get a warning tone; anything
  // with a successful flush leans on success styling because the rider
  // actually moved their backlog forward.
  const tone: "success" | "warning" =
    flushed > 0 && failed === 0 && remaining === 0 ? "success" : "warning";
  return { text, tone };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s8,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  card: {
    gap: brandSpacing.s3,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  sectionBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  uploadsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  chevron: {
    marginLeft: "auto",
  },
  retryBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: brandSpacing.s5,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.accent,
    minWidth: 120,
    alignItems: "center",
  },
  retryBtnDisabled: {
    opacity: 0.7,
  },
  retryBtnLabel: {
    color: "#0E0E10",
    fontFamily: brandFonts.sans,
    fontWeight: "800",
    fontSize: 14,
  },
  retrySuccess: {
    color: SUCCESS,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  retryWarning: {
    color: WARNING,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  toggleBody: {
    flex: 1,
    gap: brandSpacing.s1,
  },
  toggleLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: {
    color: DANGER,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s2,
  },
  linkLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  exportRow: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  exportBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s1,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
    backgroundColor: t.raised,
  },
  exportBtnLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s1,
    marginTop: brandSpacing.s1,
  },
  segmentPill: {
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised,
  },
  segmentPillSelected: {
    borderColor: t.accent,
    backgroundColor: t.accent,
  },
  segmentLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  segmentLabelSelected: {
    color: "#0E0E10",
  },
});
