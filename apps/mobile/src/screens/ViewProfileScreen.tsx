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
import { Icon } from "@/components/Icon";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { ApiError, api } from "@/services/api";
import Avatar from "@/components/Avatar";
import StatTile from "@/components/StatTile";
import SharedRidesSection from "@/components/SharedRidesSection";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import type { PublicProfile, UserBadge } from "@/types";
import { formatCount, formatJoinedLabel } from "./riderProfile.helpers";
import { badgeCopy, tierLabel } from "./AchievementsScreen.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

type ViewRoute = RouteProp<ProfileStackParamList, "ViewProfile">;
type Nav = NativeStackNavigationProp<ProfileStackParamList, "ViewProfile">;
type Phase = "loading" | "ready" | "error";

const t = brandColorsLight;

export default function ViewProfileScreen() {
  const translate = useTranslation();
  const { params } = useRoute<ViewRoute>();
  const navigation = useNavigation<Nav>();
  const userId = params?.userId;

  // Operator kill switch (`community_access`, fail-SAFE off /config/flags):
  // another rider's public profile is community content, so close it on a kill
  // regardless of which entry (follow list, road preview, trip detail) pushed
  // it. The rider's OWN ProfileScreen is a separate screen and stays.
  const communityEnabled = useFeatureKillSwitchActive("community_access");
  useEffect(() => {
    if (!communityEnabled) navigation.goBack();
  }, [communityEnabled, navigation]);

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
      setErrorMessage(translate("Missing rider id."));
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
        getUserFacingErrorMessage(
          err,
          translate("Could not load rider profile."),
        ),
      );
    }
  }, [userId, translate]);

  useEffect(() => {
    // Don't issue the community reads (getPublicProfile / listUserBadges) when
    // community_access is killed — the screen is about to bounce, so the fetch
    // would be a community operation under an active moderation kill (the
    // switch is client-only; the backend does not enforce it).
    if (!communityEnabled) return;
    void fetchProfile();
    return () => {
      if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    };
  }, [fetchProfile, communityEnabled]);

  // Update the header title to the rider's display name once we have it.
  useEffect(() => {
    if (profile?.display_name) {
      navigation.setOptions({ title: profile.display_name });
    }
  }, [profile?.display_name, navigation]);

  const handleFollowToggle = useCallback(async () => {
    // Defensive sync guard: normal follow/unfollow is unaffected by this
    // switch, but a write must not land during an ACTIVE moderation kill if
    // the operator flips community_access off exactly as the rider taps (the
    // screen's goBack races the tap). Only blocks while force_off is live.
    if (!isFeatureKillSwitchActive("community_access")) return;
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
      const status = err instanceof ApiError ? err.status : undefined;
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
        getUserFacingErrorMessage(err, translate("Could not update follow.")),
      );
    } finally {
      setFollowPending(false);
    }
  }, [profile, followPending, translate]);

  if (phase === "loading" && !profile) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={t.fg} />
      </View>
    );
  }

  if (phase === "error" && !profile) {
    return (
      <View style={styles.empty}>
        <Text style={styles.errorTitle}>
          {translate("Couldn't load rider")}
        </Text>
        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => void fetchProfile()}
          accessibilityRole="button"
          accessibilityLabel={translate("Retry loading profile")}
        >
          <Text style={styles.retryLabel}>{translate("Retry")}</Text>
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
        {profile.follows_you === true ? (
          <View style={styles.followsYouBadge}>
            <Text style={styles.followsYouBadgeText}>
              {translate("Follows you")}
            </Text>
          </View>
        ) : null}
        <Text style={styles.metaLine}>
          {formatJoinedLabel(profile.created_at)}
        </Text>
        {profile.home_region ? (
          <View style={styles.metaInline}>
            <Icon name="map-marker-outline" size={14} color={t.dim} />
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
              profile.is_following
                ? translate("Unfollow rider")
                : translate("Follow rider")
            }
          >
            {followPending ? (
              <ActivityIndicator
                size="small"
                color={profile.is_following ? t.fg : t.invFg}
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
                  color={profile.is_following ? t.fg : t.invFg}
                />
                <Text
                  style={[
                    styles.followLabel,
                    profile.is_following ? styles.followingLabel : null,
                  ]}
                >
                  {profile.is_following
                    ? translate("Following")
                    : translate("Follow")}
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
          label={translate("Followers")}
          value={formatCount(profile.follower_count)}
          onPress={() =>
            navigation.push("Followers", {
              userId: profile.id,
              displayName: profile.display_name,
            })
          }
          accessibilityLabel={translate(
            "{count, plural, one {# follower} other {# followers}}, open list",
            {
              count: profile.follower_count,
            },
          )}
        />
        <StatTile
          label={translate("Following")}
          value={formatCount(profile.following_count)}
          onPress={() =>
            navigation.push("Following", {
              userId: profile.id,
              displayName: profile.display_name,
            })
          }
          accessibilityLabel={translate(
            "Following {count, plural, one {# rider} other {# riders}}, open list",
            { count: profile.following_count },
          )}
        />
        <StatTile
          label={translate("Badges")}
          value={formatCount(earnedBadges.length)}
        />
      </View>

      <SharedRidesSection
        userId={profile.id}
        isSelf={profile.is_self}
        displayName={profile.display_name}
      />

      <View style={styles.badgesCard}>
        <Text style={styles.cardTitle}>{translate("Badges earned")}</Text>
        {earnedBadges.length === 0 ? (
          <Text style={styles.emptyHint}>
            {translate("{name} hasn't earned any badges yet.", {
              name: profile.display_name,
            })}
          </Text>
        ) : (
          <View style={styles.badgeGrid}>
            {earnedBadges.map((badge) => {
              const copy = badgeCopy(badge.key);
              return (
                <View key={badge.key} style={styles.badgePill}>
                  <Icon name="trophy-outline" size={14} color={t.accent} />
                  <Text style={styles.badgeName}>{copy.name}</Text>
                  {badge.tier ? (
                    <Text style={styles.badgeTier}>
                      {tierLabel(badge.tier)}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: t.bg },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s10,
  },
  empty: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  errorTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  header: {
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  displayName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 24,
    fontWeight: "800",
    marginTop: brandSpacing.s2,
  },
  followsYouBadge: {
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: brandRadii.pill,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: 2,
  },
  followsYouBadgeText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  metaLine: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  metaInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
  },
  bio: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    marginTop: brandSpacing.s2,
    lineHeight: 20,
  },
  // "Follow" reads as the solid ink primary action; "Following" flips to an
  // outlined ink state.
  followButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s5,
    minHeight: 44,
    paddingVertical: brandSpacing.s2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
    marginTop: brandSpacing.s3,
    minWidth: 140,
    justifyContent: "center",
  },
  followingButton: {
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  disabled: {
    opacity: 0.6,
  },
  followLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  followingLabel: {
    color: t.fg,
  },
  statsRow: {
    flexDirection: "row",
    gap: brandSpacing.s3,
  },
  badgesCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
    gap: brandSpacing.s3,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  emptyHint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  badgeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s1,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s1,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
    borderWidth: 1,
    borderColor: t.line,
  },
  badgeName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  badgeTier: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
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
