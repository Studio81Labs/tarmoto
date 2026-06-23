"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Lock,
  MapPin,
  Trophy,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { Button, MetricTile, Mono, Stamp } from "@tarmoto/ui";
import { splitFormattedDistance } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
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

// Medal colours for earned-badge tiers. Keyed by the lowercase tier the
// gamification service emits (`bronze` / `silver` / `gold`); the card border,
// icon ring, and tier label all share the colour.
const TIER_COLOR: Record<string, string> = {
  gold: "#C99A2E",
  silver: "#8C9196",
  bronze: "#B06A38",
};
function tierColor(tier: string | null): string {
  return (tier && TIER_COLOR[tier.toLowerCase()]) || "var(--color-fg-mute)";
}

export default function RiderProfilePage() {
  const { riderId } = useParams<{ riderId: string }>();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followPending, setFollowPending] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  // Tracks whichever rider this page is currently rendering. Read inside
  // async follow callbacks so a request that resolves after a navigation can
  // tell whether its riderId is still on screen before touching state.
  const activeRiderIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!riderId) return;
    // `cancelled` guards every setState inside the async chain because
    // AbortError is swallowed by the typed openapi client. Without this the
    // old effect's `setLoading(false)` can land after the new effect has
    // called `setLoading(true)`, flashing stale content during a riderId or
    // accessToken switch.
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
    // closure. The rider-id guard on every state update means a request that
    // resolves after the user navigates away can't corrupt the newly loaded
    // profile or surface a stale error/pending flag.
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <Link
        href="/community/feed"
        className="mb-4 inline-flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-fg-dim transition hover:text-ink"
      >
        <ArrowLeft size={14} />
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
    <div className="mb-4 rounded-[14px] border border-line bg-cream p-5 md:p-[26px]">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="shrink-0">
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt={profile.display_name}
              className="h-[88px] w-[88px] rounded-full border-2 border-ink object-cover"
            />
          ) : (
            <div className="flex h-[88px] w-[88px] items-center justify-center rounded-full border-2 border-ink bg-accent text-[32px] font-extrabold text-ink">
              {initials}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Stamp tone="accent">{t("Rider")}</Stamp>
            {profile.follows_you === true && (
              <span className="inline-flex items-center rounded-full border border-line-strong bg-paper px-2.5 py-0.5 text-[11px] font-semibold text-fg-dim">
                {t("Follows you")}
              </span>
            )}
          </div>
          <h1 className="mt-1 truncate text-[28px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink md:text-[34px]">
            {profile.display_name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-fg-dim">
            {profile.home_region && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={14} className="text-fg-mute" />
                {profile.home_region}
              </span>
            )}
            {profile.home_region && <span className="text-fg-mute">·</span>}
            <span>{formatJoinedLabel(profile.created_at)}</span>
          </div>
          {profile.bio && (
            <p className="mt-3 max-w-[560px] text-[15px] leading-[1.5] text-ink">
              {profile.bio}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          {profile.is_self ? (
            <Button
              variant="secondary"
              uppercase
              renderLink={({ className, children }) => (
                <Link href="/settings/profile" className={className}>
                  {children}
                </Link>
              )}
            >
              {t("Edit profile")}
            </Button>
          ) : (
            <Button
              variant={profile.is_following ? "secondary" : "accent"}
              uppercase
              loading={followPending}
              leftIcon={
                profile.is_following ? (
                  <UserCheck size={14} />
                ) : (
                  <UserPlus size={14} />
                )
              }
              onClick={onToggleFollow}
              aria-pressed={profile.is_following === true}
            >
              {profile.is_following ? t("Following") : t("Follow")}
            </Button>
          )}
          {followError && (
            <span className="max-w-[14rem] text-right text-xs text-red-500">
              {followError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stats ──
interface StatsRowProps {
  profile: PublicProfile;
  earnedBadgeCount: number;
}
function StatsRow({ profile, earnedBadgeCount }: StatsRowProps) {
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const distance = splitFormattedDistance(
    profile.total_distance_km,
    unitSystem,
  );
  return (
    <div className="mb-4 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5">
      {/* Distance — the dark hero tile (accent number). */}
      <MetricTile
        variant="ink"
        accentNumber
        label={t("Distance")}
        value={Math.round(distance.value)}
        unit={distance.unit}
        formatValue={formatCount}
      />
      <MetricTile
        label={t("Rides shared")}
        value={profile.shared_ride_count}
        formatValue={formatCount}
      />
      <MetricTile
        label={t("Followers")}
        value={profile.follower_count}
        formatValue={formatCount}
      />
      <MetricTile
        label={t("Following")}
        value={profile.following_count}
        formatValue={formatCount}
      />
      <MetricTile
        label={t("Badges")}
        value={earnedBadgeCount}
        formatValue={formatCount}
      />
    </div>
  );
}

// ── Badges ──
interface BadgesSectionProps {
  badges: UserBadge[];
  totalBadges: number;
}
function BadgesSection({ badges, totalBadges }: BadgesSectionProps) {
  return (
    <div className="mb-4 rounded-[14px] border border-line bg-cream p-[22px]">
      <header className="mb-4 flex items-end justify-between">
        <div className="flex items-center gap-2.5">
          <Trophy size={18} className="text-accent" />
          <div>
            <Stamp as="h2">{t("Badges earned")}</Stamp>
            <div className="mt-0.5 text-[20px] font-extrabold tracking-[-0.5px] text-ink">
              {t("Trophies")}
            </div>
          </div>
        </div>
        {totalBadges > 0 && (
          <Mono className="text-[12px] text-fg-dim">
            {t("{count} of {total}", {
              count: badges.length,
              total: totalBadges,
            })}
          </Mono>
        )}
      </header>

      {totalBadges === 0 ? (
        <p className="text-sm text-fg-dim">{t("No badges available yet.")}</p>
      ) : badges.length === 0 ? (
        <p className="inline-flex items-center gap-2 text-sm text-fg-dim">
          <Lock size={12} />
          {t("No badges earned yet.")}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          {badges.map((badge) => (
            <BadgeCard key={badge.key} badge={badge} />
          ))}
        </div>
      )}
    </div>
  );
}
function BadgeCard({ badge }: { badge: UserBadge }) {
  const color = tierColor(badge.tier);
  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-[14px] border bg-cream p-[18px] text-center"
      style={{ borderColor: color }}
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full border-2"
        style={{
          borderColor: color,
          color,
          backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
        }}
      >
        <Trophy size={22} />
      </div>
      <div className="text-sm font-extrabold text-ink">{badge.name}</div>
      <p className="min-h-[30px] text-[11px] leading-tight text-fg-dim">
        {badge.description}
      </p>
      {badge.tier && (
        <span
          className="font-mono text-[10px] font-extrabold uppercase tracking-[1.5px]"
          style={{ color }}
        >
          {badge.tier}
        </span>
      )}
    </div>
  );
}

// ── Shared pieces ──
function ProfileSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-40 animate-pulse rounded-[14px] border border-line bg-cream" />
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-[14px] border border-line bg-cream"
          />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-[14px] border border-line bg-cream" />
    </div>
  );
}
function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-cream p-12 text-center">
      <p className="mb-1 font-bold text-ink">{title}</p>
      <p className="text-sm text-fg-dim">{message}</p>
    </div>
  );
}
