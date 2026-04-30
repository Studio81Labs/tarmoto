import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNFS from "react-native-fs";
import RNShare from "react-native-share";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
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
import { useAuthStore, useOfflineStore, usePreferencesStore } from "@/stores";
import { usePendingUploads } from "@/hooks";
import { api } from "@/services/api";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";

type SettingsNav = NativeStackNavigationProp<ProfileStackParamList, "Settings">;

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

      <SafetyCard />

      <OfflineRegionsCard />

      <BulkExportCard />

      <PendingUploadsCard />
    </ScrollView>
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
  const [busy, setBusy] = useState<"gpx" | "csv" | null>(null);
  // Synchronous re-entrancy guard. `busy` only flips on the next
  // render, so two same-frame taps would otherwise both pass the
  // `busy !== null` check and trigger duplicate API calls + share
  // sheets. Mirrors `importingRef` on `TripCreateScreen`.
  const busyRef = useRef(false);

  const handleExport = useCallback(async (format: "gpx" | "csv") => {
    if (busyRef.current) return;
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
            ? "Export all rides as GPX"
            : "Export all rides as CSV",
        // failOnCancel=false: dismissing the sheet is a normal outcome,
        // not an error worth toasting.
        failOnCancel: false,
      });
    } catch (err) {
      Alert.alert(
        "Couldn't export",
        err instanceof Error ? err.message : "Unable to export rides.",
      );
    } finally {
      // Same rationale as the per-ride export: leave the temp file in
      // place so deferred consumers (Mail, Files, third-party importers)
      // can read it lazily. The OS reaps `TemporaryDirectoryPath`.
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  return (
    <View style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon name="export-variant" size={22} color={colors.textPrimary} />
        <Text style={styles.sectionTitle}>Export rides</Text>
      </View>
      <Text style={styles.sectionBody}>
        Download your full ride history as GPX (for Garmin / RideWithGPS) or CSV
        (for spreadsheets).
      </Text>
      <View style={styles.exportRow}>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={() => void handleExport("gpx")}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Export all rides as GPX"
        >
          {busy === "gpx" ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <>
              <Icon name="download-outline" size={18} color={colors.primary} />
              <Text style={styles.exportBtnLabel}>GPX</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={() => void handleExport("csv")}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Export all rides as CSV"
        >
          {busy === "csv" ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <>
              <Icon name="table" size={18} color={colors.primary} />
              <Text style={styles.exportBtnLabel}>CSV</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// US-12 AC #5: surface the crash-detection toggle and a CTA into the
// emergency-contacts screen. Toggle persists via PATCH /users/me so the
// rider's preference is durable across devices.
function SafetyCard() {
  const navigation = useNavigation<SettingsNav>();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
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
          preferences: { ...user.preferences, crash_detection: next },
        });
        setUser(updated);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Couldn't update preference.",
        );
      } finally {
        setPending(false);
      }
    },
    [user, setUser],
  );

  return (
    <View style={styles.card}>
      <View style={styles.uploadsHeader}>
        <Icon
          name="shield-alert-outline"
          size={22}
          color={enabled ? colors.primary : colors.textPrimary}
        />
        <Text style={styles.sectionTitle}>Safety</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.toggleLabel}>Crash detection</Text>
          <Text style={styles.sectionBody}>
            Tarmoto will fire a 30-second countdown if it detects a hard impact
            and call your emergency contacts if you don't cancel.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={(v) => void handleToggle(v)}
          disabled={pending || !user}
          accessibilityLabel="Enable crash detection"
        />
      </View>

      {pending ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <TouchableOpacity
        style={styles.linkRow}
        onPress={() => navigation.navigate("EmergencyContacts")}
        accessibilityRole="button"
        accessibilityLabel="Manage emergency contacts"
      >
        <Icon
          name="account-multiple-outline"
          size={20}
          color={colors.primary}
        />
        <Text style={styles.linkLabel}>Emergency contacts</Text>
        <Icon
          name="chevron-right"
          size={20}
          color={colors.textTertiary}
          style={styles.chevron}
        />
      </TouchableOpacity>
    </View>
  );
}

// US-18 AC #1: surface the offline region manager from Settings. Keeping
// it here (vs a standalone tab) mirrors how iOS/Android apps expose
// "offline content" — Settings is where riders look for storage-shaped
// features. The screen itself lives at ProfileStack/OfflineRegions.
function OfflineRegionsCard() {
  const navigation = useNavigation<SettingsNav>();
  const regions = useOfflineStore((s) => s.regions);
  const downloading = regions.filter((r) => r.status === "downloading").length;
  const ready = regions.filter((r) => r.status === "complete").length;

  const summary =
    regions.length === 0
      ? "Save map areas so the road-quality overlay keeps working without cell service."
      : downloading > 0
        ? `${downloading} region${downloading === 1 ? "" : "s"} downloading now.`
        : `${ready} of ${regions.length} region${regions.length === 1 ? "" : "s"} ready offline.`;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate("OfflineRegions")}
      accessibilityRole="button"
      accessibilityLabel="Manage offline map regions"
    >
      <View style={styles.uploadsHeader}>
        <Icon
          name="map-outline"
          size={22}
          color={downloading > 0 ? colors.primary : colors.textPrimary}
        />
        <Text style={styles.sectionTitle}>Offline maps</Text>
        <Icon
          name="chevron-right"
          size={20}
          color={colors.textTertiary}
          style={styles.chevron}
        />
      </View>
      <Text style={styles.sectionBody}>{summary}</Text>
    </TouchableOpacity>
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
  chevron: {
    marginLeft: "auto",
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
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  linkLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  exportRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  exportBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.bgCard,
  },
  exportBtnLabel: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
