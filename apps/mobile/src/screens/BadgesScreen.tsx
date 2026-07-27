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
import { Icon } from "@/components/Icon";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import type { UserBadge } from "@/types";
import {
  badgeCopy,
  nextMilestone,
  progressToNext,
  tierColor,
  tierLabel,
  tierRank,
} from "./AchievementsScreen.helpers";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation, useI18n } from "@/i18n/I18nProvider";
import { formatDisplayUpperCase } from "@tarmoto/shared";
import { useFormat } from "@/format/FormatProvider";

const t = brandColorsLight;

export default function BadgesScreen() {
  const translate = useTranslation();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [badges, setBadges] = useState<UserBadge[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(
    async (initial: boolean) => {
      if (!userId) {
        setErrorMessage(translate("Sign in to see your badges."));
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
        const message = getUserFacingErrorMessage(
          err,
          translate("Couldn't load badges."),
        );
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
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (errorMessage && badges === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={t.dim} />
        <Text style={styles.emptyTitle}>{translate("Can't load badges")}</Text>
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
          tintColor={t.fg}
        />
      }
    >
      {isBrandNewRider ? (
        <EmptyState />
      ) : (
        <>
          {earned.length > 0 ? (
            <Section
              title={translate("Earned ({value0})", { value0: earned.length })}
            >
              {earned
                .slice()
                .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
                .map((b) => (
                  <BadgeRow key={b.key} badge={b} />
                ))}
            </Section>
          ) : null}
          {locked.length > 0 ? (
            <Section
              title={translate("In progress ({value0})", {
                value0: locked.length,
              })}
            >
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
  const translate = useTranslation();
  return (
    <View style={styles.emptyCard}>
      <Icon name="trophy-outline" size={48} color={ACCENT_DARK} />
      <Text style={styles.emptyTitle}>{translate("No badges yet")}</Text>
      <Text style={styles.emptyBody}>
        {translate("Earn your first badge by completing a ride.")}
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
  const format = useFormat();
  const translate = useTranslation();
  const { locale } = useI18n();
  const copy = badgeCopy(badge.key);
  const next = nextMilestone(badge);
  const ratio = progressToNext(badge);
  const earned = badge.tier !== null;
  return (
    <View
      style={styles.badgeCard}
      accessibilityLabel={
        earned
          ? translate("{name}, {tier} tier earned", {
              name: copy.name,
              tier: tierLabel(badge.tier ?? ""),
            })
          : translate("{name}, locked, {progress} to {nextTier}", {
              name: copy.name,
              progress: format.percent(ratio),
              nextTier: tierLabel(next?.tier ?? ""),
            })
      }
    >
      <View
        style={[
          styles.badgeIconWrap,
          // The metallic tier colour is the badge vocabulary — kept as a
          // solid disc fill (earned) with an ink trophy on top, since silver
          // (#C0C0C0) and gold (#FFD700) fail contrast as a glyph/text colour
          // on cream. Locked badges read as a neutral cream disc.
          { backgroundColor: earned ? tierColor(badge.tier) : t.raised2 },
        ]}
      >
        <Icon
          name={earned ? "trophy" : "trophy-outline"}
          size={28}
          color={earned ? t.fg : t.dim}
        />
      </View>
      <View style={styles.badgeBody}>
        <View style={styles.badgeHeaderRow}>
          <Text style={styles.badgeName}>{copy.name}</Text>
          {earned ? (
            <View
              style={[
                styles.tierPill,
                { backgroundColor: tierColor(badge.tier) },
              ]}
            >
              <Text style={styles.tierLabel}>
                {formatDisplayUpperCase(tierLabel(badge.tier ?? ""), locale)}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.badgeDesc}>{copy.description}</Text>
        {next ? (
          <>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  // ACCENT_DARK reads as the "active progress" fill and clears
                  // 3:1 on the sunken track — the next tier is named in the
                  // label below, so the bar doesn't need the pale metallic.
                  { width: `${Math.round(ratio * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {translate("{current} / {target} → {tier}", {
                current: format.integer(badge.progress.current),
                target: format.integer(next.target),
                tier: formatDisplayUpperCase(tierLabel(next.tier), locale),
              })}
            </Text>
          </>
        ) : (
          <Text style={styles.maxedLabel}>
            {translate("Maxed · gold tier reached")}
          </Text>
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
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    paddingBottom: brandSpacing.s8,
  },
  centered: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  emptyTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 18,
    fontWeight: "700",
    marginTop: brandSpacing.s3,
  },
  emptyBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  emptyCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s6,
    alignItems: "center",
    gap: brandSpacing.s2,
  },
  section: {
    gap: brandSpacing.s2,
  },
  sectionTitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  sectionBody: {
    gap: brandSpacing.s2,
  },
  badgeCard: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
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
    gap: brandSpacing.s2,
  },
  badgeName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  badgeDesc: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  tierPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: brandRadii.sm,
  },
  tierLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: t.sunken,
    overflow: "hidden",
    marginTop: 4,
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: ACCENT_DARK,
  },
  progressLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  maxedLabel: {
    color: statusFg.success,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
});
