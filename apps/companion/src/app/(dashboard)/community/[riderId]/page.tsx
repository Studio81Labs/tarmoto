"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Award,
  Bike as BikeIcon,
  Calendar,
  Compass,
  Gauge,
  Loader2,
  Lock,
  MapPin,
  Moon,
  Mountain,
  Route,
  Trophy,
  UserCheck,
  UserPlus,
  Wind,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { formatDate, formatDistance, formatDuration } from "@/lib/utils";
import {
  buildStatTiles,
  countEarnedBadges,
  fetchRiderProfile,
  followRider,
  formatHours,
  formatJoinedLabel,
  pickShowcaseBike,
  RiderProfileNotFoundError,
  sortBadges,
  unfollowRider,
  type RiderProfileDetail,
} from "@/lib/rider-profile";

const BADGE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  compass: Compass,
  mountain: Mountain,
  moon: Moon,
  wind: Wind,
  trophy: Trophy,
};

export default function RiderProfilePage() {
  const { riderId } = useParams<{ riderId: string }>();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const accessToken = useAuthStore((s) => s.accessToken);

  const [profile, setProfile] = useState<RiderProfileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingDemo, setUsingDemo] = useState(false);
  const [followPending, setFollowPending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  useEffect(() => {
    if (!riderId) return;
    // `cancelled` guards every setState inside the async chain, including the
    // `.finally`, because AbortError is swallowed by the fetcher. Without this
    // the old effect's `setLoading(false)` can land after the new effect has
    // already called `setLoading(true)`, flashing stale content during a
    // riderId or accessToken switch. Pattern matches the other ride pages.
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setNotFound(false);
    setError(null);
    fetchRiderProfile(riderId, {
      signal: controller.signal,
      accessToken,
    })
      .then(({ profile: next, fromFallback }) => {
        if (cancelled) return;
        setProfile(next);
        setUsingDemo(fromFallback);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
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
  }, [riderId, accessToken]);

  const isSelf = profile?.id === currentUserId;
  const showcaseBike = useMemo(
    () => (profile ? pickShowcaseBike(profile.bikes) : null),
    [profile],
  );
  const statTiles = useMemo(
    () => (profile ? buildStatTiles(profile.stats) : []),
    [profile],
  );
  const badgeEntries = useMemo(
    () => (profile ? sortBadges(profile.badges) : []),
    [profile],
  );
  const earnedCount = countEarnedBadges(badgeEntries);

  async function handleFollowToggle() {
    if (!profile || followPending || isSelf) return;
    const wasFollowing = profile.isFollowing;
    // Optimistic toggle via the functional setter so a concurrent profile
    // re-fetch (e.g. token refresh) isn't silently overwritten by this stale
    // closure — we only touch `isFollowing` and leave the rest of whatever
    // React holds as the current profile.
    setProfile((prev) =>
      prev ? { ...prev, isFollowing: !wasFollowing } : prev,
    );
    setFollowPending(true);
    setFollowError(null);
    try {
      if (wasFollowing) {
        await unfollowRider(profile.id, accessToken);
      } else {
        await followRider(profile.id, accessToken);
      }
    } catch (err) {
      setProfile((prev) =>
        prev ? { ...prev, isFollowing: wasFollowing } : prev,
      );
      const message =
        err instanceof Error ? err.message : "Could not update follow";
      setFollowError(message);
    } finally {
      setFollowPending(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto animate-fade-in">
      <Link
        href="/community"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-6 transition"
      >
        <ArrowLeft size={16} /> Community
      </Link>

      {loading ? (
        <ProfileSkeleton />
      ) : notFound ? (
        <EmptyState
          title="Rider not found"
          message="This profile is either private or no longer exists."
        />
      ) : error || !profile ? (
        <EmptyState
          title="Could not load profile"
          message={error ?? "Please try again in a moment."}
        />
      ) : (
        <>
          {usingDemo && (
            <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
              Showing a preview profile — the community backend is still being
              wired up, so these numbers are illustrative.
            </div>
          )}

          <Header
            profile={profile}
            isSelf={isSelf}
            followPending={followPending}
            followError={followError}
            onToggleFollow={handleFollowToggle}
            showcaseBike={showcaseBike}
          />

          <StatsRow tiles={statTiles} totalHours={profile.stats.totalHours} />

          <BadgesSection
            badges={badgeEntries}
            earnedCount={earnedCount}
            total={badgeEntries.length}
          />

          <CollectionsSection
            collections={profile.collections}
            displayName={profile.displayName}
          />

          <RecentRidesSection
            rides={profile.recentRides}
            displayName={profile.displayName}
          />

          <GarageSection bikes={profile.bikes} />
        </>
      )}
    </div>
  );
}

// ── Header ──

interface HeaderProps {
  profile: RiderProfileDetail;
  isSelf: boolean;
  followPending: boolean;
  followError: string | null;
  onToggleFollow: () => void;
  showcaseBike: ReturnType<typeof pickShowcaseBike>;
}

function Header({
  profile,
  isSelf,
  followPending,
  followError,
  onToggleFollow,
  showcaseBike,
}: HeaderProps) {
  const initials = profile.displayName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="shrink-0">
          {profile.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatarUrl}
              alt={profile.displayName}
              className="w-20 h-20 rounded-full object-cover border-2 border-slate-800"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-2xl font-bold">
              {initials || "?"}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white truncate">
            {profile.displayName}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-slate-400">
            {profile.homeRegion && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {profile.homeRegion}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Calendar size={12} /> {formatJoinedLabel(profile.stats.joinedAt)}
            </span>
            {showcaseBike && (
              <span className="inline-flex items-center gap-1">
                <BikeIcon size={12} /> {showcaseBike.make} {showcaseBike.model}
              </span>
            )}
          </div>
          {profile.bio && (
            <p className="text-sm text-slate-300 mt-3 leading-relaxed">
              {profile.bio}
            </p>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-stretch sm:items-end gap-2">
          {isSelf ? (
            <Link
              href="/settings"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
            >
              Edit profile
            </Link>
          ) : (
            <button
              type="button"
              onClick={onToggleFollow}
              disabled={followPending}
              aria-pressed={profile.isFollowing}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed ${
                profile.isFollowing
                  ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  : "bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan/90"
              }`}
            >
              {followPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : profile.isFollowing ? (
                <UserCheck size={14} />
              ) : (
                <UserPlus size={14} />
              )}
              {profile.isFollowing ? "Following" : "Follow"}
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
  tiles: ReturnType<typeof buildStatTiles>;
  totalHours: number;
}

function StatsRow({ tiles, totalHours }: StatsRowProps) {
  return (
    <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="rounded-xl bg-slate-900 border border-slate-800 p-4"
        >
          <p className="text-xs uppercase tracking-wider text-slate-500">
            {tile.label}
          </p>
          <p className="text-xl font-bold text-white mt-1 tabular-nums">
            {tile.value}
          </p>
          {tile.key === "totalRides" && (
            <p className="text-xs text-slate-500 mt-1">
              {formatHours(totalHours)} on the saddle
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

// ── Badges ──

interface BadgesSectionProps {
  badges: ReturnType<typeof sortBadges>;
  earnedCount: number;
  total: number;
}

function BadgesSection({ badges, earnedCount, total }: BadgesSectionProps) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <Award size={14} /> Badges
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {earnedCount} of {total} earned
        </span>
      </header>
      {badges.length === 0 ? (
        <p className="text-sm text-slate-500">No badges available yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {badges.map((entry) => {
            const Icon = BADGE_ICON[entry.badge.icon] ?? Trophy;
            return (
              <div
                key={entry.badge.id}
                className={`rounded-xl border p-3 flex flex-col items-center text-center transition ${
                  entry.earned
                    ? "border-tarmoto-cyan/30 bg-tarmoto-cyan/5"
                    : "border-slate-800 bg-slate-950/50 opacity-60"
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center mb-2 ${
                    entry.earned
                      ? "bg-tarmoto-cyan/20 text-tarmoto-cyan"
                      : "bg-slate-800 text-slate-500"
                  }`}
                >
                  {entry.earned ? <Icon size={20} /> : <Lock size={16} />}
                </div>
                <p className="text-xs font-semibold text-slate-200">
                  {entry.badge.name}
                </p>
                <p className="text-[11px] text-slate-500 mt-1 leading-tight">
                  {entry.badge.description}
                </p>
                {entry.earnedLabel && (
                  <p className="text-[10px] text-tarmoto-cyan mt-1 tabular-nums">
                    {entry.earnedLabel}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Collections ──

interface CollectionsSectionProps {
  collections: RiderProfileDetail["collections"];
  displayName: string;
}

function CollectionsSection({
  collections,
  displayName,
}: CollectionsSectionProps) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <Route size={14} /> Route collections
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {collections.length}
        </span>
      </header>
      {collections.length === 0 ? (
        <p className="text-sm text-slate-500">
          {displayName} hasn&apos;t published any route collections yet.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {collections.map((collection) => (
            <li key={collection.id}>
              <Link
                href={`/community/collections/${collection.id}`}
                className="block rounded-xl bg-slate-950/40 border border-slate-800 p-4 hover:border-slate-700 transition"
              >
                <p className="font-medium text-white">{collection.name}</p>
                {collection.description && (
                  <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                    {collection.description}
                  </p>
                )}
                <p className="text-[11px] text-slate-500 mt-2">
                  {collection.routes.length} route
                  {collection.routes.length === 1 ? "" : "s"} ·{" "}
                  {formatDate(collection.createdAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Activity feed ──

interface RecentRidesSectionProps {
  rides: RiderProfileDetail["recentRides"];
  displayName: string;
}

function RecentRidesSection({ rides, displayName }: RecentRidesSectionProps) {
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <Gauge size={14} /> Recent shared rides
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {rides.length}
        </span>
      </header>
      {rides.length === 0 ? (
        <p className="text-sm text-slate-500">
          {displayName} hasn&apos;t shared any rides recently.
        </p>
      ) : (
        <ul className="space-y-2">
          {rides.map((ride) => (
            <li
              key={ride.id}
              className="flex items-center gap-4 p-3 rounded-xl bg-slate-950/40 border border-slate-800"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-white truncate">
                  {ride.name ?? `Ride on ${formatDate(ride.startedAt)}`}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={11} /> {formatDate(ride.startedAt)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Route size={11} /> {formatDistance(ride.distanceKm)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Gauge size={11} /> {formatDuration(ride.durationMinutes)}
                  </span>
                  {ride.region && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={11} /> {ride.region}
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-slate-500">Avg quality</p>
                <p className="text-sm font-semibold text-white tabular-nums">
                  {ride.avgQuality.toFixed(1)} / 5
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Garage ──

interface GarageSectionProps {
  bikes: RiderProfileDetail["bikes"];
}

function GarageSection({ bikes }: GarageSectionProps) {
  if (bikes.length === 0) return null;
  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <BikeIcon size={14} /> Garage
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {bikes.length}
        </span>
      </header>
      <ul className="grid gap-2 sm:grid-cols-2">
        {bikes.map((bike) => (
          <li
            key={bike.id}
            className="flex items-center gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800"
          >
            <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 shrink-0">
              <BikeIcon size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-white truncate">
                {bike.make} {bike.model}
              </p>
              <p className="text-xs text-slate-500 tabular-nums">
                {bike.year} · {Math.round(bike.totalKm).toLocaleString()} km
              </p>
            </div>
            {bike.isActive && (
              <span className="text-[10px] uppercase tracking-wider text-tarmoto-cyan bg-tarmoto-cyan/10 rounded-full px-2 py-0.5">
                Active
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Shared pieces ──

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
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
