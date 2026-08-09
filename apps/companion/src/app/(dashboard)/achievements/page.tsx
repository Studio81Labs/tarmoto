"use client";

import { useI18n, useTranslation } from "@/i18n/I18nProvider";
import {
  getUserFacingErrorMessage,
  type EnglishMessageKey,
  type Translate,
} from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Award,
  Compass,
  Flag,
  Flame,
  Heart,
  Lock,
  Medal,
  Moon,
  Mountain,
  Sparkles,
  Star,
  Target,
  Trophy,
  Users,
  Wind,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import {
  formatDisplayLowerCase,
  formatDisplayUpperCase,
  formatSplitValueUnitRange,
  type Formatters,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import type { Badge as BadgeType } from "@/lib/types";
import { usersApi } from "@/lib/api";
import { useFormat } from "@/format/FormatProvider";
import {
  Button,
  PageHeader as DashboardPageHeader,
  Mono,
  SegmentedControl,
  Skeleton,
  Stamp,
} from "@tarmoto/ui";
import Link from "next/link";
import { UserAvatar } from "@/components/UserAvatar";
import {
  activeChallenges,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  labelForDimension,
  pickNextMilestone,
  seasonalProgress,
  progressionTierLabel,
  LEADERBOARD_DIMENSION_KEYS,
  type Challenge,
  type ChallengeCategory,
  type ChallengeMeta,
  type GamificationSnapshot,
  type LeaderboardDimensionKey,
  type LeaderboardMetric,
  type MilestoneProgress,
  type RegionalDimensionLeaderboard,
  type RegionalLeaderboardEntry,
  type RegionalLeaderboards,
  type SeasonalChallenge,
} from "@/lib/gamification";
import { SEASON_LABELS, translateKnownLabel } from "@/i18n/domainLabels";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import {
  fetchGamificationSnapshot,
  fetchProgression,
  fetchRegionalLeaderboards,
  joinChallenge,
  type RiderProgression,
} from "@/lib/gamification-fetch";
const BADGE_ICONS: Record<string, LucideIcon> = {
  compass: Compass,
  mountain: Mountain,
  moon: Moon,
  wind: Wind,
  trophy: Trophy,
  "alert-triangle": AlertTriangle,
  star: Star,
  flame: Flame,
  medal: Medal,
};
const CATEGORY_STYLE: Record<
  ChallengeCategory,
  {
    label: EnglishMessageKey;
    icon: LucideIcon;
    accent: string;
  }
> = {
  distance: { label: "Distance", icon: Flag, accent: "text-accent" },
  discovery: { label: "Discovery", icon: Compass, accent: "text-violet-600" },
  safety: {
    label: "Safety",
    icon: AlertTriangle,
    accent: "text-amber-700",
  },
  social: { label: "Social", icon: Users, accent: "text-pink-600" },
  seasonal: { label: "Seasonal", icon: Sparkles, accent: "text-emerald-700" },
};
// Every loaded state is tagged with the userId it represents so the render
// can refuse to show snapshot data for a user that is no longer signed in.
// Without this, switching accounts could briefly leak the previous user's
// badges/challenges between the prop change and the refetch completing.
type LoadState =
  | {
      status: "idle";
    }
  | {
      status: "loading";
      userId: string;
    }
  | {
      status: "ready";
      userId: string;
      snapshot: GamificationSnapshot;
    }
  | {
      status: "error";
      userId: string;
      message: string;
    };
export default function AchievementsPage() {
  const t = useTranslation();
  const format = useFormat();
  const userId = useAuthStore((s) => s.user?.id);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // Tracks every join currently in flight. Using a set instead of a single
  // string lets two challenges be joined concurrently without one's
  // completion stripping the other's spinner.
  const [joiningIds, setJoiningIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [joinError, setJoinError] = useState<string | null>(null);
  // The currently-active fetch controller. Stored in a ref so that retries,
  // post-join silent refetches, and a userId change can all abort whatever
  // is in flight without prop-drilling a signal through every caller.
  const controllerRef = useRef<AbortController | null>(null);
  // `silent` keeps the current `ready` snapshot mounted while a refetch runs
  // in the background — used after a successful "Join challenge" so the
  // dashboard doesn't flash to the page-level skeleton; the button keeps
  // its own spinner via `joiningIds`. Initial loads still set `loading` so
  // the user sees the skeleton on first render. A silent refetch that
  // fails rethrows so the caller can decide what to surface — see
  // `handleJoin` for why a post-join refetch failure must NOT be reported
  // as a join failure. Each call aborts the previous controller so retries
  // and post-join refetches inherit cancellation on user switch.
  //
  // The first guard stops a stale closure (e.g. an in-flight `handleJoin`
  // that resolved after the user signed in as someone else) from
  // aborting the new user's initial load. We compare `uid` against the
  // store rather than the prop because the prop is captured in the
  // closure at useCallback-time and `useAuthStore.getState()` always
  // reflects the live signed-in user.
  const load = useCallback(
    async (
      uid: string,
      opts: {
        silent?: boolean;
      } = {},
    ) => {
      const currentUid = useAuthStore.getState().user?.id;
      if (currentUid !== uid) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { silent = false } = opts;
      if (!silent) setState({ status: "loading", userId: uid });
      try {
        const snapshot = await fetchGamificationSnapshot(uid, {
          format,
          signal: controller.signal,
          translate: t,
        });
        if (controller.signal.aborted) return;
        setState({ status: "ready", userId: uid, snapshot });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (silent) throw err;
        setState({
          status: "error",
          userId: uid,
          message: getUserFacingErrorMessage(
            err,
            t("Could not load achievements"),
          ),
        });
      }
    },
    [t, format],
  );
  useEffect(() => {
    // The user changed (sign-in, sign-out, or account switch). Clear any
    // join-related state from the previous session so a stale error or
    // an orphaned spinner can't render on the new user's dashboard.
    setJoinError(null);
    setJoiningIds(new Set());
    if (!userId) {
      // Sign-out: cancel any in-flight fetch and drop the previous user's
      // snapshot so it can't render on the next frame.
      controllerRef.current?.abort();
      controllerRef.current = null;
      setState({ status: "idle" });
      return;
    }
    void load(userId);
    return () => {
      controllerRef.current?.abort();
    };
  }, [userId, load]);
  const handleJoin = useCallback(
    async (challengeId: string) => {
      if (!userId) return;
      setJoiningIds((prev) => {
        const next = new Set(prev);
        next.add(challengeId);
        return next;
      });
      setJoinError(null);
      try {
        await joinChallenge(challengeId, { translate: t });
      } catch (err) {
        // Only surface the error to the user that initiated the join.
        // If the rider switched accounts while the request was in flight,
        // the live signed-in user is no longer who clicked Join — writing
        // their previous error onto the new user's dashboard would be
        // confusing (the new user never tried to join anything).
        if (useAuthStore.getState().user?.id === userId) {
          setJoinError(
            getUserFacingErrorMessage(err, t("Could not join challenge.")),
          );
          setJoiningIds((prev) => {
            const next = new Set(prev);
            next.delete(challengeId);
            return next;
          });
        }
        return;
      }
      // Join succeeded — reflect that in the snapshot immediately so the
      // card flips to "Joined" without waiting on the refetch. The userId
      // tag guards against a user switch racing with a stale resolved
      // join: we only patch a snapshot that still belongs to the user we
      // joined for. Any failure of the silent refetch must NOT be
      // surfaced via `joinError`: the backend has already accepted the
      // join, and showing "Could not load badges" would make the user
      // think their join failed.
      setState((prev) =>
        prev.status === "ready" && prev.userId === userId
          ? {
              ...prev,
              snapshot: markChallengeJoined(prev.snapshot, challengeId),
            }
          : prev,
      );
      try {
        await load(userId, { silent: true });
      } catch {
        // The optimistic update keeps the dashboard consistent until the
        // next page visit refreshes it. Swallowing the error is correct —
        // the join itself succeeded.
      } finally {
        setJoiningIds((prev) => {
          const next = new Set(prev);
          next.delete(challengeId);
          return next;
        });
      }
    },
    [t, userId, load],
  );
  // Render-time guard: a snapshot tagged for a different user (because
  // the userId prop changed before the new fetch resolved) must NOT be
  // shown — fall through to the skeleton until the userId-effect kicks
  // off a fresh load.
  const stateForUser =
    state.status === "ready" && state.userId === userId
      ? state
      : state.status === "error" && state.userId === userId
        ? state
        : null;
  const showSkeleton = useDelayedLoading(Boolean(userId) && !stateForUser);
  if (!userId) {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7 animate-fade-in">
        <PageHeader />
        <EmptyCard
          icon={<Lock size={32} className="text-fg-mute" />}
          title={t("Sign in to see your achievements")}
          body={t(
            "Badges, challenges, and leaderboards appear once you're signed in.",
          )}
        />
      </div>
    );
  }
  if (!stateForUser) {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7 animate-fade-in space-y-8">
        <PageHeader />
        {showSkeleton && <AchievementsSkeleton />}
      </div>
    );
  }
  if (stateForUser.status === "error") {
    return (
      <div className="mx-auto w-full max-w-page p-4 md:p-7 animate-fade-in">
        <PageHeader />
        <ErrorCard
          message={stateForUser.message}
          onRetry={() => load(userId)}
        />
      </div>
    );
  }
  return (
    <Dashboard
      snapshot={stateForUser.snapshot}
      joiningIds={joiningIds}
      joinError={joinError}
      onJoin={handleJoin}
      format={format}
    />
  );
}
/**
 * Returns a snapshot with the named challenge optimistically flipped to
 * "joined" — used between a successful `POST /challenges/{id}/join` and
 * the silent refetch so the card immediately reflects the new state. The
 * participant count is bumped by one if the rider was not already a
 * participant. The refetch (or next page visit) reconciles with the
 * authoritative server state.
 */
function markChallengeJoined(
  snapshot: GamificationSnapshot,
  challengeId: string,
): GamificationSnapshot {
  const existing = snapshot.challengeMeta[challengeId];
  if (existing?.joined) return snapshot;
  return {
    ...snapshot,
    challengeMeta: {
      ...snapshot.challengeMeta,
      [challengeId]: {
        joined: true,
        participantCount: (existing?.participantCount ?? 0) + 1,
      },
    },
  };
}
function Dashboard({
  snapshot,
  joiningIds,
  joinError,
  onJoin,
  format,
}: {
  snapshot: GamificationSnapshot;
  joiningIds: ReadonlySet<string>;
  joinError: string | null;
  onJoin: (id: string) => void;
  format: Formatters;
}) {
  const t = useTranslation();
  const visibleChallenges = useMemo(
    () => activeChallenges(snapshot.challenges),
    [snapshot.challenges],
  );
  const nextMilestone = useMemo(
    () => pickNextMilestone(snapshot.milestones, snapshot.stats),
    [snapshot.milestones, snapshot.stats],
  );
  const earnedBadgeCount = snapshot.badges.filter((b) => b.earnedAt).length;
  return (
    <div className="mx-auto w-full max-w-page p-4 md:p-7 animate-fade-in space-y-8">
      <PageHeader />

      <TierHero
        earnedBadgeCount={earnedBadgeCount}
        activeCount={visibleChallenges.length}
        format={format}
      />

      {snapshot.seasonal && (
        <SeasonalBanner seasonal={snapshot.seasonal} format={format} />
      )}

      <section aria-labelledby="badges-heading">
        <SectionHeader
          id="badges-heading"
          icon={<Trophy size={18} strokeWidth={2} />}
          title={t("Badges")}
          counter={
            snapshot.badges.length > 0
              ? t("{earned} of {total} earned", {
                  earned: format.integer(earnedBadgeCount),
                  total: format.integer(snapshot.badges.length),
                })
              : undefined
          }
        />
        {snapshot.badges.length === 0 ? (
          <EmptyCard
            icon={<Award size={32} />}
            title={t("No badges yet")}
            body={t(
              "Ride, discover roads, or report hazards to start earning badges.",
            )}
          />
        ) : (
          <BadgeGrid badges={snapshot.badges} format={format} />
        )}
      </section>

      <section aria-labelledby="challenges-heading">
        <SectionHeader
          id="challenges-heading"
          icon={<Target size={18} strokeWidth={2} />}
          title={t("Active challenges")}
          counter={
            visibleChallenges.length > 0
              ? format.integer(visibleChallenges.length)
              : undefined
          }
        />
        {joinError && (
          <p
            className="mb-3 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-3 py-2 text-xs text-red-700"
            role="alert"
          >
            {joinError}
          </p>
        )}
        {visibleChallenges.length === 0 ? (
          <EmptyCard
            icon={<Target size={32} />}
            title={t("No challenges to join yet")}
            body={t(
              "New weekly challenges drop every Monday. Check back soon.",
            )}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
            {visibleChallenges.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                meta={snapshot.challengeMeta[challenge.id]}
                joining={joiningIds.has(challenge.id)}
                onJoin={onJoin}
                format={format}
              />
            ))}
          </div>
        )}
      </section>

      <RegionalLeaderboardsSection format={format} />

      {nextMilestone && (
        <section aria-labelledby="milestone-heading">
          <SectionHeader
            id="milestone-heading"
            icon={<Heart size={16} />}
            title={t("Next milestone")}
            subtitle={t("What you're working toward right now.")}
          />
          <MilestoneCard progress={nextMilestone} format={format} />
        </section>
      )}
    </div>
  );
}
function PageHeader() {
  const t = useTranslation();
  return (
    <DashboardPageHeader
      stamp={t("Achievements")}
      icon={<Trophy size={18} strokeWidth={2} />}
      title={t("Achievements")}
      sub={t(
        "Badges, challenges, leaderboards, and milestones for your riding region.",
      )}
    />
  );
}
// ── Current-tier hero ──
/**
 * Dark hero summarising the rider's XP / level / tier progression plus three
 * headline counts (badges, active challenges, regional rank). Progression and
 * the distance-dimension rank are fetched here so the section stays decoupled
 * from the snapshot load and the leaderboards widget. Hidden for a rider with
 * no XP yet — the empty-state design leads straight into the badge grid.
 */
function TierHero({
  earnedBadgeCount,
  activeCount,
  format,
}: {
  earnedBadgeCount: number;
  activeCount: number;
  format: Formatters;
}) {
  const t = useTranslation();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [progression, setProgression] = useState<RiderProgression | null>(null);
  const [rank, setRank] = useState<number | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let cancelled = false;
    // Each widget is independent — a failed rank fetch still shows the tier.
    void fetchProgression({ signal: controller.signal, translate: t })
      .then((p) => {
        if (!cancelled) setProgression(p);
      })
      .catch(() => undefined);
    // Scope the hero rank to the rider's home region (when set) so it matches
    // the regional leaderboard's default view directly below — otherwise the
    // hero would show a global rank that disagrees with the regional board.
    void usersApi
      .getMe({ signal: controller.signal })
      .then(({ data }) => {
        const region = data?.home_region?.trim() || undefined;
        return fetchRegionalLeaderboards({
          ...(region !== undefined ? { region } : {}),
          signal: controller.signal,
          translate: t,
        });
      })
      .then((board) => {
        if (!cancelled) setRank(board.total_distance_km.me?.rank ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [accessToken, t]);

  // Brand-new riders (no XP) get no hero — matches the empty-state design.
  if (!progression || progression.xp <= 0) return null;

  const span =
    progression.next_tier_xp != null
      ? progression.next_tier_xp - progression.current_tier_xp
      : 0;
  const pct =
    progression.next_tier_xp != null && span > 0
      ? Math.max(
          0,
          Math.min(
            100,
            ((progression.xp - progression.current_tier_xp) / span) * 100,
          ),
        )
      : 100;

  return (
    <section className="rounded-[14px] bg-ink p-6 text-cream">
      <div className="grid items-center gap-6 md:grid-cols-3">
        <div>
          <Stamp tone="accent">{t("Current tier")}</Stamp>
          <div className="mt-1.5 text-[36px] font-extrabold leading-[1.05] tracking-[-0.5px] text-cream">
            {progressionTierLabel(progression.tier, t)}
          </div>
          <div className="mt-1 text-[12px] text-fg-on-dark-mute">
            {t("Level {level} · {xp} XP", {
              level: progression.level,
              xp: format.integer(progression.xp),
            })}
          </div>
        </div>

        <div>
          {progression.next_tier ? (
            <>
              <Stamp tone="on-dark-dim">
                {t("Next tier · {tier}", {
                  tier: progressionTierLabel(progression.next_tier, t),
                })}
              </Stamp>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-cream/15">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <Mono className="mt-1.5 block text-[11px] text-fg-on-dark-mute">
                {t("{xp} XP to go", {
                  xp: format.integer(progression.xp_to_next_tier),
                })}
              </Mono>
            </>
          ) : (
            <Stamp tone="on-dark-dim">{t("Top tier reached")}</Stamp>
          )}
        </div>

        <div className="flex justify-start gap-[14px] md:justify-end">
          <HeroStat
            value={format.integer(earnedBadgeCount)}
            label={t("Badges")}
            accent
          />
          <HeroStat value={format.integer(activeCount)} label={t("Active")} />
          <HeroStat
            value={rank != null ? `#${format.integer(rank)}` : "—"}
            label={t("Rank")}
          />
        </div>
      </div>
    </section>
  );
}
function HeroStat({
  value,
  label,
  accent = false,
}: {
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="text-center">
      <div
        className={clsx(
          "text-[28px] font-extrabold leading-none",
          accent ? "text-accent" : "text-cream",
        )}
      >
        {value}
      </div>
      <Mono className="mt-1 block text-[9px] uppercase tracking-[1px] text-fg-on-dark-mute">
        {label}
      </Mono>
    </div>
  );
}
// ── Seasonal banner ──
function SeasonalBanner({
  seasonal,
  format,
}: {
  seasonal: SeasonalChallenge;
  format: Formatters;
}) {
  const t = useTranslation();
  const fraction = seasonalProgress(seasonal);
  const daysLeft = formatDaysRemaining(seasonal.endsAt, new Date(), t);
  const unit =
    seasonal.unit === "km" ? format.splitDistanceKm(1).unit : t(seasonal.unit);
  return (
    <section
      aria-label={t("Seasonal challenge")}
      className="relative overflow-hidden rounded-[14px] border border-accent/30 bg-gradient-to-r from-accent/10 via-paper to-violet-500/10 p-6"
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 w-48 opacity-10 pointer-events-none text-accent"
      >
        <Mountain className="w-full h-full" />
      </div>
      <div className="relative">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent">
          <Sparkles size={14} />
          {t("Seasonal \u00B7 {season}", {
            season: translateKnownLabel(seasonal.season, SEASON_LABELS, t),
          })}
        </div>
        <h2 className="mt-2 text-2xl font-bold text-ink">{t(seasonal.name)}</h2>
        <p className="mt-1 text-sm text-ink">{t(seasonal.tagline)}</p>
        <p className="mt-2 text-xs text-fg-dim max-w-xl">
          {t(seasonal.description, {
            distance: format.distanceKm(seasonal.target),
            count: seasonal.descriptionCount ?? 0,
          })}
        </p>

        <div className="mt-5 flex flex-col gap-2 max-w-md">
          <div className="flex items-center justify-between text-xs text-ink">
            <span className="tabular-nums">
              {seasonal.unit === "km"
                ? formatSplitValueUnitRange(
                    format.splitDistanceKm(seasonal.current),
                    format.splitDistanceKm(seasonal.target),
                    " / ",
                  )
                : t("{current} / {target} {unit}", {
                    current: format.integer(seasonal.current),
                    target: format.integer(seasonal.target),
                    unit,
                  })}
            </span>
            <span className="text-fg-dim">{daysLeft}</span>
          </div>
          <ProgressBar
            fraction={fraction}
            ariaLabel={t("{pct} complete", { pct: format.percent(fraction) })}
          />
        </div>
      </div>
    </section>
  );
}
// ── Badges ──
function BadgeGrid({
  badges,
  format,
}: {
  badges: BadgeType[];
  format: Formatters;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {badges.map((badge) => (
        <BadgeCard key={badge.id} badge={badge} format={format} />
      ))}
    </div>
  );
}
function BadgeCard({
  badge,
  format,
}: {
  badge: BadgeType;
  format: Formatters;
}) {
  const t = useTranslation();
  const Icon = BADGE_ICONS[badge.icon] ?? Medal;
  const earned = Boolean(badge.earnedAt);
  const earnedLabel =
    earned && badge.earnedAt
      ? formatDisplayUpperCase(format.shortDate(badge.earnedAt), format.locale)
      : null;
  return (
    <div
      className={clsx(
        "flex flex-col items-center gap-2.5 rounded-[14px] border p-[18px] text-center transition",
        earned
          ? "border-accent bg-cream opacity-100"
          : "border-line bg-paper opacity-55",
      )}
      title={
        earned && badge.earnedAt
          ? t("Earned {date}", { date: format.monthYear(badge.earnedAt) })
          : badge.description
      }
    >
      <span
        className={clsx(
          "flex h-[60px] w-[60px] items-center justify-center rounded-full",
          earned
            ? "border-2 border-ink bg-accent text-ink"
            : "bg-paper-2 text-fg-mute",
        )}
        aria-hidden="true"
      >
        {earned ? <Icon size={22} strokeWidth={2} /> : <Lock size={22} />}
      </span>
      <p className="text-[14px] font-extrabold leading-tight text-ink">
        {badge.name}
      </p>
      <p className="text-[11px] leading-[1.4] text-fg-dim">
        {badge.description}
      </p>
      {earnedLabel && (
        <Mono className="text-[9px] tracking-[0.4px] text-fg-mute">
          {t("EARNED {date}", { date: earnedLabel })}
        </Mono>
      )}
    </div>
  );
}
// ── Challenges ──
function ChallengeCard({
  challenge,
  meta,
  joining,
  onJoin,
  format,
}: {
  challenge: Challenge;
  meta: ChallengeMeta | undefined;
  joining: boolean;
  onJoin: (id: string) => void;
  format: Formatters;
}) {
  const t = useTranslation();
  const style = CATEGORY_STYLE[challenge.category];
  const fraction = challengeProgress(challenge);
  const percent = Math.round(fraction * 100);
  const joined = meta?.joined ?? false;
  // Spec footer collapses the long "5 days left" / "Ends today" into a
  // tight mono `5 D LEFT`. Re-using `formatDaysRemaining` keeps the
  // expired / today branching in one place.
  const daysFooter = formatDaysShort(challenge.endsAt, t);
  const safePercent = Math.max(0, Math.min(100, percent));
  return (
    <div className="rounded-[14px] border border-line bg-cream p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <Mono className="text-[10px] font-bold uppercase tracking-[1.6px] text-accent">
          {t(style.label)}
        </Mono>
        <Mono className="text-[10px] uppercase text-fg-mute">{daysFooter}</Mono>
      </div>

      <p className="mt-2 text-[15px] font-extrabold leading-snug text-ink">
        {challenge.name}
      </p>

      <div
        role="progressbar"
        aria-label={t("{name}: {pct} complete", {
          name: challenge.name,
          pct: format.percent(fraction),
        })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safePercent)}
        className="mt-3.5 h-2 w-full overflow-hidden rounded-full bg-paper-2"
      >
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${safePercent}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-fg-dim">
        <Mono>
          {challenge.unit === "km" ? (
            formatSplitValueUnitRange(
              format.splitDistanceKm(challenge.current),
              format.splitDistanceKm(challenge.target),
              " / ",
            )
          ) : (
            <>
              {format.integer(challenge.current)} /{" "}
              {format.integer(challenge.target)}
              {challenge.unit && (
                <span className="ml-1 text-fg-mute">{t(challenge.unit)}</span>
              )}
            </>
          )}
        </Mono>
        <Mono>{format.percent(fraction)}</Mono>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3 text-[11px] text-fg-mute">
        <span>
          {challenge.reward && (
            <LocalizedStyledValue
              t={t}
              messageKey="Reward · {reward}"
              valueName="reward"
              formattedValue={challenge.reward}
              className="font-bold text-ink"
            />
          )}
        </span>
        {meta && (
          <span className="inline-flex shrink-0 items-center gap-1 text-fg-dim">
            <Users size={11} aria-hidden="true" />
            {format.integer(meta.participantCount)}
          </span>
        )}
      </div>

      {!joined && (
        <div className="mt-3">
          <Button
            variant="accent"
            size="sm"
            uppercase
            loading={joining}
            onClick={() => onJoin(challenge.id)}
          >
            {joining ? t("Joining\u2026") : t("Join challenge")}
          </Button>
        </div>
      )}
    </div>
  );
}
// Mono variant of `formatDaysRemaining` for the spec's right-aligned 10 px
// footer slot. Computed directly from `endsAt` rather than parsing the
// long form \u2014 the prose strings ("3 weeks left", "2w 3d left", "1 month
// left") would be mislabelled "D LEFT" by a naive leading-digit regex,
// understating the time remaining on multi-week / multi-month challenges.
function formatDaysShort(
  endsAt: string,
  t: Translate,
  now: Date = new Date(),
): string {
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return t("Ongoing");
  const diffMs = end - now.getTime();
  if (diffMs <= 0) return t("Ended");
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return t("Ends today");
  if (days < 14) {
    return t("{count, plural, one {# DAY LEFT} other {# DAYS LEFT}}", {
      count: days,
    });
  }
  if (days < 90) {
    return t("{count, plural, one {# WEEK LEFT} other {# WEEKS LEFT}}", {
      count: Math.floor(days / 7),
    });
  }
  return t("{count, plural, one {# MONTH LEFT} other {# MONTHS LEFT}}", {
    count: Math.floor(days / 30),
  });
}
// ── Regional leaderboards ──
type RegionScope = "region" | "global";
type LeaderboardLoad =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      data: RegionalLeaderboards;
    }
  | {
      status: "error";
      message: string;
    };
/**
 * Multi-dimensional regional leaderboard widget. Manages its own region /
 * dimension state and refetches independently of the page's snapshot load —
 * region selection is interactive and changing it shouldn't reload badges,
 * challenges, or milestones.
 *
 * The "My region" toggle is only enabled once the rider's `home_region`
 * has been resolved from `/users/me`; until then we surface the global
 * ranking so the section is never blank.
 */
function RegionalLeaderboardsSection({ format }: { format: Formatters }) {
  const { locale, t } = useI18n();
  const [homeRegion, setHomeRegion] = useState<string | null>(null);
  const [scope, setScope] = useState<RegionScope>("global");
  const [dimension, setDimension] =
    useState<LeaderboardDimensionKey>("total_distance_km");
  const [load, setLoad] = useState<LeaderboardLoad>({ status: "loading" });
  // Each fetch wins-or-loses against any in-flight predecessor by aborting
  // the controller stored here; older responses don't get to overwrite the
  // newer state when they resolve late.
  const controllerRef = useRef<AbortController | null>(null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // Resolve home_region once per user. We don't error out if the request
  // fails — the global ranking still renders, the toggle just stays on
  // global. `scope` is realigned to whatever the new user's region permits
  // so a switch from a region-toggled User A to a region-less User B can't
  // leave `scope === "region"` while the My-region button is hidden,
  // which would show the global ranking with neither toggle button active.
  useEffect(() => {
    let cancelled = false;
    void usersApi
      .getMe()
      .then(({ data }) => {
        if (cancelled) return;
        const region = data.home_region?.trim() ?? "";
        const next = region.length > 0 ? region : null;
        setHomeRegion(next);
        setScope(next !== null ? "region" : "global");
      })
      .catch(() => {
        if (cancelled) return;
        setHomeRegion(null);
        setScope("global");
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // Belt-and-suspenders: if `scope` is "region" but no home_region is
  // available, the visible ranking is global — derive the effective region
  // accordingly so we never send a `region=null` request with a stale
  // "region" toggle visible.
  const region = scope === "region" && homeRegion !== null ? homeRegion : null;
  const load_ = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await fetchRegionalLeaderboards({
          region,
          currentUserId: userId,
          signal,
          translate: t,
        });
        if (signal.aborted) return;
        setLoad({ status: "ready", data });
      } catch (err) {
        if (signal.aborted) return;
        setLoad({
          status: "error",
          message: getUserFacingErrorMessage(
            err,
            t("Could not load leaderboards."),
          ),
        });
      }
    },
    [t, region, userId],
  );
  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoad({ status: "loading" });
    void load_(controller.signal);
    return () => controller.abort();
  }, [load_]);
  const dim: RegionalDimensionLeaderboard | null = useMemo(() => {
    if (load.status !== "ready") return null;
    return load.data[dimension];
  }, [load, dimension]);
  return (
    <section aria-labelledby="leaderboard-heading">
      <SectionHeader
        id="leaderboard-heading"
        icon={<Trophy size={18} strokeWidth={2} />}
        title={t("Regional leaderboards")}
        subtitle={
          scope === "region" && homeRegion
            ? t("Top riders in {region}, ranked by {dimension}.", {
                region: homeRegion,
                dimension: formatDisplayLowerCase(
                  labelForDimension(dimension, t),
                  locale,
                ),
              })
            : t("Top riders worldwide, ranked by {dimension}.", {
                dimension: formatDisplayLowerCase(
                  labelForDimension(dimension, t),
                  locale,
                ),
              })
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {homeRegion && (
          <SegmentedControl
            ariaLabel={t("Region scope")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "global", label: t("Global") },
              { value: "region", label: homeRegion },
            ]}
          />
        )}
        <SegmentedControl
          ariaLabel={t("Leaderboard dimension")}
          value={dimension}
          onChange={setDimension}
          options={LEADERBOARD_DIMENSION_KEYS.map((dim) => ({
            value: dim,
            label: labelForDimension(dim, t),
          }))}
        />
      </div>

      {load.status === "error" ? (
        <div
          role="alert"
          className="rounded-[14px] border border-quality-q1/30 bg-quality-q1/10 p-6 text-center"
        >
          <AlertTriangle
            className="mx-auto mb-2 text-red-700"
            size={24}
            aria-hidden="true"
          />
          <p className="font-medium text-ink">
            {t("Could not load leaderboards")}
          </p>
          <p className="mt-1 text-sm text-fg-dim">{load.message}</p>
        </div>
      ) : load.status === "loading" || dim === null ? (
        <div className="h-48 animate-pulse rounded-[14px] border border-line bg-cream" />
      ) : dim.entries.length === 0 ? (
        <EmptyCard
          icon={<Users size={32} />}
          title={t("No riders ranked yet")}
          body={t(
            "Once you record your first ride, you'll be placed on the regional and global boards.",
          )}
        />
      ) : (
        <RegionalLeaderboardTable dim={dim} format={format} />
      )}
    </section>
  );
}
function RegionalLeaderboardTable({
  dim,
  format,
}: {
  dim: RegionalDimensionLeaderboard;
  format: Formatters;
}) {
  const t = useTranslation();
  // Surface `me` even when outside the top N. The backend already excludes
  // duplicates by design — `entries` and `me` only ever overlap on the same
  // row when the rider ranks in the visible window, in which case `me.rank`
  // matches one of the entries.
  const showOutsideTop =
    dim.me !== null && !dim.entries.some((e) => e.userId === dim.me?.userId);
  return (
    <div
      role="table"
      aria-label={t("Regional leaderboard")}
      className="overflow-hidden rounded-[14px] border border-line bg-cream"
    >
      <div
        role="row"
        className="grid grid-cols-[60px_1fr_120px] border-b border-line bg-paper-2 px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute"
      >
        <span role="columnheader">#</span>
        <span role="columnheader">{t("Rider")}</span>
        <span role="columnheader" className="text-right">
          {/* The distance dimension's rows convert — its header must too. */}
          {dim.unit === "km" ? format.splitDistanceKm(1).unit : t(dim.unit)}
        </span>
      </div>
      <div>
        {dim.entries.map((entry, i) => (
          <RegionalLeaderboardRow
            key={entry.userId}
            entry={entry}
            unit={dim.unit}
            zebra={i % 2 === 1}
            format={format}
          />
        ))}
        {showOutsideTop && dim.me && (
          <RegionalLeaderboardRow
            entry={dim.me}
            unit={dim.unit}
            outsideTop
            zebra={dim.entries.length % 2 === 1}
            format={format}
          />
        )}
      </div>
    </div>
  );
}
function RegionalLeaderboardRow({
  entry,
  unit,
  outsideTop = false,
  zebra = false,
  format,
}: {
  entry: RegionalLeaderboardEntry;
  unit: EnglishMessageKey;
  outsideTop?: boolean;
  zebra?: boolean;
  format: Formatters;
}) {
  const t = useTranslation();
  const isMe = entry.isMe;
  const topThree = entry.rank >= 1 && entry.rank <= 3;
  const { enabled: communityEnabled } =
    useFeatureKillSwitch("community_access");
  // The whole row is the link. With community killed the standings still stand
  // — they are earned here, not in the community area — so the row keeps its
  // rank, name and score and simply stops navigating.
  const rowClassName = clsx(
    "grid grid-cols-[60px_1fr_120px] items-center px-5 py-3 text-[13px] transition",
    isMe
      ? "bg-ink text-cream hover:bg-ink/90"
      : zebra
        ? "bg-ink/[0.02] text-ink hover:bg-ink/[0.05]"
        : "bg-transparent text-ink hover:bg-ink/[0.04]",
    outsideTop && "border-t border-line-strong/60",
  );
  const rowLabel = isMe ? t("View your profile") : entry.displayName;
  const rowContent = (
    <>
      <span
        role="cell"
        className={clsx(
          "font-mono font-extrabold tabular-nums",
          isMe ? "text-accent" : topThree ? "text-ink" : "text-fg-mute",
        )}
      >
        #
        {format.number(entry.rank, {
          useGrouping: false,
          maximumFractionDigits: 0,
        })}
      </span>
      <div role="cell" className="flex items-center gap-2.5 min-w-0">
        <UserAvatar
          name={entry.displayName}
          size={26}
          fontSize={11}
          accent={isMe}
        />
        <span
          className={clsx(
            "truncate",
            isMe ? "font-extrabold" : "font-semibold",
          )}
        >
          {isMe ? t("You") : entry.displayName}
        </span>
        {entry.homeRegion && !isMe && (
          <span className="hidden text-[11px] text-fg-dim sm:inline">
            · {entry.homeRegion}
          </span>
        )}
      </div>
      <span
        role="cell"
        className={clsx(
          "text-right font-mono font-bold tabular-nums",
          isMe ? "text-accent" : "text-ink",
        )}
      >
        {unit === "km"
          ? format.distanceKm(entry.value)
          : t("{value} {unit}", {
              value: format.integer(entry.value),
              unit: t(unit),
            })}
      </span>
    </>
  );
  return communityEnabled ? (
    <Link
      href={`/community/${encodeURIComponent(entry.userId)}`}
      role="row"
      aria-label={rowLabel}
      className={rowClassName}
    >
      {rowContent}
    </Link>
  ) : (
    <div role="row" aria-label={rowLabel} className={rowClassName}>
      {rowContent}
    </div>
  );
}
// ── Milestone ──
function MilestoneCard({
  progress,
  format,
}: {
  progress: MilestoneProgress;
  format: Formatters;
}) {
  const t = useTranslation();
  const label = formatMilestoneLabel(progress, format, t);
  return (
    <div className="rounded-[14px] border border-line bg-cream p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink">
            {progress.milestone.name}
          </p>
          <p className="mt-1 text-xs text-fg-dim max-w-md">
            {progress.milestone.description}
          </p>
        </div>
        <span className="shrink-0 text-xs text-fg-dim tabular-nums">
          {format.percent(progress.fraction)}
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-ink tabular-nums">
          <span>{label}</span>
          {progress.nextThreshold !== null && (
            <span className="text-fg-dim">
              {t("{count} to go", {
                // Distance milestones convert `remaining` (a km figure)
                // with the rider's units; count metrics stay plain.
                count:
                  progress.milestone.metric === "totalKm"
                    ? format.distanceKm(progress.remaining)
                    : format.integer(progress.remaining),
              })}
            </span>
          )}
        </div>
        <ProgressBar fraction={progress.fraction} />
      </div>

      <TierTrack
        thresholds={[...progress.milestone.thresholds].sort((a, b) => a - b)}
        current={progress.current}
        metric={progress.milestone.metric}
        format={format}
      />
    </div>
  );
}
function TierTrack({
  thresholds,
  current,
  metric,
  format,
}: {
  thresholds: number[];
  current: number;
  metric: LeaderboardMetric;
  format: Formatters;
}) {
  if (thresholds.length === 0) return null;
  return (
    <ol className="mt-4 flex flex-wrap gap-2">
      {thresholds.map((tier) => {
        const reached = current >= tier;
        return (
          <li
            key={tier}
            className={clsx(
              "rounded-full border px-3 py-1 text-[11px] tabular-nums",
              reached
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-line-strong bg-cream text-fg-dim",
            )}
          >
            {/* Distance tiers convert with the milestone label above them
                (a raw 10,000 chip under a "6,214 mi" label misleads);
                count tiers stay plain integers. */}
            {metric === "totalKm"
              ? format.splitDistanceKm(tier).value
              : format.integer(tier)}
          </li>
        );
      })}
    </ol>
  );
}
// ── Shared atoms ──
function ProgressBar({
  fraction,
  ariaLabel,
}: {
  fraction: number;
  ariaLabel?: string;
}) {
  const percent = Math.max(0, Math.min(100, fraction * 100));
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-2 w-full rounded-full bg-paper overflow-hidden"
    >
      <div
        className="h-full bg-accent transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
function SectionHeader({
  id,
  icon,
  title,
  counter,
  subtitle,
}: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  counter?: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5 text-ink">
        <span className="text-accent inline-flex">{icon}</span>
        <h2
          id={id}
          className="font-sans text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink"
        >
          {title}
        </h2>
        {counter !== undefined && (
          <Mono className="text-[12px] text-fg-dim">{counter}</Mono>
        )}
      </div>
      {subtitle && <p className="mt-1.5 text-[12px] text-fg-dim">{subtitle}</p>}
    </div>
  );
}
function EmptyCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-line bg-cream px-6 py-14 text-center">
      <div className="mb-1 text-fg-mute" aria-hidden="true">
        {icon}
      </div>
      <p className="text-[16px] font-bold text-ink">{title}</p>
      <p className="max-w-[420px] text-[12px] leading-[1.55] text-fg-dim">
        {body}
      </p>
    </div>
  );
}
function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useTranslation();
  return (
    <div
      role="alert"
      className="rounded-[14px] border border-red-900/60 bg-red-950/30 p-6 text-center"
    >
      <AlertTriangle className="mx-auto text-red-700 mb-2" size={28} />
      <p className="text-red-700 font-medium">
        {t("Could not load achievements")}
      </p>
      <p className="text-red-700/80 text-sm mt-1">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-900/40 text-red-100 text-sm hover:bg-red-900/60 transition"
      >
        {t("Try again")}
      </button>
    </div>
  );
}
function AchievementsSkeleton() {
  const t = useTranslation();
  return (
    <div>
      <span role="status" className="sr-only">
        {t("Loading achievements\u2026")}
      </span>
      <div aria-hidden="true" className="space-y-8">
        <Skeleton className="h-32 w-full rounded-[14px]" />
        <div>
          <Skeleton className="mb-3 h-4 w-24" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        </div>
        <div>
          <Skeleton className="mb-3 h-4 w-32" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
