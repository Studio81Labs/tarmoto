/**
 * TripImportScreen — landing surface for the web companion's "Push to
 * mobile" handoff (US-39 / #283). The deep link
 * `tarmoto://trips/import?tripId=...&token=...` opens this screen with
 * both query params; we fetch `/trip-shares/:token` for the preview UI,
 * and on confirmation post the token to `/trips/from-share` (#357) so
 * the backend can reconstruct the original multi-day structure rather
 * than collapsing the trip into a single planned day the way the
 * legacy `/trips/import` endpoint does.
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
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import {
  buildSharedTripPreview,
  type SharedTripPreview,
} from "@/services/sharedTripImport";
import type { TripSharePublic } from "@/types";
import type { TripsStackParamList } from "@/navigation/RootNavigator";

type ImportRoute = RouteProp<TripsStackParamList, "TripImport">;
type Nav = NativeStackNavigationProp<TripsStackParamList, "TripImport">;

const t = brandColorsLight;

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
        const status = err instanceof ApiError ? err.status : 0;
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
    importingRef.current = true;
    setImporting(true);
    setErrorMessage(null);
    try {
      // POST /trips/from-share preserves the multi-day structure the
      // planner exported (#357). The backend reads the snapshot from
      // `trip_shares` under the supplied token — we only need to send
      // the token, not re-post the snapshot.
      const trip = await api.importTripFromShare(share.share_token);
      // Replace, not push: the import landing screen has no value as a
      // back target once the trip is in the rider's library.
      navigation.replace("TripDetail", { tripId: trip.id });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const message =
        status === 400
          ? "This shared trip doesn't carry route data — ask the planner to re-export it."
          : status === 404
            ? "This handoff link has expired or was revoked."
            : err instanceof Error
              ? err.message
              : "Couldn't import this trip.";
      setErrorMessage(message);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [share, navigation]);

  if (loading) {
    return (
      <View style={[styles.flex, styles.center]}>
        <ActivityIndicator color={t.fg} />
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
          <Icon name="cellphone-arrow-down" size={28} color={t.fg} />
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
            <Stat label="Stops" value={String(preview.stopCount)} />
          </View>
        </View>
      ) : null}

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle" size={18} color={statusFg.danger} />
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
          <ActivityIndicator color={t.invFg} />
        ) : (
          <>
            <Icon name="content-save" size={20} color={t.invFg} />
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
    backgroundColor: t.bg,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s3,
  },
  loadingText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
  },
  hero: {
    gap: brandSpacing.s3,
  },
  heroIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
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
    gap: brandSpacing.s2,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  cardOwner: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
  },
  statRow: {
    flexDirection: "row",
    gap: brandSpacing.s4,
    marginTop: brandSpacing.s2,
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  statValue: {
    color: t.fg,
    fontFamily: brandFonts.mono,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 2,
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
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  importBtnDisabled: {
    opacity: 0.5,
  },
  importLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
});
