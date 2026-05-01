/**
 * ChallengesScreen — US-29 (gamification challenges).
 *
 * Lists active challenges from `GET /challenges`. Tapping a card expands
 * to show the leaderboard, the rider's progress (if joined), and a
 * Join button. Joining is optimistic — we re-fetch the detail rather
 * than splicing locally so the leaderboard count + my_progress stay
 * authoritative.
 *
 * Pull-to-refresh re-runs the list fetch. Empty state is shown when no
 * challenges are currently running.
 */

import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useState,
} from "react";
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

type IconName = ComponentProps<typeof Icon>["name"];
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import type {
  Challenge,
  ChallengeDetail,
  ChallengeLeaderboardEntry,
} from "@/types";
import {
  challengePercent,
  formatChallengeProgress,
  formatTimeRemaining,
  metricUnit,
  rankChallenges,
} from "./AchievementsScreen.helpers";

export default function ChallengesScreen() {
  const myUserId = useAuthStore((s) => s.user?.id ?? null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [details, setDetails] = useState<Record<string, ChallengeDetail>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingJoinId, setPendingJoinId] = useState<string | null>(null);

  const load = useCallback(async (initial: boolean) => {
    if (!initial) setIsRefreshing(true);
    try {
      const data = await api.listChallenges();
      setChallenges(data);
      setErrorMessage(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Couldn't load challenges.";
      setErrorMessage(message);
    } finally {
      if (!initial) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const loadDetail = useCallback(async (challengeId: string) => {
    try {
      const detail = await api.getChallenge(challengeId);
      setDetails((prev) => ({ ...prev, [challengeId]: detail }));
    } catch {
      // Detail fetch failure leaves the row collapsed-but-expanded; the
      // list-level data is still accurate, so we don't surface a screen-
      // level error. Tap-again retries.
    }
  }, []);

  const handleToggle = useCallback(
    (challengeId: string) => {
      const next = expandedId === challengeId ? null : challengeId;
      setExpandedId(next);
      if (next && !details[next]) {
        void loadDetail(next);
      }
    },
    [expandedId, details, loadDetail],
  );

  const handleJoin = useCallback(
    async (challengeId: string) => {
      setPendingJoinId(challengeId);
      try {
        await api.joinChallenge(challengeId);
        await loadDetail(challengeId);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Couldn't join this challenge. Try again.";
        Alert.alert("Couldn't join", message);
      } finally {
        setPendingJoinId(null);
      }
    },
    [loadDetail],
  );

  if (challenges === null && errorMessage === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (errorMessage && challenges === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyTitle}>Can't load challenges</Text>
        <Text style={styles.emptyBody}>{errorMessage}</Text>
      </View>
    );
  }

  const ranked = rankChallenges(challenges ?? []);

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
      {ranked.length === 0 ? (
        <EmptyState />
      ) : (
        ranked.map((c) => (
          <ChallengeCard
            key={c.id}
            challenge={c}
            detail={details[c.id]}
            expanded={expandedId === c.id}
            onToggle={() => handleToggle(c.id)}
            onJoin={() => void handleJoin(c.id)}
            isJoining={pendingJoinId === c.id}
            myUserId={myUserId}
          />
        ))
      )}
    </ScrollView>
  );
}

// ── Sub-components ──

function EmptyState() {
  return (
    <View style={styles.emptyCard}>
      <Icon name="flag-outline" size={48} color={colors.primary} />
      <Text style={styles.emptyTitle}>No active challenges</Text>
      <Text style={styles.emptyBody}>
        Check back soon — new challenges launch regularly.
      </Text>
    </View>
  );
}

function ChallengeCard({
  challenge,
  detail,
  expanded,
  onToggle,
  onJoin,
  isJoining,
  myUserId,
}: {
  challenge: Challenge;
  detail: ChallengeDetail | undefined;
  expanded: boolean;
  onToggle: () => void;
  onJoin: () => void;
  isJoining: boolean;
  myUserId: string | null;
}) {
  const joined = detail ? detail.my_progress !== null : false;
  const percent = detail
    ? challengePercent(detail.my_progress ?? 0, challenge.target)
    : 0;
  const unit = metricUnit(challenge.metric);

  return (
    <View style={styles.card}>
      <TouchableOpacity
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={
          expanded
            ? `Collapse ${challenge.title} details`
            : `Expand ${challenge.title} details`
        }
        style={styles.cardHeader}
      >
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{challenge.title}</Text>
          <Icon
            name={expanded ? "chevron-up" : "chevron-down"}
            size={22}
            color={colors.textTertiary}
          />
        </View>
        <Text style={styles.cardBody}>{challenge.description}</Text>
        <View style={styles.metaRow}>
          <MetaPill icon="target" label={`${challenge.target} ${unit}`} />
          <MetaPill
            icon="account-multiple"
            label={`${challenge.participant_count} riders`}
          />
          <MetaPill
            icon="clock-outline"
            label={formatTimeRemaining(challenge.ends_at)}
          />
        </View>
        {joined && detail ? (
          <>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${percent}%` }]} />
            </View>
            <Text style={styles.progressLabel}>
              {formatChallengeProgress(
                detail.my_progress ?? 0,
                challenge.target,
                challenge.metric,
              )}{" "}
              · {percent}%{detail.my_completed ? " · COMPLETE" : ""}
            </Text>
          </>
        ) : null}
      </TouchableOpacity>

      {expanded ? (
        <View style={styles.expanded}>
          {!detail ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              {!joined ? (
                <TouchableOpacity
                  onPress={onJoin}
                  disabled={isJoining}
                  style={[
                    styles.joinBtn,
                    isJoining ? styles.joinBtnDisabled : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Join challenge ${challenge.title}`}
                >
                  {isJoining ? (
                    <ActivityIndicator color={colors.textInverse} />
                  ) : (
                    <>
                      <Icon
                        name="flag-checkered"
                        size={18}
                        color={colors.textInverse}
                      />
                      <Text style={styles.joinLabel}>Join challenge</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : null}

              <Leaderboard
                entries={detail.leaderboard}
                target={challenge.target}
                unit={unit}
                myUserId={myUserId}
              />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function MetaPill({ icon, label }: { icon: IconName; label: string }) {
  return (
    <View style={styles.metaPill}>
      <Icon name={icon} size={14} color={colors.textSecondary} />
      <Text style={styles.metaLabel}>{label}</Text>
    </View>
  );
}

function Leaderboard({
  entries,
  target,
  unit,
  myUserId,
}: {
  entries: ChallengeLeaderboardEntry[];
  target: number;
  unit: string;
  myUserId: string | null;
}) {
  if (entries.length === 0) {
    return (
      <Text style={styles.emptyLeaderboard}>
        No leaderboard yet — be first to join.
      </Text>
    );
  }
  // Cap to 5 rows visually so the card stays compact; the spec asks for
  // a "small" leaderboard, not the full list.
  const top = entries.slice(0, 5);
  return (
    <View style={styles.leaderboard}>
      <Text style={styles.leaderboardTitle}>Leaderboard</Text>
      {top.map((e) => {
        const isMe = myUserId !== null && e.user_id === myUserId;
        const percent = challengePercent(e.progress, target);
        return (
          <View
            key={e.user_id}
            style={[styles.lbRow, isMe ? styles.lbRowMe : null]}
          >
            <Text style={styles.lbRank}>#{e.rank}</Text>
            <Text style={[styles.lbName, isMe ? styles.lbNameMe : null]}>
              {e.display_name}
              {isMe ? " (you)" : ""}
            </Text>
            <Text style={styles.lbProgress}>
              {Math.round(e.progress)} {unit} · {percent}%
              {e.completed ? " ✓" : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ── Test re-exports ──

export const __test = {
  ChallengeCard,
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
  emptyCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xxl,
    alignItems: "center",
    gap: spacing.sm,
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
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  cardHeader: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    flexShrink: 1,
  },
  cardBody: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.bgInput,
  },
  metaLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bgInput,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  progressLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  expanded: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  joinBtnDisabled: {
    opacity: 0.6,
  },
  joinLabel: {
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
  },
  emptyLeaderboard: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontStyle: "italic",
  },
  leaderboard: {
    gap: spacing.sm,
  },
  leaderboardTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: fontWeight.semibold,
  },
  lbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 6,
  },
  lbRowMe: {
    backgroundColor: colors.primaryAlpha08,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  lbRank: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    width: 32,
  },
  lbName: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },
  lbNameMe: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  lbProgress: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});
