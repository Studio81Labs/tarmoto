/**
 * BadgesScreen — US-28 (gamification badges).
 *
 * Renders a grid of every badge defined on the backend, split into
 * "earned" and "locked" sections. Each card shows the rider's current
 * tier (bronze/silver/gold), a progress bar toward the next milestone,
 * and the raw stat number for context.
 *
 * The screen is a leaf inside the Achievements stack — pull-to-refresh
 * re-runs the same `/users/:id/badges` fetch the initial mount made.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import type { UserBadge } from "@/types";
import {
  nextMilestone,
  progressToNext,
  tierColor,
  tierRank,
} from "./AchievementsScreen.helpers";

export default function BadgesScreen() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [badges, setBadges] = useState<UserBadge[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(
    async (initial: boolean) => {
      if (!userId) {
        setErrorMessage("Sign in to see your badges.");
        return;
      }
      if (!initial) setIsRefreshing(true);
      try {
        // POST /badges/check first so newly-earned tiers are reflected on
        // this view immediately rather than only after the rider's next
        // ride. The check is a server-side no-op when there's nothing new
        // and is cheap relative to the LIST that follows.
        await api.checkBadges().catch(() => undefined);
        const data = await api.listUserBadges(userId);
        setBadges(data);
        setErrorMessage(null);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Couldn't load badges.";
        setErrorMessage(message);
      } finally {
        if (!initial) setIsRefreshing(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  if (badges === null && errorMessage === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (errorMessage && badges === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyTitle}>Can't load badges</Text>
        <Text style={styles.emptyBody}>{errorMessage}</Text>
      </View>
    );
  }

  const list = badges ?? [];
  const earned = list.filter((b) => b.tier !== null);
  const locked = list.filter((b) => b.tier === null);

  // Empty state: no earned badges yet AND the rider hasn't even started
  // rolling progress on any of them. The CTA points back at the live ride
  // surface — that's the only place a stat ticks up from zero.
  const isBrandNewRider =
    earned.length === 0 && list.every((b) => (b.progress.current ?? 0) === 0);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => void load(false)}
          tintColor={colors.primary}
        />
      }
    >
      {isBrandNewRider ? (
        <EmptyState />
      ) : (
        <>
          {earned.length > 0 ? (
            <Section title={`Earned (${earned.length})`}>
              {earned
                .slice()
                .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
                .map((b) => (
                  <BadgeRow key={b.key} badge={b} />
                ))}
            </Section>
          ) : null}
          {locked.length > 0 ? (
            <Section title={`In progress (${locked.length})`}>
              {locked.map((b) => (
                <BadgeRow key={b.key} badge={b} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

// ── Sub-components ──

function EmptyState() {
  return (
    <View style={styles.emptyCard}>
      <Icon name="trophy-outline" size={48} color={colors.primary} />
      <Text style={styles.emptyTitle}>No badges yet</Text>
      <Text style={styles.emptyBody}>
        Earn your first badge by completing a ride.
      </Text>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function BadgeRow({ badge }: { badge: UserBadge }) {
  const next = nextMilestone(badge);
  const ratio = progressToNext(badge);
  const earned = badge.tier !== null;
  return (
    <View
      style={styles.badgeCard}
      accessibilityLabel={
        earned
          ? `${badge.name}, ${badge.tier} tier earned`
          : `${badge.name}, locked, ${Math.round(ratio * 100)}% to ${next?.tier}`
      }
    >
      <View
        style={[
          styles.badgeIconWrap,
          { backgroundColor: tierColor(badge.tier) + "33" },
        ]}
      >
        <Icon
          name={earned ? "trophy" : "trophy-outline"}
          size={28}
          color={tierColor(badge.tier)}
        />
      </View>
      <View style={styles.badgeBody}>
        <View style={styles.badgeHeaderRow}>
          <Text style={styles.badgeName}>{badge.name}</Text>
          {earned ? (
            <View
              style={[
                styles.tierPill,
                { backgroundColor: tierColor(badge.tier) },
              ]}
            >
              <Text style={styles.tierLabel}>
                {(badge.tier ?? "").toUpperCase()}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.badgeDesc}>{badge.description}</Text>
        {next ? (
          <>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.round(ratio * 100)}%`,
                    backgroundColor: tierColor(next.tier),
                  },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {Math.round(badge.progress.current)} / {Math.round(next.target)} →{" "}
              <Text style={{ color: tierColor(next.tier) }}>
                {next.tier.toUpperCase()}
              </Text>
            </Text>
          </>
        ) : (
          <Text style={styles.maxedLabel}>Maxed · gold tier reached</Text>
        )}
      </View>
    </View>
  );
}

// ── Test re-exports ──

export const __test = {
  BadgeRow,
};

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.md,
  },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: "center",
    lineHeight: 22,
  },
  emptyCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xxl,
    alignItems: "center",
    gap: spacing.sm,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  sectionBody: {
    gap: spacing.sm,
  },
  badgeCard: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeBody: {
    flex: 1,
    gap: 6,
  },
  badgeHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  badgeName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    flexShrink: 1,
  },
  badgeDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  tierPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  tierLabel: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.5,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bgInput,
    overflow: "hidden",
    marginTop: 4,
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  maxedLabel: {
    color: colors.success,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});
