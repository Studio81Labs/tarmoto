"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Award,
  Calendar,
  Loader2,
  Lock,
  MapPin,
  Trophy,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import {
  fetchPublicBadges,
  fetchPublicProfile,
  followRider,
  formatCount,
  formatJoinedLabel,
  initialsFromName,
  RiderProfileNotFoundError,
  unfollowRider,
  type PublicProfile,
  type UserBadge,
} from "@/lib/rider-profile";
import { SharedRidesSection } from "@/components/community/SharedRidesSection";
export default function RiderProfilePage() {
  const { riderId } = useParams<{
    riderId: string;
  }>();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followPending, setFollowPending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  // Tracks whichever rider this page is currently rendering. Read inside
  // async follow callbacks so a request that resolves after a navigation
  // can tell whether its riderId is still on screen before touching state.
  const activeRiderIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!riderId) return;
    // `cancelled` guards every setState inside the async chain because
    // AbortError is swallowed by the typed openapi client. Without this
    // the old effect's `setLoading(false)` can land after the new effect
    // has called `setLoading(true)`, flashing stale content during a
    // riderId or accessToken switch.
    let cancelled = false;
    const controller = new AbortController();
    activeRiderIdRef.current = riderId;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setFollowPending(false);
    setFollowError(null);
    Promise.all([
      fetchPublicProfile(riderId, { signal: controller.signal }),
      fetchPublicBadges(riderId, { signal: controller.signal }),
    ])
      .then(([nextProfile, nextBadges]) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setBadges(nextBadges);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (
          (
            err as {
              name?: string;
            }
          )?.name === "AbortError"
        )
          return;
        if (err instanceof RiderProfileNotFoundError) {
          setNotFound(true);
          return;
        }
        setError("Could not load rider profile");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // accessToken is captured by the typed client through the auth store; we
    // still depend on it so a sign-in / sign-out re-issues the requests.
  }, [riderId, accessToken]);
  const earnedBadges = useMemo(
    () => badges.filter((b) => b.earned_at != null),
    [badges],
  );
  async function handleFollowToggle() {
    if (!profile || followPending || profile.is_self) return;
    const targetId = profile.id;
    const wasFollowing = profile.is_following === true;
    // Optimistic toggle via the functional setter so a concurrent profile
    // re-fetch (e.g. token refresh) isn't silently overwritten by this stale
    // closure. The rider-id guard on every state update means a request
    // that resolves after the user navigates away can't corrupt the
    // newly loaded profile or surface a stale error/pending flag.
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
        await unfollowRider(targetId);
      } else {
        await followRider(targetId);
      }
    } catch (err) {
      if (activeRiderIdRef.current !== targetId) return;
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
      const message =
        err instanceof Error ? err.message : "Could not update follow";
      setFollowError(message);
    } finally {
      if (activeRiderIdRef.current === targetId) {
        setFollowPending(false);
      }
    }
  }
  return (
    <div className="p-6 max-w-5xl mx-auto animate-fade-in">
      <Link
        href="/community"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-6 transition"
      >
        <ArrowLeft size={16} />
        {t("Community")}
      </Link>

      {loading ? (
        <ProfileSkeleton />
      ) : notFound ? (
        <EmptyState
          title={t("Rider not found")}
          message="This profile is either private or no longer exists."
        />
      ) : error || !profile ? (
        <EmptyState
          title={t("Could not load profile")}
          message={error ?? "Please try again in a moment."}
        />
      ) : (
        <>
          <Header
            profile={profile}
            followPending={followPending}
            followError={followError}
            onToggleFollow={handleFollowToggle}
          />

          <StatsRow profile={profile} earnedBadgeCount={earnedBadges.length} />

          <BadgesSection badges={earnedBadges} totalBadges={badges.length} />

          <SharedRidesSection
            userId={profile.id}
            isSelf={profile.is_self}
            displayName={profile.display_name}
          />
        </>
      )}
    </div>
  );
}
// ── Header ──
interface HeaderProps {
  profile: PublicProfile;
  followPending: boolean;
  followError: string | null;
  onToggleFollow: () => void;
}
function Header({
  profile,
  followPending,
  followError,
  onToggleFollow,
}: HeaderProps) {
  const initials = initialsFromName(profile.display_name);
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="shrink-0">
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt={profile.display_name}
              className="w-20 h-20 rounded-full object-cover border-2 border-slate-800"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-2xl font-bold">
              {initials}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white truncate">
            {profile.display_name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-slate-400">
            {profile.home_region && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {profile.home_region}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Calendar size={12} /> {formatJoinedLabel(profile.created_at)}
            </span>
          </div>
          {profile.bio && (
            <p className="text-sm text-slate-300 mt-3 leading-relaxed">
              {profile.bio}
            </p>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-stretch sm:items-end gap-2">
          {profile.is_self ? (
            <Link
              href="/settings"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
            >
              {t("Edit profile")}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onToggleFollow}
              disabled={followPending}
              aria-pressed={profile.is_following === true}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed ${
                profile.is_following
                  ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  : "bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan/90"
              }`}
            >
              {followPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : profile.is_following ? (
                <UserCheck size={14} />
              ) : (
                <UserPlus size={14} />
              )}
              {profile.is_following ? "Following" : "Follow"}
            </button>
          )}
          {followError && (
            <span className="text-xs text-red-400 max-w-[14rem] text-right">
              {followError}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
// ── Stats ──
interface StatsRowProps {
  profile: PublicProfile;
  earnedBadgeCount: number;
}
function StatsRow({ profile, earnedBadgeCount }: StatsRowProps) {
  const tiles = [
    { key: "followers", label: "Followers", value: profile.follower_count },
    { key: "following", label: "Following", value: profile.following_count },
    { key: "badges", label: "Badges earned", value: earnedBadgeCount },
  ];
  return (
    <section className="grid grid-cols-3 gap-3 mb-6">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="rounded-xl bg-slate-900 border border-slate-800 p-4"
        >
          <p className="text-xs uppercase tracking-wider text-slate-500">
            {tile.label}
          </p>
          <p className="text-xl font-bold text-white mt-1 tabular-nums">
            {formatCount(tile.value)}
          </p>
        </div>
      ))}
    </section>
  );
}
// ── Badges ──
interface BadgesSectionProps {
  badges: UserBadge[];
  totalBadges: number;
}
function BadgesSection({ badges, totalBadges }: BadgesSectionProps) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <Award size={14} />
          {t("Badges earned")}
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {t("{count} of {total}", {
            count: badges.length,
            total: totalBadges,
          })}
        </span>
      </header>
      {totalBadges === 0 ? (
        <p className="text-sm text-slate-500">
          {t("No badges available yet.")}
        </p>
      ) : badges.length === 0 ? (
        <p className="text-sm text-slate-500 inline-flex items-center gap-2">
          <Lock size={12} />
          {t("No badges earned yet.")}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {badges.map((badge) => (
            <div
              key={badge.key}
              className="rounded-xl border border-tarmoto-cyan/30 bg-tarmoto-cyan/5 p-3 flex flex-col items-center text-center"
            >
              <div className="w-10 h-10 rounded-full bg-tarmoto-cyan/20 text-tarmoto-cyan flex items-center justify-center mb-2">
                <Trophy size={20} />
              </div>
              <p className="text-xs font-semibold text-slate-200">
                {badge.name}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 leading-tight">
                {badge.description}
              </p>
              {badge.tier && (
                <p className="text-[10px] uppercase tracking-wider text-tarmoto-cyan mt-1">
                  {badge.tier}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
// ── Shared pieces ──
function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 rounded-xl bg-slate-900 border border-slate-800 animate-pulse"
          />
        ))}
      </div>
      <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
    </div>
  );
}
function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-12 text-center">
      <p className="text-slate-300 font-medium mb-1">{title}</p>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}
