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

import React, { useCallback, useMemo, useState } from "react";
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
import Icon from "@react-native-vector-icons/material-design-icons";
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  qualityLabel,
  spacing,
} from "@/theme";
import QualityThresholdSlider from "@/components/QualityThresholdSlider";
import { api } from "@/services/api";
import { useMapStore, usePreferencesStore, useRideStore } from "@/stores";
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

type Nav = NativeStackNavigationProp<TripsStackParamList, "TripCreate">;

export default function TripCreateScreen() {
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

  const [title, setTitle] = useState("");
  const [region, setRegion] = useState("");
  const [numDays, setNumDays] = useState<number>(3);
  const [dailyKm, setDailyKm] = useState<DailyKmPreset>(DAILY_KM_PRESETS[1]);
  const [roadPref, setRoadPref] = useState<RoadPreferenceValue>("curvy");

  // Keep the override logic from the original screen: null means "use the
  // rider's current default", so toggling the Settings default while this
  // screen is mounted doesn't spuriously flip the trip into an override.
  const [minQualityOverride, setMinQualityOverride] = useState<number | null>(
    null,
  );
  const tripMinQuality = minQualityOverride ?? defaultMinQuality;
  const overridesDefault = minQualityOverride !== null;

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  const handleQualityChange = useCallback(
    (value: number) => {
      setMinQualityOverride(value === defaultMinQuality ? null : value);
    },
    [defaultMinQuality],
  );

  const handleGenerate = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const trip = await api.createTrip({
        title: trimmedTitle,
        num_days: numDays,
        region: region.trim() || undefined,
        min_quality: tripMinQuality,
        road_preference: roadPref,
        daily_km_min: dailyKm.min,
        daily_km_max: dailyKm.max,
      });
      const bbox = bboxAroundPoint(
        startLocation.lat,
        startLocation.lng,
        numDays,
      );
      await api.generateTripRoute(trip.id, startLocation, bbox);
      // Replace rather than push: the detail screen for this trip should
      // be the back target from Day screens, not a half-filled create form.
      navigation.replace("TripDetail", { tripId: trip.id });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to generate trip";
      setErrorMessage(message);
      // Also pop an alert so the user can't miss it behind the keyboard.
      Alert.alert("Generation failed", message);
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    trimmedTitle,
    numDays,
    region,
    tripMinQuality,
    roadPref,
    dailyKm,
    startLocation,
    navigation,
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
        <Text style={styles.title}>New trip</Text>
        <Text style={styles.subtitle}>
          We'll auto-generate a multi-day route that favours the roads you care
          about.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Title</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Beskydy weekend"
            placeholderTextColor={colors.textTertiary}
            value={title}
            onChangeText={setTitle}
            maxLength={80}
            returnKeyType="next"
          />

          <Text style={[styles.sectionTitle, styles.sectionSpacing]}>
            Region (optional)
          </Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Moravia"
            placeholderTextColor={colors.textTertiary}
            value={region}
            onChangeText={setRegion}
            maxLength={60}
            returnKeyType="done"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Days</Text>
          <Text style={styles.sectionBody}>
            How many riding days in this trip?
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
                  accessibilityLabel={`${d} days`}
                >
                  <Text
                    style={[
                      styles.pillText,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {d}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Daily distance</Text>
          <Text style={styles.sectionBody}>
            Target range per day. The generator balances days around this.
          </Text>
          <View style={styles.stackRow}>
            {DAILY_KM_PRESETS.map((preset) => {
              const selected = preset.label === dailyKm.label;
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
                  accessibilityLabel={`${preset.label}, ${preset.min} to ${preset.max} km`}
                >
                  <Text
                    style={[
                      styles.stackPillTitle,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {preset.label}
                  </Text>
                  <Text
                    style={[
                      styles.stackPillMeta,
                      selected && styles.stackPillMetaSelected,
                    ]}
                  >
                    {preset.min}–{preset.max} km / day
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Road preference</Text>
          <Text style={styles.sectionBody}>
            Shapes how the generator picks between speed and fun.
          </Text>
          <View style={styles.pillRow}>
            {ROAD_PREFERENCES.map((pref) => {
              const selected = pref.value === roadPref;
              return (
                <TouchableOpacity
                  key={pref.value}
                  style={[styles.wideFlexPill, selected && styles.pillSelected]}
                  onPress={() => setRoadPref(pref.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={pref.label}
                >
                  <Text
                    style={[
                      styles.pillText,
                      selected && styles.pillTextSelected,
                    ]}
                  >
                    {pref.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Road quality for this trip</Text>
          <Text style={styles.sectionBody}>
            The planner will prefer roads at or above this quality. Segments
            below it show dimmed so you still see them as fallbacks.
          </Text>
          <QualityThresholdSlider
            value={tripMinQuality}
            onChange={handleQualityChange}
            label="Minimum quality"
            helpText={
              overridesDefault
                ? `Overrides your default of ${qualityLabel(defaultMinQuality)}.`
                : `Using your default (${qualityLabel(defaultMinQuality)}).`
            }
          />
          {overridesDefault ? (
            <TouchableOpacity
              onPress={() => setMinQualityOverride(null)}
              style={styles.resetRow}
              accessibilityRole="button"
            >
              <Text style={styles.resetLabel}>Reset to default</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Start location</Text>
          <View style={styles.startRow}>
            <Icon
              name={startIsLive ? "crosshairs-gps" : "map-marker-outline"}
              size={20}
              color={startIsLive ? colors.primary : colors.textSecondary}
            />
            <Text style={styles.startText}>
              {startIsLive ? "Your current location" : "Last map location"} ·{" "}
              {startLocation.lat.toFixed(3)}, {startLocation.lng.toFixed(3)}
            </Text>
          </View>
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle" size={18} color={colors.danger} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.generateBtn, !canSubmit && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          accessibilityLabel="Generate trip"
        >
          {submitting ? (
            <ActivityIndicator color={colors.textInverse} />
          ) : (
            <>
              <Icon name="auto-fix" size={20} color={colors.textInverse} />
              <Text style={styles.generateLabel}>Generate trip</Text>
            </>
          )}
        </TouchableOpacity>
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
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionSpacing: {
    marginTop: spacing.sm,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  sectionBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  input: {
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
  },
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  pill: {
    minWidth: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  wideFlexPill: {
    flex: 1,
    minWidth: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  pillSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  pillTextSelected: {
    color: colors.textInverse,
  },
  stackRow: {
    gap: spacing.sm,
  },
  stackPill: {
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  stackPillSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stackPillTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  stackPillMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  stackPillMetaSelected: {
    color: colors.textInverse,
    opacity: 0.85,
  },
  resetRow: {
    alignSelf: "flex-start",
  },
  resetLabel: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  startRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  startText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    flex: 1,
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
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  generateBtnDisabled: {
    opacity: 0.5,
  },
  generateLabel: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
});
