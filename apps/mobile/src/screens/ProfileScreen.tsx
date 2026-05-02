/**
 * ProfileScreen — US-27 own-profile view.
 *
 * Renders the authenticated rider's public profile (avatar, display name,
 * bio, home region, joined date, follower/following counts, badges earned)
 * plus the actions only the owner gets: avatar upload, edit profile, open
 * followers/following lists, settings, sign out.
 *
 * Public-profile data is loaded from `GET /users/:userId/profile` so the
 * follower/following counts come from the same endpoint as the
 * `ViewProfileScreen` — no risk of two screens disagreeing on the numbers.
 * Badges come from `GET /users/:userId/badges` in parallel.
 *
 * Avatar upload uses an optimistic local URI so the new avatar shows
 * immediately, then a `POST /users/me/avatar` round trip replaces it with
 * the persisted URL. Failures revert the optimistic state and surface an
 * inline error.
 */
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { capturePhoto } from "@/services/photoCapture";
import Avatar from "@/components/Avatar";
import StatTile from "@/components/StatTile";
import SharedRidesSection from "@/components/SharedRidesSection";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import type { MeProfile, PublicProfile, UserBadge } from "@/types";
import { formatDistance } from "@tarmoto/shared";
import { formatCount, formatJoinedLabel } from "./riderProfile.helpers";

type ProfileNav = NativeStackNavigationProp<ProfileStackParamList, "Profile">;
type Phase = "loading" | "ready" | "error";

export default function ProfileScreen() {
  const navigation = useNavigation<ProfileNav>();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  // Authoritative source for `joined_at` and `total_hours` (issue #334).
  // Fetched in parallel with the public profile so the header renders in
  // one round trip; a failure here is silently tolerated — the screen
  // still renders the public-profile data while the stat line falls back
  // to hiding the unavailable fields.
  const [summary, setSummary] = useState<MeProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // Bumped on pull-to-refresh and after avatar upload so SharedRidesSection
  // re-fetches in lock-step with the rest of the profile data — without it
  // the section would keep stale rows after a manual refresh.
  const [sharedRidesRefreshKey, setSharedRidesRefreshKey] = useState(0);

  // Cancellation token shared between the focus effect and pull-to-refresh
  // so an in-flight fetch can't write to state after the screen unmounts
  // or after a fresher refresh has been kicked off.
  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);
  const userId = user?.id;

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!userId) {
        setPhase("error");
        setErrorMessage("Sign in to see your profile.");
        return;
      }
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
      const signal = { cancelled: false };
      fetchSignalRef.current = signal;

      if (mode === "initial") {
        setPhase("loading");
        setErrorMessage(null);
      } else {
        setIsRefreshing(true);
      }

      try {
        const [nextProfile, nextBadges, nextSummary] = await Promise.all([
          api.getPublicProfile(userId),
          api.listUserBadges(userId).catch(() => [] as UserBadge[]),
          api.getMyProfile().catch(() => null),
        ]);
        if (signal.cancelled) return;
        setProfile(nextProfile);
        setBadges(nextBadges);
        setSummary(nextSummary);
        setPhase("ready");
      } catch (err) {
        if (signal.cancelled) return;
        setPhase("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Could not load profile.",
        );
      } finally {
        if (!signal.cancelled) setIsRefreshing(false);
      }
    },
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      void load("initial");
      return () => {
        if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
      };
    }, [load]),
  );

  const handleAvatarTap = useCallback(async () => {
    if (avatarUploading) return;
    const result = await capturePhoto("library");
    if (result.status === "permission-denied") {
      setAvatarError("Photo library access was denied.");
      return;
    }
    if (result.status === "unavailable") {
      setAvatarError(result.reason ?? "Photo picker unavailable.");
      return;
    }
    if (result.status !== "captured" || !result.photo) return;

    const previousUser = user;
    setAvatarUploading(true);
    setAvatarError(null);
    // Optimistic local preview so the avatar swaps instantly while the
    // upload runs. On failure we revert to the previous URL.
    if (previousUser) {
      setUser({ ...previousUser, avatar_url: result.photo.uri });
    }
    try {
      const updated = await api.uploadAvatar({
        uri: result.photo.uri,
        mimeType: result.photo.mimeType,
        fileName: result.photo.fileName,
      });
      setUser(updated);
      // Refresh profile so the counts/joined date stay in sync — the
      // avatar is on the user object but the public-profile DTO also
      // exposes it, so reloading keeps both surfaces aligned.
      void load("refresh");
    } catch (err) {
      if (previousUser) setUser(previousUser);
      setAvatarError(
        err instanceof Error ? err.message : "Could not upload avatar.",
      );
    } finally {
      setAvatarUploading(false);
    }
  }, [avatarUploading, user, setUser, load]);

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign out?", "You'll need to sign back in next time.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          api.logout();
          logout();
        },
      },
    ]);
  }, [logout]);

  if (!user) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Sign in to see your profile</Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => navigation.navigate("LinkAccount", undefined)}
          accessibilityRole="button"
          accessibilityLabel="Sign in or create account"
        >
          <Text style={styles.primaryButtonLabel}>Continue</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === "loading" && !profile) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const earnedBadges = badges.filter((b) => b.earned_at != null);
  const displayProfile: PublicProfile | null = profile ?? null;
  const displayName = displayProfile?.display_name ?? user.display_name;
  const avatarUrl = user.avatar_url ?? displayProfile?.avatar_url ?? null;
  const bio = displayProfile?.bio ?? user.bio ?? null;
  const homeRegion = displayProfile?.home_region ?? user.home_region ?? null;
  // Prefer the me-profile `joined_at` (issue #334) so the header displays
  // the same canonical value the gamification surfaces use; the public
  // profile `created_at` is the fallback if the summary call failed.
  const joinedAt =
    summary?.joined_at ?? displayProfile?.created_at ?? user.created_at;
  const followerCount = displayProfile?.follower_count ?? 0;
  const followingCount = displayProfile?.following_count ?? 0;
  const unitsPref = user.preferences?.units ?? "metric";
  const ridingStatLabel = summary
    ? buildRidingStatLabel(summary, unitsPref)
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => {
            setSharedRidesRefreshKey((k) => k + 1);
            void load("refresh");
          }}
          tintColor={colors.primary}
        />
      }
    >
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => void handleAvatarTap()}
          disabled={avatarUploading}
          accessibilityRole="button"
          accessibilityLabel="Change avatar"
        >
          <Avatar uri={avatarUrl} name={displayName} size={88} />
          <View style={styles.avatarBadge}>
            {avatarUploading ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <Icon
                name="camera-outline"
                size={16}
                color={colors.textInverse}
              />
            )}
          </View>
        </TouchableOpacity>
        <Text style={styles.displayName}>{displayName}</Text>
        <Text style={styles.metaLine}>{formatJoinedLabel(joinedAt)}</Text>
        {ridingStatLabel ? (
          <Text style={styles.metaLine}>{ridingStatLabel}</Text>
        ) : null}
        {homeRegion ? (
          <View style={styles.metaInline}>
            <Icon
              name="map-marker-outline"
              size={14}
              color={colors.textSecondary}
            />
            <Text style={styles.metaLine}>{homeRegion}</Text>
          </View>
        ) : null}
        {bio ? <Text style={styles.bio}>{bio}</Text> : null}
        {avatarError ? (
          <Text style={styles.errorText}>{avatarError}</Text>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <StatTile
          label="Followers"
          value={formatCount(followerCount)}
          onPress={() =>
            navigation.navigate("Followers", {
              userId: user.id,
              displayName,
            })
          }
          accessibilityLabel={`${followerCount} followers, open list`}
        />
        <StatTile
          label="Following"
          value={formatCount(followingCount)}
          onPress={() =>
            navigation.navigate("Following", {
              userId: user.id,
              displayName,
            })
          }
          accessibilityLabel={`Following ${followingCount} riders, open list`}
        />
        <StatTile
          label="Badges"
          value={formatCount(earnedBadges.length)}
          onPress={() => navigation.navigate("Achievements")}
          accessibilityLabel={`${earnedBadges.length} badges earned, open achievements`}
        />
      </View>

      <SharedRidesSection
        userId={user.id}
        isSelf
        displayName={displayName}
        refreshKey={sharedRidesRefreshKey}
      />

      <View style={styles.actionsCard}>
        <ActionRow
          icon="account-edit-outline"
          label="Edit profile"
          onPress={() => navigation.navigate("EditProfile")}
        />
        <ActionRow
          icon="trophy-outline"
          label="Achievements"
          onPress={() => navigation.navigate("Achievements")}
        />
        <ActionRow
          icon="cog-outline"
          label="Settings"
          onPress={() => navigation.navigate("Settings")}
        />
        <ActionRow
          icon="logout"
          label="Sign out"
          destructive
          onPress={handleSignOut}
        />
      </View>

      {phase === "error" && errorMessage ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => void load("initial")}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

/**
 * Compact "X · Y · Z" line summarising the rider's lifetime numbers from
 * the `/users/me/profile` endpoint. Skips zero-value segments so a brand-
 * new rider sees nothing instead of "0 km · 0h · 0 rides", and returns
 * null when every segment would be skipped so the parent can render no
 * line at all.
 *
 * The zero-check happens AFTER rounding — a raw value like `0.3` is `> 0`
 * but `Math.round(0.3) === 0`, so a pre-rounding check would still let
 * "0 km" / "0h" through and contradict the documented intent.
 */
function buildRidingStatLabel(
  summary: MeProfile,
  units: "metric" | "imperial",
): string | null {
  const parts: string[] = [];
  const km = Math.round(summary.total_distance_km);
  if (km > 0) {
    parts.push(formatDistance(km, units));
  }
  const hours = Math.round(summary.total_hours);
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (summary.total_rides > 0) {
    parts.push(
      `${summary.total_rides} ride${summary.total_rides === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

interface ActionRowProps {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

function ActionRow({ icon, label, destructive, onPress }: ActionRowProps) {
  return (
    <TouchableOpacity
      style={styles.actionRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        name={icon}
        size={20}
        color={destructive ? colors.danger : colors.textPrimary}
      />
      <Text
        style={[styles.actionLabel, destructive ? styles.actionDanger : null]}
      >
        {label}
      </Text>
      {!destructive ? (
        <Icon
          name="chevron-right"
          size={20}
          color={colors.textTertiary}
          style={styles.chevron}
        />
      ) : null}
    </TouchableOpacity>
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
    gap: spacing.lg,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  header: {
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.lg,
  },
  avatarBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.bg,
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
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  actionsCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    flex: 1,
  },
  actionDanger: {
    color: colors.danger,
  },
  chevron: {
    marginLeft: "auto",
  },
  errorCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: "center",
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
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
  primaryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  primaryButtonLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
