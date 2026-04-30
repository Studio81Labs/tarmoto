"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Award,
  Compass,
  Flag,
  Flame,
  Heart,
  Loader2,
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
import { useAuthStore } from "@/stores/auth";
import type { Badge as BadgeType } from "@/lib/types";
import {
  activeChallenges,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  pickNextMilestone,
  seasonalProgress,
  type Challenge,
  type ChallengeCategory,
  type ChallengeMeta,
  type GamificationSnapshot,
  type MilestoneProgress,
  type PrimaryLeaderboard,
  type PrimaryLeaderboardEntry,
  type SeasonalChallenge,
} from "@/lib/gamification";
import {
  fetchGamificationSnapshot,
  joinChallenge,
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
  { label: string; icon: LucideIcon; accent: string }
> = {
  distance: { label: "Distance", icon: Flag, accent: "text-tarmoto-cyan" },
  discovery: { label: "Discovery", icon: Compass, accent: "text-violet-300" },
  safety: {
    label: "Safety",
    icon: AlertTriangle,
    accent: "text-amber-300",
  },
  social: { label: "Social", icon: Users, accent: "text-pink-300" },
  seasonal: { label: "Seasonal", icon: Sparkles, accent: "text-emerald-300" },
};

// Every loaded state is tagged with the userId it represents so the render
// can refuse to show snapshot data for a user that is no longer signed in.
// Without this, switching accounts could briefly leak the previous user's
// badges/challenges between the prop change and the refetch completing.
type LoadState =
  | { status: "idle" }
  | { status: "loading"; userId: string }
  | { status: "ready"; userId: string; snapshot: GamificationSnapshot }
  | { status: "error"; userId: string; message: string };

export default function GamificationPage() {
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
  const load = useCallback(
    async (uid: string, opts: { silent?: boolean } = {}) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { silent = false } = opts;
      if (!silent) setState({ status: "loading", userId: uid });
      try {
        const snapshot = await fetchGamificationSnapshot(uid, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState({ status: "ready", userId: uid, snapshot });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (silent) throw err;
        setState({
          status: "error",
          userId: uid,
          message:
            err instanceof Error
              ? err.message
              : "Could not load achievements right now.",
        });
      }
    },
    [],
  );

  useEffect(() => {
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
        await joinChallenge(challengeId);
      } catch (err) {
        setJoinError(
          err instanceof Error ? err.message : "Could not join challenge.",
        );
        setJoiningIds((prev) => {
          const next = new Set(prev);
          next.delete(challengeId);
          return next;
        });
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
    [userId, load],
  );

  if (!userId) {
    return (
      <div className="p-6 max-w-6xl mx-auto animate-fade-in">
        <PageHeader />
        <EmptyCard
          icon={<Lock size={32} className="text-slate-600" />}
          title="Sign in to see your achievements"
          body="Badges, challenges, and leaderboards appear once you're signed in."
        />
      </div>
    );
  }

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

  if (!stateForUser) {
    return (
      <div className="p-6 max-w-6xl mx-auto animate-fade-in space-y-8">
        <PageHeader />
        <SkeletonGrid />
      </div>
    );
  }

  if (stateForUser.status === "error") {
    return (
      <div className="p-6 max-w-6xl mx-auto animate-fade-in">
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
}: {
  snapshot: GamificationSnapshot;
  joiningIds: ReadonlySet<string>;
  joinError: string | null;
  onJoin: (id: string) => void;
}) {
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
    <div className="p-6 max-w-6xl mx-auto animate-fade-in space-y-8">
      <PageHeader />

      {snapshot.seasonal && <SeasonalBanner seasonal={snapshot.seasonal} />}

      <section aria-labelledby="badges-heading">
        <SectionHeader
          id="badges-heading"
          icon={<Award size={16} />}
          title="Badges"
          subtitle={`${earnedBadgeCount} of ${snapshot.badges.length} earned`}
        />
        {snapshot.badges.length === 0 ? (
          <EmptyCard
            icon={<Award size={32} className="text-slate-600" />}
            title="No badges yet"
            body="Ride, discover roads, or report hazards to start earning badges."
          />
        ) : (
          <BadgeGrid badges={snapshot.badges} />
        )}
      </section>

      <section aria-labelledby="challenges-heading">
        <SectionHeader
          id="challenges-heading"
          icon={<Target size={16} />}
          title="Active challenges"
          subtitle={
            visibleChallenges.length === 0
              ? "No active challenges right now."
              : `${visibleChallenges.length} in progress`
          }
        />
        {joinError && (
          <p className="mb-3 text-xs text-red-300" role="alert">
            {joinError}
          </p>
        )}
        {visibleChallenges.length === 0 ? (
          <EmptyCard
            icon={<Target size={32} className="text-slate-600" />}
            title="No challenges to join yet"
            body="Check back on Monday — new weekly challenges drop every week."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleChallenges.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                meta={snapshot.challengeMeta[challenge.id]}
                joining={joiningIds.has(challenge.id)}
                onJoin={onJoin}
              />
            ))}
          </div>
        )}
      </section>

      {snapshot.primaryLeaderboard && (
        <section aria-labelledby="leaderboard-heading">
          <SectionHeader
            id="leaderboard-heading"
            icon={<Trophy size={16} />}
            title="Challenge leaderboard"
            subtitle={`Top riders in "${snapshot.primaryLeaderboard.challengeTitle}"`}
          />
          <PrimaryLeaderboardTable leaderboard={snapshot.primaryLeaderboard} />
        </section>
      )}

      {nextMilestone && (
        <section aria-labelledby="milestone-heading">
          <SectionHeader
            id="milestone-heading"
            icon={<Heart size={16} />}
            title="Next milestone"
            subtitle="What you're working toward right now."
          />
          <MilestoneCard progress={nextMilestone} />
        </section>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <header>
      <h1 className="text-2xl font-bold">Achievements</h1>
      <p className="text-sm text-slate-400 mt-1">
        Badges, challenges, leaderboards, and milestones for your riding region.
      </p>
    </header>
  );
}

// ── Seasonal banner ──

function SeasonalBanner({ seasonal }: { seasonal: SeasonalChallenge }) {
  const fraction = seasonalProgress(seasonal);
  const percent = Math.round(fraction * 100);
  const daysLeft = formatDaysRemaining(seasonal.endsAt);
  return (
    <section
      aria-label="Seasonal challenge"
      className="relative overflow-hidden rounded-2xl border border-tarmoto-cyan/30 bg-gradient-to-r from-tarmoto-cyan/10 via-slate-900 to-violet-500/10 p-6"
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 w-48 opacity-10 pointer-events-none text-tarmoto-cyan"
      >
        <Mountain className="w-full h-full" />
      </div>
      <div className="relative">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-tarmoto-cyan">
          <Sparkles size={14} />
          Seasonal · {seasonal.season}
        </div>
        <h2 className="mt-2 text-2xl font-bold text-white">{seasonal.name}</h2>
        <p className="mt-1 text-sm text-slate-300">{seasonal.tagline}</p>
        <p className="mt-2 text-xs text-slate-400 max-w-xl">
          {seasonal.description}
        </p>

        <div className="mt-5 flex flex-col gap-2 max-w-md">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span className="tabular-nums">
              {Math.round(seasonal.current).toLocaleString()} /{" "}
              {seasonal.target.toLocaleString()} {seasonal.unit}
            </span>
            <span className="text-slate-400">{daysLeft}</span>
          </div>
          <ProgressBar fraction={fraction} ariaLabel={`${percent}% complete`} />
        </div>
      </div>
    </section>
  );
}

// ── Badges ──

function BadgeGrid({ badges }: { badges: BadgeType[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {badges.map((badge) => (
        <BadgeCard key={badge.id} badge={badge} />
      ))}
    </div>
  );
}

function BadgeCard({ badge }: { badge: BadgeType }) {
  const Icon = BADGE_ICONS[badge.icon] ?? Medal;
  const earned = Boolean(badge.earnedAt);
  return (
    <div
      className={clsx(
        "relative rounded-xl border p-4 flex flex-col items-center text-center transition",
        earned
          ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/5"
          : "border-slate-800 bg-slate-900/60 opacity-60",
      )}
      title={
        earned && badge.earnedAt
          ? `Earned ${new Date(badge.earnedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
          : badge.description
      }
    >
      <span
        className={clsx(
          "w-12 h-12 rounded-full flex items-center justify-center",
          earned
            ? "bg-tarmoto-cyan/15 text-tarmoto-cyan"
            : "bg-slate-800 text-slate-500",
        )}
      >
        {earned ? <Icon size={24} /> : <Lock size={20} />}
      </span>
      <p
        className={clsx(
          "mt-3 text-sm font-semibold",
          earned ? "text-white" : "text-slate-400",
        )}
      >
        {badge.name}
      </p>
      <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">
        {badge.description}
      </p>
    </div>
  );
}

// ── Challenges ──

function ChallengeCard({
  challenge,
  meta,
  joining,
  onJoin,
}: {
  challenge: Challenge;
  meta: ChallengeMeta | undefined;
  joining: boolean;
  onJoin: (id: string) => void;
}) {
  const style = CATEGORY_STYLE[challenge.category];
  const fraction = challengeProgress(challenge);
  const percent = Math.round(fraction * 100);
  const Icon = style.icon;
  const complete = fraction >= 1;
  const joined = meta?.joined ?? false;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={clsx(
              "flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest",
              style.accent,
            )}
          >
            <Icon size={12} />
            {style.label}
          </div>
          <p className="mt-1.5 text-sm font-semibold text-white">
            {challenge.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {challenge.description}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-slate-500">
          {formatDaysRemaining(challenge.endsAt)}
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-300 tabular-nums">
            {Math.round(challenge.current).toLocaleString()} /{" "}
            {challenge.target.toLocaleString()} {challenge.unit}
          </span>
          <span
            className={clsx(
              "tabular-nums",
              complete ? "text-tarmoto-cyan" : "text-slate-400",
            )}
          >
            {percent}%
          </span>
        </div>
        <ProgressBar
          fraction={fraction}
          ariaLabel={`${challenge.name}: ${percent}% complete`}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[11px] text-slate-500 flex items-center gap-3">
          {challenge.reward && (
            <span className="flex items-center gap-1">
              <Medal size={12} /> Reward: {challenge.reward}
            </span>
          )}
          {meta && (
            <span className="flex items-center gap-1">
              <Users size={12} /> {meta.participantCount.toLocaleString()}
            </span>
          )}
        </div>
        {joined ? (
          <span className="text-[11px] uppercase tracking-widest text-tarmoto-cyan">
            Joined
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onJoin(challenge.id)}
            disabled={joining}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-tarmoto-cyan/15 text-tarmoto-cyan text-xs font-semibold hover:bg-tarmoto-cyan/25 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {joining ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Joining…
              </>
            ) : (
              "Join challenge"
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Leaderboard ──

function PrimaryLeaderboardTable({
  leaderboard,
}: {
  leaderboard: PrimaryLeaderboard;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-900/80">
              <th className="py-3 px-4 font-semibold w-12">#</th>
              <th className="py-3 px-4 font-semibold">Rider</th>
              <th className="py-3 px-4 font-semibold text-right">
                Progress ({leaderboard.unit})
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {leaderboard.entries.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="py-8 px-4 text-center text-sm text-slate-500"
                >
                  No riders have joined this challenge yet.
                </td>
              </tr>
            ) : (
              leaderboard.entries.map((entry) => (
                <PrimaryLeaderboardRow
                  key={entry.userId}
                  entry={entry}
                  unit={leaderboard.unit}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <PrimaryLeaderboardSummary leaderboard={leaderboard} />
    </div>
  );
}

function PrimaryLeaderboardRow({
  entry,
  unit,
}: {
  entry: PrimaryLeaderboardEntry;
  unit: string;
}) {
  return (
    <tr className={clsx("text-slate-200", entry.isMe && "bg-tarmoto-cyan/5")}>
      <td className="py-3 px-4">
        <RankBadge rank={entry.rank} />
      </td>
      <td className="py-3 px-4">
        <div className="font-medium">
          {entry.displayName}
          {entry.isMe && (
            <span className="ml-2 text-[10px] uppercase tracking-widest text-tarmoto-cyan">
              You
            </span>
          )}
          {entry.completed && (
            <span className="ml-2 text-[10px] uppercase tracking-widest text-emerald-300">
              Completed
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right tabular-nums">
        {Math.round(entry.progress).toLocaleString()} {unit}
      </td>
    </tr>
  );
}

function PrimaryLeaderboardSummary({
  leaderboard,
}: {
  leaderboard: PrimaryLeaderboard;
}) {
  const me = leaderboard.entries.find((e) => e.isMe);
  if (!me) return null;
  return (
    <div className="border-t border-slate-800 px-4 py-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-400">
      <span className="text-slate-500 uppercase tracking-widest font-semibold">
        Your rank
      </span>
      <span className="tabular-nums">
        #{me.rank}{" "}
        <span className="text-slate-500">
          · {Math.round(me.progress).toLocaleString()} {leaderboard.unit}
        </span>
      </span>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-amber-400/20 text-amber-300">
        <Trophy size={14} />
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-slate-400/20 text-slate-300">
        <Medal size={14} />
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300">
        <Medal size={14} />
      </span>
    );
  }
  return (
    <span className="inline-flex w-7 h-7 items-center justify-center text-sm text-slate-400 tabular-nums">
      {rank}
    </span>
  );
}

// ── Milestone ──

function MilestoneCard({ progress }: { progress: MilestoneProgress }) {
  const percent = Math.round(progress.fraction * 100);
  const label = formatMilestoneLabel(progress);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-white">
            {progress.milestone.name}
          </p>
          <p className="mt-1 text-xs text-slate-400 max-w-md">
            {progress.milestone.description}
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-400 tabular-nums">
          {percent}%
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-slate-300 tabular-nums">
          <span>{label}</span>
          {progress.nextThreshold !== null && (
            <span className="text-slate-500">
              {Math.round(progress.remaining).toLocaleString()} to go
            </span>
          )}
        </div>
        <ProgressBar fraction={progress.fraction} />
      </div>

      <TierTrack
        thresholds={[...progress.milestone.thresholds].sort((a, b) => a - b)}
        current={progress.current}
      />
    </div>
  );
}

function TierTrack({
  thresholds,
  current,
}: {
  thresholds: number[];
  current: number;
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
                ? "border-tarmoto-cyan/40 bg-tarmoto-cyan/10 text-tarmoto-cyan"
                : "border-slate-700 bg-slate-900 text-slate-500",
            )}
          >
            {tier.toLocaleString()}
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
      className="h-2 w-full rounded-full bg-slate-800 overflow-hidden"
    >
      <div
        className="h-full bg-tarmoto-cyan transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function SectionHeader({
  id,
  icon,
  title,
  subtitle,
}: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-white">
        <span className="text-tarmoto-cyan">{icon}</span>
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
      </div>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
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
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
      <div className="mx-auto w-10 h-10 flex items-center justify-center mb-3">
        {icon}
      </div>
      <p className="text-slate-300 font-medium">{title}</p>
      <p className="text-slate-500 text-sm mt-1">{body}</p>
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
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-900/60 bg-red-950/30 p-6 text-center"
    >
      <AlertTriangle className="mx-auto text-red-300 mb-2" size={28} />
      <p className="text-red-200 font-medium">Could not load achievements</p>
      <p className="text-red-300/80 text-sm mt-1">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-900/40 text-red-100 text-sm hover:bg-red-900/60 transition"
      >
        Try again
      </button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <div className="h-32 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
      <div>
        <div className="mb-3 h-4 w-24 bg-slate-800 rounded animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-xl bg-slate-900 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 h-4 w-32 bg-slate-800 rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-36 rounded-xl bg-slate-900 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
