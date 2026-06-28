/**
 * SharedRidesSection (#336)
 *
 * Renders the rider's shared rides on the profile screen. Used by both
 * `ProfileScreen` (own profile) and `ViewProfileScreen` (other rider) so
 * the layout stays in lock-step. The backend gates visibility on the
 * rider's `profile_visibility` privacy preference and returns a 404 for
 * private profiles to non-self viewers — that 404 is treated as "no
 * rides to show" rather than an error so the section just renders
 * empty for hidden riders.
 *
 * `is_self` flips two pieces of behaviour:
 *   - the empty hint copy ("you haven't shared any rides yet" vs.
 *     "<rider> hasn't shared any rides yet")
 *   - whether the per-card "private" pill is shown — only visible on
 *     own-profile, since for other riders the backend has already
 *     filtered out their private shares
 *
 * Refresh model: the section re-fetches every time the host screen
 * gains focus (via `useFocusEffect`) so a rider who shares a new ride
 * and navigates back to their profile sees the new card immediately.
 * `refreshKey` is an opt-in nudge for the parent: bump it from a
 * pull-to-refresh handler (or anywhere else) to force a re-fetch
 * without unmounting the section.
 */
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useFocusEffect } from "@react-navigation/native";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import type { UserSharedRide } from "@/types";
import {
  formatDistanceKm,
  formatDurationMinutes,
  formatRideDate,
} from "@/screens/RideScreens.helpers";

interface SharedRidesSectionProps {
  userId: string;
  isSelf: boolean;
  /** Rider display name — used in the empty-state copy. */
  displayName: string;
  /**
   * Bump from the parent to force a re-fetch — typically wired to
   * pull-to-refresh on the host screen. Identity-compared, so any
   * change (number bump or new object reference) triggers a reload.
   */
  refreshKey?: number;
  /**
   * Render on a light brand surface (cream/white card). Default: legacy dark.
   * Shared with the still-legacy ViewProfileScreen, so the default must stay
   * the dark-theme look.
   */
  light?: boolean;
}

type Phase = "loading" | "ready" | "error";

const PAGE_SIZE = 5;

export default function SharedRidesSection({
  userId,
  isSelf,
  displayName,
  refreshKey,
  light = false,
}: SharedRidesSectionProps) {
  const styles = light ? brandStyles : legacyStyles;
  const [items, setItems] = useState<UserSharedRide[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Cancellation guard so a re-render with a different `userId` (e.g. after
  // navigating from one rider's profile straight to another's) can't write
  // stale results over the new rider's data.
  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    const signal = { cancelled: false };
    fetchSignalRef.current = signal;

    setPhase("loading");
    setErrorMessage(null);
    try {
      const response = await api.listUserSharedRides(userId, {
        limit: PAGE_SIZE,
      });
      if (signal.cancelled) return;
      setItems(response.items);
      setPhase("ready");
    } catch (err) {
      if (signal.cancelled) return;
      // 404 = rider hidden by privacy or soft-deleted. Render the empty
      // state instead of an error so a "private" rider's profile (which
      // we still resolve via /users/:userId/profile when authenticated)
      // doesn't show a scary error block under the stats row.
      if (err instanceof ApiError && err.status === 404) {
        setItems([]);
        setPhase("ready");
        return;
      }
      setPhase("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Could not load shared rides.",
      );
    }
    // refreshKey is a refresh nudge — including it in deps makes
    // bumping it re-run `load`, which re-runs the focus effect below.
  }, [userId, refreshKey]);

  // Refresh on every focus: when the host screen comes back into view
  // after the rider shared a new ride elsewhere (or unshared one), the
  // list is re-fetched. `useFocusEffect` also runs when `load` changes
  // identity while the screen is focused, so a `userId` change or a
  // `refreshKey` bump from the parent both trigger a reload too.
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
      };
    }, [load]),
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Shared rides</Text>

      {phase === "loading" ? (
        <View style={styles.placeholder}>
          <ActivityIndicator
            color={light ? brandColorsLight.fg : colors.primary}
          />
        </View>
      ) : phase === "error" ? (
        <Text style={styles.errorText}>{errorMessage}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.emptyHint}>
          {isSelf
            ? "You haven't shared any rides yet."
            : `${displayName} hasn't shared any rides yet.`}
        </Text>
      ) : (
        <View style={styles.list}>
          {items.map((ride) => (
            <SharedRideRow
              key={ride.share_token}
              ride={ride}
              isSelf={isSelf}
              light={light}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface SharedRideRowProps {
  ride: UserSharedRide;
  isSelf: boolean;
  light: boolean;
}

function SharedRideRow({ ride, isSelf, light }: SharedRideRowProps) {
  const styles = light ? brandStyles : legacyStyles;
  const showPrivatePill = isSelf && !ride.is_public;
  return (
    <View
      style={styles.row}
      accessibilityLabel={`Shared ride on ${formatRideDate(ride.started_at)}`}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.rowDate}>{formatRideDate(ride.started_at)}</Text>
        {showPrivatePill ? (
          <View style={styles.privatePill}>
            <Icon
              name="lock-outline"
              size={11}
              color={light ? brandColorsLight.dim : colors.textSecondary}
            />
            <Text style={styles.privatePillLabel}>Private</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowMetrics}>
        <RowMetric
          label="Distance"
          value={formatDistanceKm(ride.distance_km)}
          light={light}
        />
        <RowMetric
          label="Duration"
          value={formatDurationMinutes(ride.duration_min)}
          light={light}
        />
        <RowMetric
          label="Views"
          value={`${Math.max(0, Math.round(ride.view_count))}`}
          light={light}
        />
      </View>
    </View>
  );
}

function RowMetric({
  label,
  value,
  light,
}: {
  label: string;
  value: string;
  light: boolean;
}) {
  const styles = light ? brandStyles : legacyStyles;
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

// Legacy dark-surface styling — unchanged so the still-legacy
// ViewProfileScreen renders exactly as before.
const legacyStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  placeholder: {
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  emptyHint: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
  },
  list: {
    gap: spacing.md,
  },
  row: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowDate: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  privatePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  privatePillLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
  },
  rowMetrics: {
    flexDirection: "row",
    gap: spacing.lg,
  },
  metric: {
    alignItems: "flex-start",
  },
  metricValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  metricLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
});

// Brand light-surface styling (white card on cream). Metric values use the
// mono "stamp" family (numbers); `dim` labels/hints clear AA on white and
// `statusFg.danger` keeps errors legible without the raw quality red.
const brandStyles = StyleSheet.create({
  card: {
    backgroundColor: brandColorsLight.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: brandColorsLight.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  title: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  placeholder: {
    paddingVertical: brandSpacing.s4,
    alignItems: "center",
  },
  emptyHint: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  list: {
    gap: brandSpacing.s3,
  },
  row: {
    paddingVertical: brandSpacing.s3,
    borderTopWidth: 1,
    borderTopColor: brandColorsLight.line,
    gap: brandSpacing.s2,
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowDate: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  privatePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 2,
    borderRadius: brandRadii.pill,
    backgroundColor: brandColorsLight.raised2,
    borderWidth: 1,
    borderColor: brandColorsLight.line,
  },
  privatePillLabel: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  rowMetrics: {
    flexDirection: "row",
    gap: brandSpacing.s4,
  },
  metric: {
    alignItems: "flex-start",
  },
  metricValue: {
    color: brandColorsLight.fg,
    fontFamily: brandFonts.mono,
    fontSize: 14,
    fontWeight: "700",
  },
  metricLabel: {
    color: brandColorsLight.dim,
    fontFamily: brandFonts.sans,
    fontSize: 10,
  },
});
