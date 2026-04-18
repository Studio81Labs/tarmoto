import React from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
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
import FuelRangePicker from "@/components/FuelRangePicker";
import { usePreferencesStore } from "@/stores";
import { usePendingUploads } from "@/hooks";

export default function SettingsScreen() {
  const minQuality = usePreferencesStore((s) => s.minQuality);
  const setMinQuality = usePreferencesStore((s) => s.setMinQuality);
  const fuelRangeKm = usePreferencesStore((s) => s.fuelRangeKm);
  const setFuelRangeKm = usePreferencesStore((s) => s.setFuelRangeKm);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Route quality</Text>
        <Text style={styles.sectionBody}>
          Routes and road segments below your minimum are grayed out so you can
          focus on the roads you actually want to ride.
        </Text>

        <QualityThresholdSlider
          value={minQuality}
          onChange={setMinQuality}
          label="Minimum quality"
          helpText={`Currently showing ${qualityLabel(minQuality)} and above.`}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Fuel range</Text>
        <Text style={styles.sectionBody}>
          How far your bike comfortably goes on a tank. Trip days with a stretch
          longer than this between fuel stops will trigger a warning.
        </Text>

        <FuelRangePicker
          value={fuelRangeKm}
          onChange={setFuelRangeKm}
          label="Fuel range"
          helpText="Tap a distance to match your bike."
        />
      </View>

      <PendingUploadsCard />
    </ScrollView>
  );
}

// US-18 AC #4: surface the offline sensor-upload backlog so riders can
// see contributions queued from offline rides and trigger a manual retry
// without having to finish another ride just to flush the queue.
function PendingUploadsCard() {
  const { count, isRetrying, lastFlushed, retry } = usePendingUploads();

  const hasPending = count > 0;
  const description = hasPending
    ? `${count} ride${count === 1 ? "" : "s"} waiting to upload. We'll retry automatically next time you finish a ride.`
    : "All your sensor contributions are synced to the Tarmoto community.";

  return (
    <View style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon
          name={hasPending ? "cloud-upload-outline" : "cloud-check-outline"}
          size={22}
          color={hasPending ? colors.warning : colors.success}
        />
        <Text style={styles.sectionTitle}>Offline uploads</Text>
      </View>
      <Text style={styles.sectionBody}>{description}</Text>

      {hasPending ? (
        <TouchableOpacity
          onPress={retry}
          disabled={isRetrying}
          style={[styles.retryBtn, isRetrying ? styles.retryBtnDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel="Retry pending sensor uploads"
          accessibilityState={{ disabled: isRetrying }}
        >
          {isRetrying ? (
            <ActivityIndicator color={colors.textInverse} size="small" />
          ) : (
            <Text style={styles.retryBtnLabel}>Retry now</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {!isRetrying && lastFlushed !== null && lastFlushed > 0 && !hasPending ? (
        <Text style={styles.retrySuccess}>
          Uploaded {lastFlushed} pending ride{lastFlushed === 1 ? "" : "s"}.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
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
  uploadsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  retryBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
    minWidth: 120,
    alignItems: "center",
  },
  retryBtnDisabled: {
    opacity: 0.7,
  },
  retryBtnLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  retrySuccess: {
    color: colors.success,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
});
