/**
 * TripCreateScreen — US-7 input form for the auto-generated multi-day route.
 *
 * Collects the trip parameters (title, days, daily distance range, road
 * preference, min quality) and kicks off the two-step backend dance:
 *
 *   1. POST /trips           — reserves the trip draft
 *   2. POST /trips/:id/generate — runs the solver to populate day routes
 *
 * On success the screen navigates to TripDetail with the new tripId.
 * We deliberately fail loudly on step 2: if the solver errored, we don't
 * leave the user staring at a half-empty draft in the trips list — they
 * get a clear error banner and can retry with different parameters.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "@/components/Icon";
import { qualityLabel } from "@/theme";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import QualityThresholdSlider from "@/components/QualityThresholdSlider";
import { ApiError, api } from "@/services/api";
import { pickAndParseRoute, routeToImportRequest } from "@/services/tripImport";
import { useMapStore, usePreferencesStore, useRideStore } from "@/stores";
import { refreshEntitlementsNow } from "@/services/entitlementsRefresh";
import { useEntitlements } from "@/hooks/useEntitlements";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import { reconcileTripDraftCleanup } from "@/services/tripDraftCleanup";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import type { LatLng } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";
import {
  DAILY_KM_PRESETS,
  DAY_OPTIONS,
  ROAD_PREFERENCES,
  bboxAroundPoint,
  type DailyKmPreset,
  type RoadPreferenceValue,
} from "./TripScreens.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";

/**
 * #M3 reactive safety net — narrows a `POST /trips`,
 * `/trips/:id/generate`, or `/trips/import` failure down to the
 * `max_active_trips` cap rejection (backend `featureLimitExceeded`),
 * so a revoke between the TripsScreen proactive gate and this request
 * landing still surfaces the upsell instead of the generic error
 * banner. Reads the resolved limit straight off the error body rather
 * than the local entitlement snapshot, since a stale snapshot is
 * exactly the case this net exists to cover.
 */
function parseActiveTripsLimitExceeded(err: unknown): { limit: number } | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  const body = err.body;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.code !== FEATURE_LIMIT_EXCEEDED) return null;
  return { limit: typeof record.limit === "number" ? record.limit : 0 };
}

type Nav = NativeStackNavigationProp<TripsStackParamList, "TripCreate">;

const t = brandColorsLight;

export default function TripCreateScreen() {
  const format = useFormat();
  const translate = useTranslation();
  const navigation = useNavigation<Nav>();
  const defaultMinQuality = usePreferencesStore((s) => s.minQuality);
  // Start location: prefer a fresh GPS fix from an ongoing ride, fall back
  // to the last map camera center so the generator always has somewhere
  // to anchor its search. See bboxAroundPoint() for how days scale this.
  const rideLocation = useRideStore((s) => s.location);
  const mapCenter = useMapStore((s) => s.center);
  const startLocation: LatLng = useMemo(() => {
    if (rideLocation) return { lat: rideLocation.lat, lng: rideLocation.lng };
    return mapCenter;
  }, [rideLocation, mapCenter]);
  const startIsLive = rideLocation !== null;

  const [title, setTitleRaw] = useState("");
  const [region, setRegionRaw] = useState("");
  const [numDays, setNumDaysRaw] = useState<number>(3);
  const [dailyKm, setDailyKmRaw] = useState<DailyKmPreset>(DAILY_KM_PRESETS[1]);
  const [roadPref, setRoadPrefRaw] = useState<RoadPreferenceValue>("curvy");

  // Keep the override logic from the original screen: null means "use the
  // rider's current default", so toggling the Settings default while this
  // screen is mounted doesn't spuriously flip the trip into an override.
  const [minQualityOverride, setMinQualityOverrideRaw] = useState<
    number | null
  >(null);
  const tripMinQuality = minQualityOverride ?? defaultMinQuality;
  const overridesDefault = minQualityOverride !== null;

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Operator kill switch (`gpx_import`, fail-SAFE off /config/flags): disabled
  // during a parser-vulnerability incident. Hides the Import GPX/KML button;
  // handleImport re-reads it synchronously (parse-time + pre-POST) as
  // belt-and-braces.
  const gpxImportEnabled = useFeatureKillSwitchActive("gpx_import");

  // Operator kill switch (`trip_planning`): this is a planner destination
  // screen (reachable directly, not only via the guarded TripsScreen FAB), so
  // close it on a kill and guard the generate action too — otherwise a rider
  // already here when the operator disables the planner could still createTrip.
  const tripPlanningEnabled = useFeatureKillSwitchActive("trip_planning");
  useEffect(() => {
    if (!tripPlanningEnabled) navigation.goBack();
  }, [tripPlanningEnabled, navigation]);

  // #M3 reactive safety net — see `parseActiveTripsLimitExceeded` above.
  const { tier } = useEntitlements();
  const [limitPromptVisible, setLimitPromptVisible] = useState(false);
  const [limitPromptResolvedLimit, setLimitPromptResolvedLimit] = useState<
    number | null
  >(null);

  // If `createTrip` succeeded but `generateTripRoute` failed, we hold onto
  // the draft id and retry generation against the same draft instead of
  // creating another. Any parameter change invalidates the draft (its
  // server-side fields are now stale) so the next Generate starts fresh.
  const [draftTripId, setDraftTripId] = useState<string | null>(null);
  // Refs that handleGenerate reads across await points: `submittingRef`
  // lets setters detect an in-flight submit even before a re-render has
  // propagated the `submitting` state, and `dirtySinceSubmitRef` records
  // whether the user edited a param between `createTrip` firing and it
  // resolving. If they did, we skip caching the returned draft id so a
  // retry can't reuse a draft whose server-side params no longer match
  // the form — closes the race the bugbot flagged.
  const submittingRef = useRef(false);
  const dirtySinceSubmitRef = useRef(false);
  // Synchronous re-entrancy guard for the import flow: state-based
  // guards (`importing`) only flip on the next render, so two same-
  // frame taps both pass the guard and we end up with a duplicate
  // picker open / a duplicate `POST /trips/import` against the same
  // file. Mirrors the `submittingRef` pattern used by the generate
  // path below.
  const importingRef = useRef(false);
  const invalidateDraft = useCallback(() => {
    if (submittingRef.current) dirtySinceSubmitRef.current = true;
    setDraftTripId(null);
  }, []);

  const setTitle = useCallback(
    (v: string) => {
      setTitleRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );
  const setRegion = useCallback(
    (v: string) => {
      setRegionRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );
  const setNumDays = useCallback(
    (v: number) => {
      setNumDaysRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );
  const setDailyKm = useCallback(
    (v: DailyKmPreset) => {
      setDailyKmRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );
  const setRoadPref = useCallback(
    (v: RoadPreferenceValue) => {
      setRoadPrefRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );
  const setMinQualityOverride = useCallback(
    (v: number | null) => {
      setMinQualityOverrideRaw(v);
      invalidateDraft();
    },
    [invalidateDraft],
  );

  const trimmedTitle = title.trim();
  // Block Generate while an import is mid-flight: the picker call is
  // suspended on a native promise that we can't cancel, and Generate
  // would otherwise navigate the user to a freshly-created trip while
  // the still-running import completes and tries to navigate to a
  // different trip.
  const canSubmit = trimmedTitle.length > 0 && !submitting && !importing;

  const handleQualityChange = useCallback(
    (value: number) => {
      setMinQualityOverride(value === defaultMinQuality ? null : value);
    },
    [defaultMinQuality],
  );

  const handleImport = useCallback(async () => {
    // Two synchronous guards: the ref bails on a same-frame double-tap
    // before React has flushed `setImporting(true)`, and `submittingRef`
    // blocks parallel runs while the Generate flow is mid-flight (both
    // would otherwise race on the picker / network / navigation).
    if (importingRef.current || submittingRef.current) return;
    // Belt-and-braces: the button is hidden when killed, but re-read the switch
    // synchronously so a race (kill lands between render and tap) can't still
    // open the picker / POST /trips/import during a parser-vuln incident.
    if (!isFeatureKillSwitchActive("gpx_import")) return;
    importingRef.current = true;
    setImporting(true);
    setErrorMessage(null);
    try {
      const outcome = await pickAndParseRoute();
      if (!outcome.ok) {
        if (outcome.cancelled) return;
        setErrorMessage(outcome.error);
        Alert.alert(translate("Couldn't import file"), outcome.error);
        return;
      }
      // Final recheck before the POST — either switch can flip off during the
      // (also-async) picker. `gpx_import` gates the import path; `trip_planning`
      // gates the planner as a whole and importing also CREATES a trip, so both
      // must still be live before `POST /trips/import`.
      if (!isFeatureKillSwitchActive("gpx_import")) return;
      if (!isFeatureKillSwitchActive("trip_planning")) return;
      const requestTitle = trimmedTitle || outcome.route.name;
      const request = routeToImportRequest(
        outcome.route,
        requestTitle,
        region.trim() || undefined,
      );
      const trip = await api.importTripFromRoute(request);
      // Replace, not push: the user just consumed the create form, so
      // back from TripDetail should go to the trips list rather than
      // back to a half-filled form they have no reason to revisit.
      navigation.replace("TripDetail", { tripId: trip.id });
    } catch (err) {
      const limitError = parseActiveTripsLimitExceeded(err);
      if (limitError) {
        setLimitPromptResolvedLimit(limitError.limit);
        // The 403 can mean the account was downgraded while our entitlement
        // snapshot is stale. Refresh the tier FIRST so the prompt derives its
        // upgrade target from the CURRENT tier (else a Pro→Free downgrade shows
        // neutral copy against the cached Pro tier and hides a valid upgrade).
        // Only open the prompt if the refresh SUCCEEDED — a failed refresh would
        // reproduce that stale-tier dead-end, so surface a retryable error.
        const refreshed = await refreshEntitlementsNow();
        if (refreshed) {
          setLimitPromptVisible(true);
        } else {
          const message = translate(
            "Couldn't verify your plan. Check your connection and try again.",
          );
          setErrorMessage(message);
          Alert.alert(translate("Import failed"), message);
        }
      } else {
        const message = getUserFacingErrorMessage(
          err,
          translate("Unable to import route"),
        );
        setErrorMessage(message);
        Alert.alert(translate("Import failed"), message);
      }
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [trimmedTitle, region, navigation, translate]);

  const handleGenerate = useCallback(async () => {
    // Re-entrancy guard: a rapid double-tap can fire this callback twice
    // before React re-renders with `submitting=true`, so both closures
    // would see `canSubmit=true` and hit `api.createTrip` — producing
    // duplicate drafts on the server. The ref flips synchronously so the
    // second call bails before any network I/O.
    if (submittingRef.current || importingRef.current) return;
    // Planner killed while the form was open — bail before any createTrip /
    // generateTripRoute I/O and close the screen.
    if (!isFeatureKillSwitchActive("trip_planning")) {
      navigation.goBack();
      return;
    }
    if (!canSubmit) return;
    submittingRef.current = true;
    dirtySinceSubmitRef.current = false;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      // Reuse an existing draft from a previous failed attempt so retries
      // don't accumulate orphaned drafts in the rider's trips list. The
      // parameter setters above clear `draftTripId` whenever the user
      // edits a field, so a stale draft can't outlive the values it was
      // created with.
      let tripId = draftTripId;
      if (!tripId) {
        const trip = await api.createTrip({
          title: trimmedTitle,
          num_days: numDays,
          ...(region.trim() ? { region: region.trim() } : {}),
          min_quality: tripMinQuality,
          road_preference: roadPref,
          daily_km_min: dailyKm.min,
          daily_km_max: dailyKm.max,
        });
        tripId = trip.id;
        // Only cache the id for reuse if the parameters we just submitted
        // are still current. If the user edited mid-flight this request's
        // draft becomes single-use — the next Generate will create a new
        // one that matches the new form state.
        if (!dirtySinceSubmitRef.current) {
          setDraftTripId(tripId);
        }
      }
      // Recheck before the second write: `createTrip` may have completed and
      // the operator may have killed the planner while it was in flight — don't
      // kick off route generation on top of a now-disabled planner. The draft
      // trip is already persisted, and `draftTripId` is component-local (lost
      // when we pop the screen below), so it can't be reused — clean it up so
      // it doesn't orphan in the trips list and consume a `max_active_trips`
      // slot. Route the delete through the reconciler: if it fails for the same
      // outage that killed the planner, the id PERSISTS and a foreground drain
      // (`tripDraftCleanupMonitor`) retries it, since there's no delete-trip UI
      // for the rider to recover it manually.
      if (!isFeatureKillSwitchActive("trip_planning")) {
        setDraftTripId(null);
        void reconcileTripDraftCleanup(tripId);
        navigation.goBack();
        return;
      }
      const bbox = bboxAroundPoint(
        startLocation.lat,
        startLocation.lng,
        numDays,
      );
      await api.generateTripRoute(tripId, startLocation, { bbox });
      // Replace rather than push: the detail screen for this trip should
      // be the back target from Day screens, not a half-filled create form.
      navigation.replace("TripDetail", { tripId });
    } catch (err) {
      const limitError = parseActiveTripsLimitExceeded(err);
      if (limitError) {
        setLimitPromptResolvedLimit(limitError.limit);
        // The 403 can mean the account was downgraded while our entitlement
        // snapshot is stale. Refresh the tier FIRST so the prompt derives its
        // upgrade target from the CURRENT tier (else a Pro→Free downgrade shows
        // neutral copy against the cached Pro tier and hides a valid upgrade).
        // Only open the prompt if the refresh SUCCEEDED — a failed refresh would
        // reproduce that stale-tier dead-end, so surface a retryable error.
        const refreshed = await refreshEntitlementsNow();
        if (refreshed) {
          setLimitPromptVisible(true);
        } else {
          const message = translate(
            "Couldn't verify your plan. Check your connection and try again.",
          );
          setErrorMessage(message);
          Alert.alert(translate("Generation failed"), message);
        }
      } else {
        const message = getUserFacingErrorMessage(
          err,
          translate("Unable to generate trip"),
        );
        setErrorMessage(message);
        // Also pop an alert so the user can't miss it behind the keyboard.
        Alert.alert(translate("Generation failed"), message);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    canSubmit,
    draftTripId,
    trimmedTitle,
    numDays,
    region,
    tripMinQuality,
    roadPref,
    dailyKm,
    startLocation,
    navigation,
    translate,
  ]);

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
        <Text style={styles.title}>{translate("New trip")}</Text>
        <Text style={styles.subtitle}>
          {translate(
            "We'll auto-generate a multi-day route that favours the roads you care about.",
          )}
        </Text>

        {gpxImportEnabled ? (
          <TouchableOpacity
            style={[
              styles.importBtn,
              (importing || submitting) && styles.importBtnDisabled,
            ]}
            onPress={() => void handleImport()}
            disabled={importing || submitting}
            accessibilityRole="button"
            accessibilityLabel={translate("Import GPX or KML file")}
            accessibilityState={{ busy: importing }}
          >
            {importing ? (
              <ActivityIndicator color={t.fg} />
            ) : (
              <>
                <Icon name="file-upload-outline" size={20} color={t.fg} />
                <Text style={styles.importLabel}>
                  {translate("Import GPX/KML")}
                </Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{translate("Title")}</Text>
          <TextInput
            style={styles.input}
            placeholder={translate("e.g. Beskydy weekend")}
            placeholderTextColor={t.mute}
            value={title}
            onChangeText={setTitle}
            maxLength={80}
            returnKeyType="next"
          />

          <Text style={[styles.sectionTitle, styles.sectionSpacing]}>
            {translate("Region (optional)")}
          </Text>
          <TextInput
            style={styles.input}
            placeholder={translate("e.g. Moravia")}
            placeholderTextColor={t.mute}
            value={region}
            onChangeText={setRegion}
            maxLength={60}
            returnKeyType="done"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{translate("Days")}</Text>
          <Text style={styles.sectionBody}>
            {translate("How many riding days in this trip?")}
          </Text>
          <View style={styles.pillRow}>
            {DAY_OPTIONS.map((d) => {
              const selected = d === numDays;
              return (
                <TouchableOpacity
                  key={d}
                  style={[styles.pill, selected && styles.pillSelected]}
                  onPress={() => setNumDays(d)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={translate(
                    "{count, plural, one {# day} other {# days}}",
                    { count: d },
                  )}
                >
                  <Text
                    style={[
                      styles.pillText,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {format.number(d, {
                      useGrouping: false,
                      maximumFractionDigits: 0,
                    })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{translate("Daily distance")}</Text>
          <Text style={styles.sectionBody}>
            {translate(
              "Target range per day. The generator balances days around this.",
            )}
          </Text>
          <View style={styles.stackRow}>
            {DAILY_KM_PRESETS.map((preset) => {
              const selected = preset.label === dailyKm.label;
              const presetLabel = translate(preset.label);
              const minDistance = format.distanceKm(preset.min);
              const maxDistance = format.distanceKm(preset.max);
              return (
                <TouchableOpacity
                  key={preset.label}
                  style={[
                    styles.stackPill,
                    selected && styles.stackPillSelected,
                  ]}
                  onPress={() => setDailyKm(preset)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={translate(
                    "{label}, {min} to {max} per day",
                    {
                      label: presetLabel,
                      min: minDistance,
                      max: maxDistance,
                    },
                  )}
                >
                  <Text
                    style={[
                      styles.stackPillTitle,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {presetLabel}
                  </Text>
                  <Text
                    style={[
                      styles.stackPillMeta,
                      selected && styles.stackPillMetaSelected,
                    ]}
                  >
                    {translate("{min}–{max} per day", {
                      min: minDistance,
                      max: maxDistance,
                    })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {translate("Road preference")}
          </Text>
          <Text style={styles.sectionBody}>
            {translate("Shapes how the generator picks between speed and fun.")}
          </Text>
          <View style={styles.pillRow}>
            {ROAD_PREFERENCES.map((pref) => {
              const selected = pref.value === roadPref;
              const preferenceLabel = translate(pref.label);
              return (
                <TouchableOpacity
                  key={pref.value}
                  style={[styles.wideFlexPill, selected && styles.pillSelected]}
                  onPress={() => setRoadPref(pref.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={preferenceLabel}
                >
                  <Text
                    style={[
                      styles.pillText,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {preferenceLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {translate("Road quality for this trip")}
          </Text>
          <Text style={styles.sectionBody}>
            {translate(
              "The planner will prefer roads at or above this quality. Segments below it show dimmed so you still see them as fallbacks.",
            )}
          </Text>
          <QualityThresholdSlider
            value={tripMinQuality}
            onChange={handleQualityChange}
            label={translate("Minimum quality")}
            helpText={
              overridesDefault
                ? translate("Overrides your default of {quality}.", {
                    quality: qualityLabel(defaultMinQuality),
                  })
                : translate("Using your default ({quality}).", {
                    quality: qualityLabel(defaultMinQuality),
                  })
            }
          />
          {overridesDefault ? (
            <TouchableOpacity
              onPress={() => setMinQualityOverride(null)}
              style={styles.resetRow}
              accessibilityRole="button"
            >
              <Text style={styles.resetLabel}>
                {translate("Reset to default")}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{translate("Start location")}</Text>
          <View style={styles.startRow}>
            <Icon
              name={startIsLive ? "crosshairs-gps" : "map-marker-outline"}
              size={20}
              color={startIsLive ? ACCENT_DARK : t.dim}
            />
            <Text style={styles.startText}>
              {translate("{location} · {latitude}, {longitude}", {
                location: startIsLive
                  ? translate("Your current location")
                  : translate("Last map location"),
                latitude: format.decimal(startLocation.lat, 3),
                longitude: format.decimal(startLocation.lng, 3),
              })}
            </Text>
          </View>
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle" size={18} color={statusFg.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.generateBtn, !canSubmit && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          accessibilityLabel={translate("Generate trip")}
        >
          {submitting ? (
            <ActivityIndicator color={t.invFg} />
          ) : (
            <>
              <Icon name="auto-fix" size={20} color={t.invFg} />
              <Text style={styles.generateLabel}>
                {translate("Generate trip")}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
      <UpgradePrompt
        visible={limitPromptVisible}
        capability={{
          limit: "max_active_trips",
          resolvedLimit: limitPromptResolvedLimit,
        }}
        currentTier={tier ?? "free"}
        message={translate(
          "Free riders can keep {limit, plural, one {# active trip} other {# active trips}}. Upgrade for more.",
          { limit: limitPromptResolvedLimit ?? 1 },
        )}
        neutralMessage={translate(
          "Your plan allows {limit, plural, one {# active trip} other {# active trips}}.",
          { limit: limitPromptResolvedLimit ?? 1 },
        )}
        onClose={() => setLimitPromptVisible(false)}
      />
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
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    lineHeight: 22,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  sectionSpacing: {
    marginTop: brandSpacing.s2,
  },
  sectionTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  sectionBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  input: {
    backgroundColor: t.sunken,
    borderWidth: 1,
    borderColor: t.line,
    color: t.fg,
    fontFamily: brandFonts.sans,
    borderRadius: brandRadii.sm,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    fontSize: 14,
  },
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
  },
  pill: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
  },
  wideFlexPill: {
    flex: 1,
    minWidth: 72,
    minHeight: 44,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
  },
  pillSelected: {
    backgroundColor: t.invBg,
    borderColor: t.invBg,
  },
  pillText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  pillTextSelected: {
    color: t.invFg,
  },
  stackRow: {
    gap: brandSpacing.s2,
  },
  stackPill: {
    padding: brandSpacing.s3,
    minHeight: 44,
    justifyContent: "center",
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.raised2,
  },
  stackPillSelected: {
    backgroundColor: t.invBg,
    borderColor: t.invBg,
  },
  stackPillTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  stackPillMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    marginTop: 2,
  },
  stackPillMetaSelected: {
    color: t.invFg,
    opacity: 0.85,
  },
  resetRow: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
  },
  resetLabel: {
    color: ACCENT_DARK,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  startRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  startText: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: statusFg.danger,
    backgroundColor: t.raised2,
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  generateBtnDisabled: {
    opacity: 0.5,
  },
  generateLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    borderWidth: 1,
    borderColor: t.lineStrong,
    backgroundColor: t.raised,
  },
  importBtnDisabled: {
    opacity: 0.5,
  },
  importLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
