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
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
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
}

type Phase = "loading" | "ready" | "error";

const PAGE_SIZE = 5;

export default function SharedRidesSection({
  userId,
  isSelf,
  displayName,
}: SharedRidesSectionProps) {
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
  }, [userId]);

  useEffect(() => {
    void load();
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [load]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Shared rides</Text>

      {phase === "loading" ? (
        <View style={styles.placeholder}>
          <ActivityIndicator color={colors.primary} />
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
            <SharedRideRow key={ride.share_token} ride={ride} isSelf={isSelf} />
          ))}
        </View>
      )}
    </View>
  );
}

interface SharedRideRowProps {
  ride: UserSharedRide;
  isSelf: boolean;
}

function SharedRideRow({ ride, isSelf }: SharedRideRowProps) {
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
            <Icon name="lock-outline" size={11} color={colors.textSecondary} />
            <Text style={styles.privatePillLabel}>Private</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowMetrics}>
        <RowMetric
          label="Distance"
          value={formatDistanceKm(ride.distance_km)}
        />
        <RowMetric
          label="Duration"
          value={formatDurationMinutes(ride.duration_min)}
        />
        <RowMetric
          label="Views"
          value={`${Math.max(0, Math.round(ride.view_count))}`}
        />
      </View>
    </View>
  );
}

function RowMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
