/**
 * Shared list rendering for the Followers and Following screens (US-27).
 *
 * Both screens render an identical FlatList of rider rows; only the
 * endpoint and empty-state copy differ. The mode prop drives both, so
 * the screens stay one-liners (FollowList with a mode + route params)
 * and the pull-to-refresh / loading / error / row-tap behaviour stays
 * in lockstep across the two surfaces.
 *
 * The fetch is dispatched off `mode` rather than threaded through as a
 * function prop. A function prop would have to be re-stabilised on
 * every render of the parent screen (or `bind`ed at module scope) —
 * `api.listFollowers.bind(api)` was a footgun because the new function
 * reference per render would re-trigger the `useEffect` below and flash
 * the loading spinner. Letting `mode` select the call inside `load`
 * avoids the trap.
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
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { api } from "@/services/api";
import Avatar from "@/components/Avatar";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import type { FollowerListItem } from "@/types";
import { formatFollowedSince } from "./riderProfile.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

export type FollowListMode = "followers" | "following";

interface FollowListProps {
  userId: string;
  displayName: string;
  mode: FollowListMode;
}

type Phase = "loading" | "ready" | "error";

const t = brandColorsLight;

export default function FollowList({
  userId,
  displayName,
  mode,
}: FollowListProps) {
  const translate = useTranslation();
  const navigation =
    useNavigation<NativeStackNavigationProp<ProfileStackParamList>>();
  // Operator kill switch (`community_access`, fail-SAFE off /config/flags):
  // disabled during a moderation incident. A follower/following list is
  // community browse, so close it on a kill — from whichever entry pushed it
  // (own-profile OR another rider's). The entry tiles are also made
  // non-interactive at their call sites, but this is the last line of defence.
  const communityEnabled = useFeatureKillSwitchActive("community_access");
  useEffect(() => {
    if (!communityEnabled) navigation.goBack();
  }, [communityEnabled, navigation]);
  const [items, setItems] = useState<FollowerListItem[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      // Guard the read at its single choke point so EVERY caller is covered —
      // the mount effect, the Retry button, and pull-to-refresh — not just the
      // effect. Under an active community_access kill the list is bouncing, so
      // it must not issue listFollowers/listFollowing.
      if (!isFeatureKillSwitchActive("community_access")) return;
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
        // Calling `api.listFollowers(...)` as a method preserves `this`
        // — no bind needed, and crucially nothing here changes identity
        // between renders, so the useEffect below only fires when
        // `userId` or `mode` actually change.
        const next =
          mode === "followers"
            ? await api.listFollowers(userId)
            : await api.listFollowing(userId);
        if (signal.cancelled) return;
        setItems(next);
        setPhase("ready");
      } catch (err) {
        if (signal.cancelled) return;
        setPhase("error");
        setErrorMessage(
          getUserFacingErrorMessage(err, translate("Could not load list.")),
        );
      } finally {
        if (!signal.cancelled) setIsRefreshing(false);
      }
    },
    [userId, mode, translate],
  );

  useEffect(() => {
    // Don't fire the community read (listFollowers/listFollowing) when the
    // switch is off — the screen is about to bounce, so the fetch would be a
    // pointless community operation issued under an active kill.
    if (!communityEnabled) return;
    void load(false);
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [load, communityEnabled]);

  if (phase === "loading" && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={t.fg} />
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
          accessibilityLabel={translate("Retry loading list")}
        >
          <Text style={styles.retryLabel}>{translate("Retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          {mode === "followers"
            ? translate("{value0} has no followers yet.", {
                value0: displayName,
              })
            : translate("{value0} isn’t following anyone yet.", {
                value0: displayName,
              })}
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
          tintColor={t.fg}
        />
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() =>
            navigation.push("ViewProfile", { userId: item.user_id })
          }
          accessibilityRole="button"
          accessibilityLabel={translate("Open {value0}'s profile", {
            value0: item.display_name,
          })}
        >
          <Avatar name={item.display_name} size={44} />
          <View style={styles.rowBody}>
            <Text style={styles.rowName}>{item.display_name}</Text>
            <Text style={styles.rowMeta}>
              {formatFollowedSince(item.followed_at, mode)}
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: t.bg },
  listContent: { padding: brandSpacing.s4, gap: brandSpacing.s2 },
  center: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s3,
    minHeight: 64,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  rowMeta: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  emptyText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    textAlign: "center",
  },
  retryButton: {
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  retryLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
