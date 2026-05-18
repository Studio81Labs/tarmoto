"use client";
import { t } from "@/i18n";
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
  Map as MapIcon,
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
import { usersApi } from "@/lib/api";
import {
  activeChallenges,
  challengeProgress,
  formatDaysRemaining,
  formatMilestoneLabel,
  labelForDimension,
  pickNextMilestone,
  seasonalProgress,
  LEADERBOARD_DIMENSION_KEYS,
  type Challenge,
  type ChallengeCategory,
  type ChallengeMeta,
  type GamificationSnapshot,
  type LeaderboardDimensionKey,
  type MilestoneProgress,
  type RegionalDimensionLeaderboard,
  type RegionalLeaderboardEntry,
  type RegionalLeaderboards,
  type SeasonalChallenge,
} from "@/lib/gamification";
import {
  fetchGamificationSnapshot,
  fetchRegionalLeaderboards,
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
  {
    label: string;
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
        await joinChallenge(challengeId);
      } catch (err) {
        // Only surface the error to the user that initiated the join.
        // If the rider switched accounts while the request was in flight,
        // the live signed-in user is no longer who clicked Join — writing
        // their previous error onto the new user's dashboard would be
        // confusing (the new user never tried to join anything).
        if (useAuthStore.getState().user?.id === userId) {
          setJoinError(
            err instanceof Error ? err.message : "Could not join challenge.",
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
    [userId, load],
  );
  if (!userId) {
    return (
      <div className="p-6 max-w-page mx-auto animate-fade-in">
        <PageHeader />
        <EmptyCard
          icon={<Lock size={32} className="text-fg-mute" />}
          title={t("Sign in to see your achievements")}
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
      <div className="p-6 max-w-page mx-auto animate-fade-in space-y-8">
        <PageHeader />
        <SkeletonGrid />
      </div>
    );
  }
  if (stateForUser.status === "error") {
    return (
      <div className="p-6 max-w-page mx-auto animate-fade-in">
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
    <div className="p-6 max-w-page mx-auto animate-fade-in space-y-8">
      <PageHeader />

      {snapshot.seasonal && <SeasonalBanner seasonal={snapshot.seasonal} />}

      <section aria-labelledby="badges-heading">
        <SectionHeader
          id="badges-heading"
          icon={<Award size={16} />}
          title={t("Badges")}
          subtitle={`${earnedBadgeCount} of ${snapshot.badges.length} earned`}
        />
        {snapshot.badges.length === 0 ? (
          <EmptyCard
            icon={<Award size={32} className="text-fg-mute" />}
            title={t("No badges yet")}
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
          title={t("Active challenges")}
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
            icon={<Target size={32} className="text-fg-mute" />}
            title={t("No challenges to join yet")}
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

      <RegionalLeaderboardsSection />

      {nextMilestone && (
        <section aria-labelledby="milestone-heading">
          <SectionHeader
            id="milestone-heading"
            icon={<Heart size={16} />}
            title={t("Next milestone")}
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
      <h1 className="text-2xl font-bold">{t("Achievements")}</h1>
      <p className="text-sm text-fg-dim mt-1">
        {t(
          "Badges, challenges, leaderboards, and milestones for your riding region. ",
        )}
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
      aria-label={t("Seasonal challenge")}
      className="relative overflow-hidden rounded-2xl border border-accent/30 bg-gradient-to-r from-accent/10 via-paper to-violet-500/10 p-6"
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
          {t("Seasonal \u00B7 {season}", { season: seasonal.season })}
        </div>
        <h2 className="mt-2 text-2xl font-bold text-ink">{seasonal.name}</h2>
        <p className="mt-1 text-sm text-ink">{seasonal.tagline}</p>
        <p className="mt-2 text-xs text-fg-dim max-w-xl">
          {seasonal.description}
        </p>

        <div className="mt-5 flex flex-col gap-2 max-w-md">
          <div className="flex items-center justify-between text-xs text-ink">
            <span className="tabular-nums">
              {Math.round(seasonal.current).toLocaleString()} /{" "}
              {seasonal.target.toLocaleString()} {seasonal.unit}
            </span>
            <span className="text-fg-dim">{daysLeft}</span>
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
          ? "border-accent/40 bg-accent/5"
          : "border-line bg-cream/60 opacity-60",
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
          earned ? "bg-accent/15 text-accent" : "bg-paper text-fg-dim",
        )}
      >
        {earned ? <Icon size={24} /> : <Lock size={20} />}
      </span>
      <p
        className={clsx(
          "mt-3 text-sm font-semibold",
          earned ? "text-ink" : "text-fg-dim",
        )}
      >
        {badge.name}
      </p>
      <p className="mt-1 text-[11px] text-fg-dim line-clamp-2">
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
    <div className="rounded-xl border border-line bg-cream p-4">
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
          <p className="mt-1.5 text-sm font-semibold text-ink">
            {challenge.name}
          </p>
          <p className="mt-0.5 text-xs text-fg-dim">{challenge.description}</p>
        </div>
        <span className="shrink-0 text-[11px] text-fg-dim">
          {formatDaysRemaining(challenge.endsAt)}
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-ink tabular-nums">
            {Math.round(challenge.current).toLocaleString()} /{" "}
            {challenge.target.toLocaleString()} {challenge.unit}
          </span>
          <span
            className={clsx(
              "tabular-nums",
              complete ? "text-accent" : "text-fg-dim",
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
        <div className="text-[11px] text-fg-dim flex items-center gap-3">
          {challenge.reward && (
            <span className="flex items-center gap-1">
              <Medal size={12} />
              {t("Reward: {reward}", { reward: challenge.reward })}
            </span>
          )}
          {meta && (
            <span className="flex items-center gap-1">
              <Users size={12} /> {meta.participantCount.toLocaleString()}
            </span>
          )}
        </div>
        {joined ? (
          <span className="text-[11px] uppercase tracking-widest text-accent">
            {t("Joined")}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onJoin(challenge.id)}
            disabled={joining}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent/15 text-accent text-xs font-semibold hover:bg-accent/25 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {joining ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {t("Joining\u2026")}
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
function RegionalLeaderboardsSection() {
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
        });
        if (signal.aborted) return;
        setLoad({ status: "ready", data });
      } catch (err) {
        if (signal.aborted) return;
        setLoad({
          status: "error",
          message:
            err instanceof Error ? err.message : "Could not load leaderboards.",
        });
      }
    },
    [region, userId],
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
        icon={<Trophy size={16} />}
        title={t("Regional leaderboards")}
        subtitle={
          scope === "region" && homeRegion
            ? `Top riders in ${homeRegion}, ranked by ${labelForDimension(dimension).toLowerCase()}.`
            : `Top riders worldwide, ranked by ${labelForDimension(dimension).toLowerCase()}.`
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <RegionToggle
          scope={scope}
          homeRegion={homeRegion}
          onChange={setScope}
        />
        <DimensionTabs current={dimension} onChange={setDimension} />
      </div>

      {load.status === "error" ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-900/60 bg-red-950/30 p-6 text-center"
        >
          <AlertTriangle className="mx-auto text-red-300 mb-2" size={24} />
          <p className="text-red-200 font-medium">
            {t("Could not load leaderboards")}
          </p>
          <p className="text-red-300/80 text-sm mt-1">{load.message}</p>
        </div>
      ) : load.status === "loading" || dim === null ? (
        <div className="h-48 rounded-2xl bg-cream border border-line animate-pulse" />
      ) : (
        <RegionalLeaderboardTable dim={dim} />
      )}
    </section>
  );
}
function RegionToggle({
  scope,
  homeRegion,
  onChange,
}: {
  scope: RegionScope;
  homeRegion: string | null;
  onChange: (scope: RegionScope) => void;
}) {
  // Hide the My-region option when no home_region is set — toggling to it
  // would just show the global ranking again with extra steps.
  return (
    <div
      role="radiogroup"
      aria-label={t("Region scope")}
      className="inline-flex rounded-lg border border-line bg-cream p-0.5 text-xs"
    >
      <ToggleButton
        active={scope === "global"}
        onClick={() => onChange("global")}
        ariaLabel="Global ranking"
      >
        {t("Global")}
      </ToggleButton>
      {homeRegion && (
        <ToggleButton
          active={scope === "region"}
          onClick={() => onChange("region")}
          ariaLabel={`Riders from ${homeRegion}`}
        >
          <MapIcon size={12} className="mr-1 inline" />
          {homeRegion}
        </ToggleButton>
      )}
    </div>
  );
}
function DimensionTabs({
  current,
  onChange,
}: {
  current: LeaderboardDimensionKey;
  onChange: (dim: LeaderboardDimensionKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={t("Leaderboard dimension")}
      className="inline-flex rounded-lg border border-line bg-cream p-0.5 text-xs"
    >
      {LEADERBOARD_DIMENSION_KEYS.map((dim) => (
        <ToggleButton
          key={dim}
          active={current === dim}
          onClick={() => onChange(dim)}
          ariaLabel={labelForDimension(dim)}
        >
          {labelForDimension(dim)}
        </ToggleButton>
      ))}
    </div>
  );
}
function ToggleButton({
  active,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={clsx(
        "px-3 py-1.5 rounded-md transition",
        active ? "bg-accent/15 text-accent" : "text-fg-dim hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
function RegionalLeaderboardTable({
  dim,
}: {
  dim: RegionalDimensionLeaderboard;
}) {
  // Surface `me` even when outside the top N. The backend already excludes
  // duplicates by design — `entries` and `me` only ever overlap on the same
  // row when the rider ranks in the visible window, in which case `me.rank`
  // matches one of the entries.
  const showOutsideTop =
    dim.me !== null && !dim.entries.some((e) => e.userId === dim.me?.userId);
  return (
    <div className="rounded-2xl border border-line bg-cream overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-fg-dim bg-cream/80">
              <th className="py-3 px-4 font-semibold w-12">#</th>
              <th className="py-3 px-4 font-semibold">{t("Rider")}</th>
              <th className="py-3 px-4 font-semibold text-right">{dim.unit}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {dim.entries.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="py-8 px-4 text-center text-sm text-fg-dim"
                >
                  {t("No riders ranked in this region yet. ")}
                </td>
              </tr>
            ) : (
              dim.entries.map((entry) => (
                <RegionalLeaderboardRow
                  key={entry.userId}
                  entry={entry}
                  unit={dim.unit}
                />
              ))
            )}
            {showOutsideTop && dim.me && (
              <RegionalLeaderboardRow
                entry={dim.me}
                unit={dim.unit}
                outsideTop
              />
            )}
          </tbody>
        </table>
      </div>
      {dim.me && <RegionalLeaderboardSummary me={dim.me} unit={dim.unit} />}
    </div>
  );
}
function RegionalLeaderboardRow({
  entry,
  unit,
  outsideTop = false,
}: {
  entry: RegionalLeaderboardEntry;
  unit: string;
  outsideTop?: boolean;
}) {
  return (
    <tr
      className={clsx(
        "text-ink",
        entry.isMe && "bg-accent/5",
        outsideTop && "border-t-2 border-line-strong/60",
      )}
    >
      <td className="py-3 px-4">
        <RankBadge rank={entry.rank} />
      </td>
      <td className="py-3 px-4">
        <div className="font-medium">
          {entry.displayName}
          {entry.isMe && (
            <span className="ml-2 text-[10px] uppercase tracking-widest text-accent">
              {t("You")}
            </span>
          )}
          {entry.homeRegion && (
            <span className="ml-2 text-[11px] text-fg-dim">
              · {entry.homeRegion}
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right tabular-nums">
        {Math.round(entry.value).toLocaleString()} {unit}
      </td>
    </tr>
  );
}
function RegionalLeaderboardSummary({
  me,
  unit,
}: {
  me: RegionalLeaderboardEntry;
  unit: string;
}) {
  return (
    <div className="border-t border-line px-4 py-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-dim">
      <span className="text-fg-dim uppercase tracking-widest font-semibold">
        {t("Your rank")}
      </span>
      <span className="tabular-nums">
        #{me.rank}{" "}
        <span className="text-fg-dim">
          · {Math.round(me.value).toLocaleString()} {unit}
        </span>
      </span>
    </div>
  );
}
function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-amber-400/30 text-amber-700">
        <Trophy size={14} />
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-paper text-ink border border-line">
        <Medal size={14} />
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-700">
        <Medal size={14} />
      </span>
    );
  }
  return (
    <span className="inline-flex w-7 h-7 items-center justify-center text-sm text-fg-dim tabular-nums">
      {rank}
    </span>
  );
}
// ── Milestone ──
function MilestoneCard({ progress }: { progress: MilestoneProgress }) {
  const percent = Math.round(progress.fraction * 100);
  const label = formatMilestoneLabel(progress);
  return (
    <div className="rounded-2xl border border-line bg-cream p-5">
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
          {percent}%
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-ink tabular-nums">
          <span>{label}</span>
          {progress.nextThreshold !== null && (
            <span className="text-fg-dim">
              {t("{count} to go", {
                count: Math.round(progress.remaining).toLocaleString(),
              })}
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
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-line-strong bg-cream text-fg-dim",
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
  subtitle,
}: {
  id?: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-ink">
        <span className="text-accent">{icon}</span>
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
      </div>
      {subtitle && <p className="text-xs text-fg-dim mt-0.5">{subtitle}</p>}
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
    <div className="rounded-2xl border border-line bg-cream p-10 text-center">
      <div className="mx-auto w-10 h-10 flex items-center justify-center mb-3">
        {icon}
      </div>
      <p className="text-ink font-medium">{title}</p>
      <p className="text-fg-dim text-sm mt-1">{body}</p>
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
      <p className="text-red-200 font-medium">
        {t("Could not load achievements")}
      </p>
      <p className="text-red-300/80 text-sm mt-1">{message}</p>
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
function SkeletonGrid() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <div className="h-32 rounded-2xl bg-cream border border-line animate-pulse" />
      <div>
        <div className="mb-3 h-4 w-24 bg-paper rounded animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-xl bg-cream border border-line animate-pulse"
            />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 h-4 w-32 bg-paper rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-36 rounded-xl bg-cream border border-line animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
