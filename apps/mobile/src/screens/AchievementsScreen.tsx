/**
 * AchievementsScreen — US-28 / US-29 / US-30 hub.
 *
 * Acts as the entry point into the three gamification surfaces and shows
 * a quick stat summary so the rider has a reason to land here. The
 * sub-screens (Badges, Challenges, Personal road map) push from this
 * hub via the Profile stack.
 */

import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";

type IconName = ComponentProps<typeof Icon>["name"];
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import type { UserBadge, ExplorationStats } from "@/types";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import { tierRank } from "./AchievementsScreen.helpers";

const t = brandColorsLight;

type AchievementsNav = NativeStackNavigationProp<
  ProfileStackParamList,
  "Achievements"
>;

interface HubSnapshot {
  earnedBadges: number;
  totalBadges: number;
  topTier: string | null;
  activeChallenges: number;
  exploration: ExplorationStats | null;
}

export default function AchievementsScreen() {
  const navigation = useNavigation<AchievementsNav>();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(
    async (initial: boolean) => {
      if (!initial) setIsRefreshing(true);
      // `allSettled` so a transient failure on one source (e.g. challenges
      // 503ing) doesn't blank the other two. We then differentiate the
      // "all three failed" case from "everything is empty" — the former
      // surfaces an error banner, the latter is just a brand-new rider.
      const [badgesResult, challengesResult, explorationResult] =
        await Promise.allSettled([
          userId
            ? api.listUserBadges(userId)
            : Promise.resolve([] as UserBadge[]),
          api.listChallenges(),
          api.getExplorationStats(),
        ]);

      const badges =
        badgesResult.status === "fulfilled" ? badgesResult.value : [];
      const challenges =
        challengesResult.status === "fulfilled" ? challengesResult.value : [];
      const exploration =
        explorationResult.status === "fulfilled"
          ? explorationResult.value
          : null;

      const allFailed =
        badgesResult.status === "rejected" &&
        challengesResult.status === "rejected" &&
        explorationResult.status === "rejected";

      if (allFailed) {
        const reason = (badgesResult as PromiseRejectedResult).reason;
        setErrorMessage(
          reason instanceof Error
            ? reason.message
            : "Couldn't load achievements.",
        );
        if (!initial) setIsRefreshing(false);
        return;
      }

      const earned = badges.filter((b) => b.tier !== null);
      const topTier = earned
        .map((b) => b.tier)
        .reduce<string | null>((best, t) => {
          if (!t) return best;
          if (!best) return t;
          return tierRank(t) > tierRank(best) ? t : best;
        }, null);

      setSnapshot({
        earnedBadges: earned.length,
        totalBadges: badges.length,
        topTier,
        activeChallenges: challenges.length,
        exploration,
      });
      // Soft warning when only some sources failed: the banner stays
      // visible alongside the populated cards so the rider knows the
      // numbers may be stale, but the working surfaces still render.
      const someFailed =
        badgesResult.status === "rejected" ||
        challengesResult.status === "rejected" ||
        explorationResult.status === "rejected";
      setErrorMessage(
        someFailed ? "Some achievements couldn't load. Pull to refresh." : null,
      );
      if (!initial) setIsRefreshing(false);
    },
    [userId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => void load(false)}
          tintColor={t.fg}
        />
      }
    >
      <Text style={styles.title}>Achievements</Text>
      <Text style={styles.subtitle}>
        Track badges, take on challenges, and see how much of the road network
        you've covered.
      </Text>

      {errorMessage ? (
        <Text style={styles.errorBanner}>{errorMessage}</Text>
      ) : null}

      <HubCard
        icon="trophy"
        title="Badges"
        body={
          snapshot
            ? `${snapshot.earnedBadges} of ${snapshot.totalBadges} earned${
                snapshot.topTier
                  ? ` · ${snapshot.topTier.toUpperCase()} tier reached`
                  : ""
              }`
            : "Loading…"
        }
        onPress={() => navigation.navigate("Badges")}
      />

      <HubCard
        icon="flag-checkered"
        title="Challenges"
        body={
          snapshot
            ? snapshot.activeChallenges > 0
              ? `${snapshot.activeChallenges} active challenge${
                  snapshot.activeChallenges === 1 ? "" : "s"
                }`
              : "No active challenges right now"
            : "Loading…"
        }
        onPress={() => navigation.navigate("Challenges")}
      />

      <HubCard
        icon="map-marker-path"
        title="Personal road map"
        body={
          snapshot?.exploration
            ? `${snapshot.exploration.percent_explored.toFixed(1)}% explored · ${snapshot.exploration.ridden_segments} of ${snapshot.exploration.total_segments} segments ridden`
            : "See ridden vs unridden roads"
        }
        onPress={() => navigation.navigate("PersonalRoadMap")}
      />
    </ScrollView>
  );
}

// ── Sub-components ──

function HubCard({
  icon,
  title,
  body,
  onPress,
}: {
  icon: IconName;
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
    >
      <View style={styles.cardIcon}>
        <Icon name={icon} size={22} color={t.fg} />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardBodyText}>{body}</Text>
      </View>
      <Icon name="chevron-right" size={22} color={t.faint} />
    </TouchableOpacity>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s8,
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
  errorBanner: {
    color: statusFg.warning,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontStyle: "italic",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    minHeight: 44,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: t.raised2,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  cardBodyText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
});
