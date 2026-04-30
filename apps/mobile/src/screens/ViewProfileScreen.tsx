/**
 * ViewProfileScreen — US-27 read-only profile of another rider.
 *
 * Loaded from `/users/:userId/profile` plus `/users/:userId/badges` in
 * parallel. The follow toggle is optimistic and mirrors the companion's
 * `apps/companion/src/lib/rider-profile.ts` flow:
 *   - flip `is_following` immediately and bump/decrement `follower_count`
 *   - issue `POST` or `DELETE /users/:userId/follow`
 *   - on failure, revert to the captured pre-toggle state and surface the
 *     error inline (the captured state is read-only inside the catch so a
 *     concurrent re-fetch can't be silently overwritten by a stale revert)
 *
 * 409 (already following) and 404 (not following) are treated as success
 * because the click raced with optimistic state — the user's intent has
 * already been applied either by us or a previous request.
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
import Icon from "@react-native-vector-icons/material-design-icons";
import { isAxiosError } from "axios";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import Avatar from "@/components/Avatar";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import type { PublicProfile, UserBadge } from "@/types";
import { formatCount, formatJoinedLabel } from "./riderProfile.helpers";

type ViewRoute = RouteProp<ProfileStackParamList, "ViewProfile">;
type Nav = NativeStackNavigationProp<ProfileStackParamList, "ViewProfile">;
type Phase = "loading" | "ready" | "error";

export default function ViewProfileScreen() {
  const { params } = useRoute<ViewRoute>();
  const navigation = useNavigation<Nav>();
  const userId = params?.userId;

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [followPending, setFollowPending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const fetchProfile = useCallback(async () => {
    if (!userId) {
      setPhase("error");
      setErrorMessage("Missing rider id.");
      return;
    }
    if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    const signal = { cancelled: false };
    fetchSignalRef.current = signal;

    setPhase("loading");
    setErrorMessage(null);
    try {
      const [nextProfile, nextBadges] = await Promise.all([
        api.getPublicProfile(userId),
        api.listUserBadges(userId).catch(() => [] as UserBadge[]),
      ]);
      if (signal.cancelled) return;
      setProfile(nextProfile);
      setBadges(nextBadges);
      setPhase("ready");
    } catch (err) {
      if (signal.cancelled) return;
      setPhase("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Could not load rider profile.",
      );
    }
  }, [userId]);

  useEffect(() => {
    void fetchProfile();
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [fetchProfile]);

  // Update the header title to the rider's display name once we have it.
  useEffect(() => {
    if (profile?.display_name) {
      navigation.setOptions({ title: profile.display_name });
    }
  }, [profile?.display_name, navigation]);

  const handleFollowToggle = useCallback(async () => {
    if (!profile || followPending || profile.is_self) return;
    const wasFollowing = profile.is_following === true;
    const targetId = profile.id;

    // Optimistic flip via the functional setter so a concurrent re-fetch
    // can't be silently overwritten by this stale closure.
    setProfile((prev) =>
      prev && prev.id === targetId
        ? {
            ...prev,
            is_following: !wasFollowing,
            follower_count: Math.max(
              0,
              prev.follower_count + (wasFollowing ? -1 : 1),
            ),
          }
        : prev,
    );
    setFollowPending(true);
    setFollowError(null);

    try {
      if (wasFollowing) {
        await api.unfollowUser(targetId);
      } else {
        await api.followUser(targetId);
      }
    } catch (err) {
      // 409 on follow (already following) and 404 on unfollow (not
      // following) are idempotent from the user's perspective — the
      // server is already in the state we wanted, so swallow them.
      const status = isAxiosError(err) ? err.response?.status : undefined;
      if (
        (!wasFollowing && status === 409) ||
        (wasFollowing && status === 404)
      ) {
        return;
      }
      setProfile((prev) =>
        prev && prev.id === targetId
          ? {
              ...prev,
              is_following: wasFollowing,
              follower_count: Math.max(
                0,
                prev.follower_count + (wasFollowing ? 1 : -1),
              ),
            }
          : prev,
      );
      setFollowError(
        err instanceof Error ? err.message : "Could not update follow.",
      );
    } finally {
      setFollowPending(false);
    }
  }, [profile, followPending]);

  if (phase === "loading" && !profile) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (phase === "error" && !profile) {
    return (
      <View style={styles.empty}>
        <Text style={styles.errorTitle}>Couldn&apos;t load rider</Text>
        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => void fetchProfile()}
          accessibilityRole="button"
          accessibilityLabel="Retry loading profile"
        >
          <Text style={styles.retryLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!profile) return null;

  const earnedBadges = badges.filter((b) => b.earned_at != null);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Avatar
          uri={profile.avatar_url}
          name={profile.display_name}
          size={88}
        />
        <Text style={styles.displayName}>{profile.display_name}</Text>
        <Text style={styles.metaLine}>
          {formatJoinedLabel(profile.created_at)}
        </Text>
        {profile.home_region ? (
          <View style={styles.metaInline}>
            <Icon
              name="map-marker-outline"
              size={14}
              color={colors.textSecondary}
            />
            <Text style={styles.metaLine}>{profile.home_region}</Text>
          </View>
        ) : null}
        {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}

        {profile.is_self ? null : (
          <TouchableOpacity
            style={[
              styles.followButton,
              profile.is_following ? styles.followingButton : null,
              followPending ? styles.disabled : null,
            ]}
            onPress={() => void handleFollowToggle()}
            disabled={followPending}
            accessibilityRole="button"
            accessibilityState={{ selected: profile.is_following === true }}
            accessibilityLabel={
              profile.is_following ? "Unfollow rider" : "Follow rider"
            }
          >
            {followPending ? (
              <ActivityIndicator
                size="small"
                color={
                  profile.is_following ? colors.textPrimary : colors.textInverse
                }
              />
            ) : (
              <>
                <Icon
                  name={
                    profile.is_following
                      ? "account-check-outline"
                      : "account-plus-outline"
                  }
                  size={16}
                  color={
                    profile.is_following
                      ? colors.textPrimary
                      : colors.textInverse
                  }
                />
                <Text
                  style={[
                    styles.followLabel,
                    profile.is_following ? styles.followingLabel : null,
                  ]}
                >
                  {profile.is_following ? "Following" : "Follow"}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {followError ? (
          <Text style={styles.errorText}>{followError}</Text>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <StatTile
          label="Followers"
          value={formatCount(profile.follower_count)}
          onPress={() =>
            navigation.push("Followers", {
              userId: profile.id,
              displayName: profile.display_name,
            })
          }
          accessibilityLabel={`${profile.follower_count} followers, open list`}
        />
        <StatTile
          label="Following"
          value={formatCount(profile.following_count)}
          onPress={() =>
            navigation.push("Following", {
              userId: profile.id,
              displayName: profile.display_name,
            })
          }
          accessibilityLabel={`Following ${profile.following_count} riders, open list`}
        />
        <StatTile label="Badges" value={formatCount(earnedBadges.length)} />
      </View>

      <View style={styles.badgesCard}>
        <Text style={styles.cardTitle}>Badges earned</Text>
        {earnedBadges.length === 0 ? (
          <Text style={styles.emptyHint}>
            {profile.display_name} hasn&apos;t earned any badges yet.
          </Text>
        ) : (
          <View style={styles.badgeGrid}>
            {earnedBadges.map((badge) => (
              <View key={badge.key} style={styles.badgePill}>
                <Icon name="trophy-outline" size={14} color={colors.primary} />
                <Text style={styles.badgeName}>{badge.name}</Text>
                {badge.tier ? (
                  <Text style={styles.badgeTier}>{badge.tier}</Text>
                ) : null}
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}

function StatTile({
  label,
  value,
  onPress,
  accessibilityLabel,
}: StatTileProps) {
  if (onPress) {
    return (
      <TouchableOpacity
        style={styles.statTile}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
      >
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={styles.statTile} accessibilityLabel={accessibilityLabel}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  empty: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  header: {
    alignItems: "center",
    gap: spacing.sm,
  },
  displayName: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginTop: spacing.sm,
  },
  metaLine: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  metaInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  bio: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    textAlign: "center",
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  followButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
    marginTop: spacing.md,
    minWidth: 140,
    justifyContent: "center",
  },
  followingButton: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  disabled: {
    opacity: 0.6,
  },
  followLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  followingLabel: {
    color: colors.textPrimary,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  statTile: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.xs,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  statLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  badgesCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  emptyHint: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  badgeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primaryAlpha15,
    borderWidth: 1,
    borderColor: colors.borderFocus,
  },
  badgeName: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  badgeTier: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
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
