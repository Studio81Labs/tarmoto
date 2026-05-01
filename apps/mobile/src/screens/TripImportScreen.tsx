/**
 * TripImportScreen — landing surface for the web companion's "Push to
 * mobile" handoff (US-39 / #283). The deep link
 * `tarmoto://trips/import?tripId=...&token=...` opens this screen with
 * both query params; we fetch `/trip-shares/:token`, show a preview of
 * the shared trip, and on confirmation post to `/trips/import` to
 * materialise the trip in the rider's library.
 *
 * Auth note: `/trip-shares/:token` is a public read-only endpoint so the
 * fetch works whether or not the rider is signed in. The actual import
 * step requires auth — if the rider isn't signed in we surface an error
 * message rather than route them through a sign-in flow (the planner
 * trip can be re-pushed from the web after they sign in).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import {
  buildSharedTripPreview,
  sharedSnapshotToImportRequest,
  type SharedTripPreview,
} from "@/services/sharedTripImport";
import type { TripSharePublic } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";

type ImportRoute = RouteProp<TripsStackParamList, "TripImport">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripImport">;

export default function TripImportScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<ImportRoute>();
  const token = params?.token?.trim() ?? "";

  const [share, setShare] = useState<TripSharePublic | null>(null);
  const [preview, setPreview] = useState<SharedTripPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Synchronous re-entrancy guard for double-taps on "Save to my trips" —
  // mirrors the pattern in TripCreateScreen so two fast taps can't both
  // pass the `importing` state guard before the first render commits.
  const importingRef = useRef(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setErrorMessage(
        "This handoff link is missing its token. Open the trip from the web companion again.",
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    api
      .getTripShare(token)
      .then((data) => {
        if (cancelled) return;
        setShare(data);
        const built = buildSharedTripPreview(data);
        setPreview(built);
        if (!built) {
          setErrorMessage(
            "This shared trip is in an unexpected format and can't be imported here.",
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const status =
          (err as { response?: { status?: number } })?.response?.status ?? 0;
        setErrorMessage(
          status === 404
            ? "This handoff link has expired or was revoked."
            : "Couldn't fetch the trip — check your connection and try again.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleImport = useCallback(async () => {
    if (!share || importingRef.current) return;
    const request = sharedSnapshotToImportRequest(share);
    if (!request) {
      setErrorMessage(
        "This shared trip doesn't carry route geometry — ask the planner to re-export it.",
      );
      return;
    }
    importingRef.current = true;
    setImporting(true);
    setErrorMessage(null);
    try {
      const trip = await api.importTripFromRoute(request);
      // Replace, not push: the import landing screen has no value as a
      // back target once the trip is in the rider's library.
      navigation.replace("TripDetail", { tripId: trip.id });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't import this trip.";
      setErrorMessage(message);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [share, navigation]);

  if (loading) {
    return (
      <View style={[styles.flex, styles.center]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.loadingText}>Loading shared trip…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <View style={styles.heroIconWrap}>
          <Icon name="cellphone-arrow-down" size={28} color={colors.primary} />
        </View>
        <Text style={styles.title}>Import shared trip</Text>
        <Text style={styles.subtitle}>
          You opened a trip handoff link from the Tarmoto web planner. Save it
          to your trips to ride and follow it on the go.
        </Text>
      </View>

      {preview ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{preview.title}</Text>
          <Text style={styles.cardOwner}>Shared by {preview.ownerName}</Text>
          <View style={styles.statRow}>
            <Stat label="Days" value={String(preview.dayCount)} />
            <Stat
              label="Distance"
              value={
                preview.totalDistanceKm > 0
                  ? `${Math.round(preview.totalDistanceKm)} km`
                  : "—"
              }
            />
            <Stat label="Stops" value={String(preview.waypointCount)} />
          </View>
        </View>
      ) : null}

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle" size={18} color={colors.danger} />
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[
          styles.importBtn,
          (!share || !preview || importing) && styles.importBtnDisabled,
        ]}
        onPress={() => void handleImport()}
        disabled={!share || !preview || importing}
        accessibilityRole="button"
        accessibilityLabel="Save to my trips"
        accessibilityState={{ busy: importing, disabled: !share || !preview }}
      >
        {importing ? (
          <ActivityIndicator color={colors.textInverse} />
        ) : (
          <>
            <Icon name="content-save" size={20} color={colors.textInverse} />
            <Text style={styles.importLabel}>Save to my trips</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.section,
  },
  hero: {
    gap: spacing.md,
  },
  heroIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
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
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  cardOwner: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  statRow: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: 2,
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
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  importBtnDisabled: {
    opacity: 0.5,
  },
  importLabel: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
});
