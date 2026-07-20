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
import { Icon } from "@/components/Icon";

type IconName = ComponentProps<typeof Icon>["name"];
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import {
  ACCENT_DARK,
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
} from "@/theme/brand";
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
import { t as translate } from "@/i18n";

const t = brandColorsLight;

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
        Alert.alert(translate("Couldn't join"), message);
      } finally {
        setPendingJoinId(null);
      }
    },
    [loadDetail],
  );

  if (challenges === null && errorMessage === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={t.fg} />
      </View>
    );
  }

  if (errorMessage && challenges === null) {
    return (
      <View style={styles.centered}>
        <Icon name="wifi-off" size={40} color={t.dim} />
        <Text style={styles.emptyTitle}>
          {translate("Can't load challenges")}
        </Text>
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
          tintColor={t.fg}
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
      <Icon name="flag-outline" size={48} color={ACCENT_DARK} />
      <Text style={styles.emptyTitle}>{translate("No active challenges")}</Text>
      <Text style={styles.emptyBody}>
        {translate("Check back soon — new challenges launch regularly.")}
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
            ? translate("Collapse {value0} details", {
                value0: challenge.title,
              })
            : translate("Expand {value0} details", { value0: challenge.title })
        }
        style={styles.cardHeader}
      >
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{challenge.title}</Text>
          <Icon
            name={expanded ? "chevron-up" : "chevron-down"}
            size={22}
            color={t.faint}
          />
        </View>
        <Text style={styles.cardBody}>{challenge.description}</Text>
        <View style={styles.metaRow}>
          <MetaPill
            icon="target"
            label={translate("{value0} {value1}", {
              value0: challenge.target,
              value1: unit,
            })}
          />
          <MetaPill
            icon="account-multiple"
            label={translate(
              "{count, plural, one {# rider} other {# riders}}",
              {
                count: challenge.participant_count,
              },
            )}
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
              {detail.my_completed
                ? translate("{progress} · {percent}% · COMPLETE", {
                    progress: formatChallengeProgress(
                      detail.my_progress ?? 0,
                      challenge.target,
                      challenge.metric,
                    ),
                    percent,
                  })
                : translate("{progress} · {percent}%", {
                    progress: formatChallengeProgress(
                      detail.my_progress ?? 0,
                      challenge.target,
                      challenge.metric,
                    ),
                    percent,
                  })}
            </Text>
          </>
        ) : null}
      </TouchableOpacity>

      {expanded ? (
        <View style={styles.expanded}>
          {!detail ? (
            <ActivityIndicator color={t.fg} />
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
                  accessibilityLabel={translate("Join challenge {value0}", {
                    value0: challenge.title,
                  })}
                >
                  {isJoining ? (
                    <ActivityIndicator color={t.invFg} />
                  ) : (
                    <>
                      <Icon name="flag-checkered" size={18} color={t.invFg} />
                      <Text style={styles.joinLabel}>
                        {translate("Join challenge")}
                      </Text>
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
      <Icon name={icon} size={14} color={t.dim} />
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
        {translate("No leaderboard yet — be first to join.")}
      </Text>
    );
  }
  // Cap to 5 rows visually so the card stays compact; the spec asks for
  // a "small" leaderboard, not the full list.
  const top = entries.slice(0, 5);
  return (
    <View style={styles.leaderboard}>
      <Text style={styles.leaderboardTitle}>{translate("Leaderboard")}</Text>
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
              {isMe
                ? translate("{name} (you)", { name: e.display_name })
                : e.display_name}
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
  emptyCard: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s6,
    alignItems: "center",
    gap: brandSpacing.s2,
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
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    overflow: "hidden",
  },
  cardHeader: {
    padding: brandSpacing.s4,
    gap: brandSpacing.s2,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: brandSpacing.s2,
  },
  cardTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
    flexShrink: 1,
  },
  cardBody: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: brandSpacing.s2,
    marginTop: brandSpacing.s2,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.raised2,
  },
  metaLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: t.sunken,
    overflow: "hidden",
    marginTop: brandSpacing.s2,
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
    marginTop: 2,
  },
  expanded: {
    paddingHorizontal: brandSpacing.s4,
    paddingBottom: brandSpacing.s4,
    gap: brandSpacing.s3,
    borderTopWidth: 1,
    borderTopColor: t.line,
    paddingTop: brandSpacing.s3,
  },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: brandSpacing.s2,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  joinBtnDisabled: {
    opacity: 0.6,
  },
  joinLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  emptyLeaderboard: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  leaderboard: {
    gap: brandSpacing.s2,
  },
  leaderboardTitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  lbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    paddingVertical: 6,
  },
  lbRowMe: {
    backgroundColor: t.raised2,
    paddingHorizontal: brandSpacing.s2,
    borderRadius: brandRadii.sm,
  },
  lbRank: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 13,
    fontWeight: "700",
    width: 32,
  },
  lbName: {
    flex: 1,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  lbNameMe: {
    color: ACCENT_DARK,
    fontWeight: "700",
  },
  lbProgress: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    fontWeight: "600",
  },
});
