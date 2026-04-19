"use client";

import { useMemo } from "react";
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
import { useAuthStore } from "@/stores/auth";
import type { Badge as BadgeType } from "@/lib/types";
import {
  activeChallenges,
  buildDemoSnapshot,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  myLeaderboardRank,
  pickNextMilestone,
  seasonalProgress,
  sortLeaderboard,
  type Challenge,
  type ChallengeCategory,
  type GamificationSnapshot,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type MilestoneProgress,
  type SeasonalChallenge,
} from "@/lib/gamification";

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

const LEADERBOARD_METRICS: {
  key: LeaderboardMetric;
  label: string;
  unit: string;
}[] = [
  { key: "totalKm", label: "Kilometres ridden", unit: "km" },
  { key: "roadsDiscovered", label: "Roads discovered", unit: "roads" },
  { key: "hazardsReported", label: "Hazards reported", unit: "reports" },
];

export default function GamificationPage() {
  const userId = useAuthStore((s) => s.user?.id);
  // Seed with a stable fallback so the page renders pre-auth and for the
  // demo-only environment used in CI. The snapshot is deterministic per id,
  // matching the rider-profile page's fallback behaviour.
  const snapshot = useMemo<GamificationSnapshot>(
    () => buildDemoSnapshot(userId ?? "me"),
    [userId],
  );

  const visibleChallenges = useMemo(
    () => activeChallenges(snapshot.challenges),
    [snapshot.challenges],
  );
  const nextMilestone = useMemo(
    () => pickNextMilestone(snapshot.milestones, snapshot.stats),
    [snapshot.milestones, snapshot.stats],
  );

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Achievements</h1>
        <p className="text-sm text-slate-400 mt-1">
          Badges, challenges, leaderboards, and milestones for your riding
          region.
        </p>
      </header>

      <SeasonalBanner seasonal={snapshot.seasonal} />

      <section aria-labelledby="badges-heading">
        <SectionHeader
          id="badges-heading"
          icon={<Award size={16} />}
          title="Badges"
          subtitle={`${snapshot.badges.filter((b) => b.earnedAt).length} of ${snapshot.badges.length} earned`}
        />
        <BadgeGrid badges={snapshot.badges} />
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
        {visibleChallenges.length === 0 ? (
          <EmptyCard
            icon={<Target size={32} className="text-slate-600" />}
            title="Nothing active"
            body="Check back on Monday — new weekly challenges drop every week."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleChallenges.map((challenge) => (
              <ChallengeCard key={challenge.id} challenge={challenge} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="leaderboard-heading">
        <SectionHeader
          id="leaderboard-heading"
          icon={<Trophy size={16} />}
          title="Regional leaderboard"
          subtitle={
            snapshot.leaderboard[0]?.homeRegion
              ? `Riders in ${snapshot.leaderboard[0].homeRegion}`
              : "Top riders in your region"
          }
        />
        <Leaderboard entries={snapshot.leaderboard} />
      </section>

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

function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const style = CATEGORY_STYLE[challenge.category];
  const fraction = challengeProgress(challenge);
  const percent = Math.round(fraction * 100);
  const Icon = style.icon;
  const complete = fraction >= 1;
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

      {challenge.reward && (
        <p className="mt-3 text-[11px] text-slate-500 flex items-center gap-1">
          <Medal size={12} /> Reward: {challenge.reward}
        </p>
      )}
    </div>
  );
}

// ── Leaderboard ──

interface LeaderboardProps {
  entries: LeaderboardEntry[];
}

function Leaderboard({ entries }: LeaderboardProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-900/80">
              <th className="py-3 px-4 font-semibold w-12">#</th>
              <th className="py-3 px-4 font-semibold">Rider</th>
              {LEADERBOARD_METRICS.map((metric) => (
                <th
                  key={metric.key}
                  className="py-3 px-4 font-semibold text-right"
                >
                  {metric.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {LEADERBOARD_METRICS[0] &&
              renderLeaderboardRows(entries, LEADERBOARD_METRICS[0].key)}
          </tbody>
        </table>
      </div>
      <MyRankSummary entries={entries} />
    </div>
  );
}

function renderLeaderboardRows(
  entries: LeaderboardEntry[],
  sortMetric: LeaderboardMetric,
) {
  const sorted = sortLeaderboard(entries, sortMetric);
  return sorted.map((entry, index) => {
    const rank = index + 1;
    return (
      <tr
        key={entry.riderId}
        className={clsx(
          "text-slate-200",
          entry.isMe && "bg-tarmoto-cyan/5 text-white",
        )}
      >
        <td className="py-3 px-4">
          <RankBadge rank={rank} />
        </td>
        <td className="py-3 px-4">
          <div className="font-medium">
            {entry.displayName}
            {entry.isMe && (
              <span className="ml-2 text-[10px] uppercase tracking-widest text-tarmoto-cyan">
                You
              </span>
            )}
          </div>
          {entry.homeRegion && (
            <div className="text-xs text-slate-500">{entry.homeRegion}</div>
          )}
        </td>
        <td className="py-3 px-4 text-right tabular-nums">
          {Math.round(entry.totalKm).toLocaleString()} km
        </td>
        <td className="py-3 px-4 text-right tabular-nums">
          {entry.roadsDiscovered.toLocaleString()}
        </td>
        <td className="py-3 px-4 text-right tabular-nums">
          {entry.hazardsReported.toLocaleString()}
        </td>
      </tr>
    );
  });
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

function MyRankSummary({ entries }: { entries: LeaderboardEntry[] }) {
  const items = LEADERBOARD_METRICS.map((metric) => ({
    label: metric.label,
    rank: myLeaderboardRank(entries, metric.key),
  })).filter((i): i is { label: string; rank: number } => i.rank !== null);
  if (items.length === 0) return null;
  return (
    <div className="border-t border-slate-800 px-4 py-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-400">
      <span className="text-slate-500 uppercase tracking-widest font-semibold">
        Your ranks
      </span>
      {items.map((item) => (
        <span key={item.label} className="tabular-nums">
          #{item.rank} <span className="text-slate-500">· {item.label}</span>
        </span>
      ))}
    </div>
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
