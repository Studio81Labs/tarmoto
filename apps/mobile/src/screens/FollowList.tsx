/**
 * Shared list rendering for the Followers and Following screens (US-27).
 *
 * Both screens render an identical FlatList of rider rows; only the
 * fetcher and empty-state copy differ. Sharing here keeps the two screen
 * files thin (parameter unpacking + fetcher selection) and ensures the
 * pull-to-refresh / loading / error / row-tap behaviour stays in lockstep.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import Avatar from "@/components/Avatar";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import type { FollowerListItem } from "@/types";
import { formatFollowedSince } from "./riderProfile.helpers";

interface FollowListProps {
  userId: string;
  displayName: string;
  mode: "followers" | "following";
  fetcher: (userId: string) => Promise<FollowerListItem[]>;
}

type Phase = "loading" | "ready" | "error";

export default function FollowList({
  userId,
  displayName,
  mode,
  fetcher,
}: FollowListProps) {
  const navigation =
    useNavigation<NativeStackNavigationProp<ProfileStackParamList>>();
  const [items, setItems] = useState<FollowerListItem[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
      const signal = { cancelled: false };
      fetchSignalRef.current = signal;

      if (refresh) {
        setIsRefreshing(true);
      } else {
        setPhase("loading");
        setErrorMessage(null);
      }

      try {
        const next = await fetcher(userId);
        if (signal.cancelled) return;
        setItems(next);
        setPhase("ready");
      } catch (err) {
        if (signal.cancelled) return;
        setPhase("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Could not load list.",
        );
      } finally {
        if (!signal.cancelled) setIsRefreshing(false);
      }
    },
    [userId, fetcher],
  );

  useEffect(() => {
    void load(false);
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [load]);

  if (phase === "loading" && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (phase === "error" && items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{errorMessage}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => void load(false)}
          accessibilityRole="button"
          accessibilityLabel="Retry loading list"
        >
          <Text style={styles.retryLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          {mode === "followers"
            ? `${displayName} has no followers yet.`
            : `${displayName} isn’t following anyone yet.`}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={items}
      keyExtractor={(item) => item.user_id}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => void load(true)}
          tintColor={colors.primary}
        />
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() =>
            navigation.push("ViewProfile", { userId: item.user_id })
          }
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.display_name}'s profile`}
        >
          <Avatar name={item.display_name} size={44} />
          <View style={styles.rowBody}>
            <Text style={styles.rowName}>{item.display_name}</Text>
            <Text style={styles.rowMeta}>
              {formatFollowedSince(item.followed_at)}
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, gap: spacing.sm },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  rowMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    textAlign: "center",
  },
  retryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  retryLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
