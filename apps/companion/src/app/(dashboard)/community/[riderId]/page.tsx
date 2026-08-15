"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { notFound as renderNotFound, useParams } from "next/navigation";
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
import { useAuthStore } from "@/stores/auth";
import { useFormat } from "@/format/FormatProvider";
import {
  fetchPublicBadges,
  fetchPublicProfile,
  followRider,
  formatCount,
  formatJoinedLabel,
  RiderProfileNotFoundError,
  unfollowRider,
  type PublicProfile,
  type UserBadge,
} from "@/lib/rider-profile";
import { UserAvatar } from "@/components/UserAvatar";
import { SharedRidesSection } from "@/components/community/SharedRidesSection";
import { badgeCopyForKey, badgeTierLabel } from "@/lib/gamification";
import { useSystemSwitch } from "@/hooks/useEntitlements";
import { SystemSwitchGate } from "@/components/entitlements/SystemSwitchGate";

// Medal colours for earned-badge tiers. Keyed by the lowercase tier the
// gamification service emits (`bronze` / `silver` / `gold`); the card border,
// icon ring, and tier label all share the colour.
const TIER_COLOR: Record<string, string> = {
  gold: "#C99A2E",
  silver: "#8C9196",
  bronze: "#B06A38",
};
function tierColor(tier: string | null): string {
  // Badge tiers are canonical API enum tokens.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return (tier && TIER_COLOR[tier.toLowerCase()]) || "var(--color-fg-mute)";
}

export default function RiderProfilePage() {
  // Declared before the fetch effect below, which depends on it.
  const { enabled: gamificationEnabled } = useSystemSwitch("sys_gamification");
  const t = useTranslation();
  const { riderId } = useParams<{ riderId: string }>();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [badgesFailed, setBadgesFailed] = useState(false);
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
    fetchPublicProfile(riderId, { signal: controller.signal, translate: t })
      .then((nextProfile) => {
        if (cancelled) return;
        setProfile(nextProfile);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        if (err instanceof RiderProfileNotFoundError) {
          setNotFound(true);
          return;
        }
        setError(t("Could not load rider profile"));
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
  }, [t, riderId, accessToken]);

  // Badges are the only gamification-scoped half of this page, and they get
  // their OWN effect deliberately. Sharing the profile's effect meant an
  // operator flip re-issued `fetchPublicProfile` as well: a slow response
  // replaced a valid profile with a skeleton, and a transient failure replaced
  // it with "Could not load profile" — for a change that only affects the
  // badge shelf and its metric. The profile is not gamification-gated, so
  // nothing about this switch should be able to take it down.
  useEffect(() => {
    if (!riderId) return;
    if (!gamificationEnabled) {
      // Drop what we hold instead of hiding it: the rider can earn badges
      // while the subsystem is paused, so restoring has to show a fresh list
      // rather than whatever was on screen before the shutdown.
      setBadges([]);
      setBadgesFailed(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setBadgesFailed(false);
    fetchPublicBadges(riderId, { signal: controller.signal })
      .then((nextBadges) => {
        if (cancelled) return;
        setBadges(nextBadges);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        // Say the shelf failed rather than render it empty. "No badges earned
        // yet" is a claim about the RIDER, and letting a failed request make
        // it is the mislabelling this epic exists to prevent — the same reason
        // the switch gets a notice instead of an empty shelf.
        setBadges([]);
        setBadgesFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `accessToken`: same as above — captured by the client, depended on so a
    // sign-in / sign-out re-issues the request.
  }, [riderId, accessToken, gamificationEnabled]);

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
        await unfollowRider(targetId, t);
      } else {
        await followRider(targetId, t);
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
      const message = getUserFacingErrorMessage(
        err,
        t("Could not update follow"),
      );
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
        // Private / deleted profiles render the app-level v2 404 screen.
        renderNotFound()
      ) : error || !profile ? (
        <EmptyState
          title={t("Could not load profile")}
          message={error ?? t("Please try again in a moment.")}
        />
      ) : (
        <>
          <Header
            profile={profile}
            followPending={followPending}
            followError={followError}
            onToggleFollow={handleFollowToggle}
          />

          {/* `earnedBadgeCount` comes from the SAME array as the shelf, so
              gating only the shelf would leave an adjacent "Badges: 0" metric
              reporting the shutdown as the rider having earned nothing. A
              failed fetch is dropped for the same reason: the count would
              otherwise report zero on the strength of a network error. */}
          <StatsRow
            profile={profile}
            earnedBadgeCount={
              gamificationEnabled && !badgesFailed ? earnedBadges.length : null
            }
          />

          {!gamificationEnabled ? (
            <SystemSwitchGate feature="sys_gamification">
              {null}
            </SystemSwitchGate>
          ) : badgesFailed ? (
            <EmptyState
              title={t("Could not load badges")}
              message={t("Please try again in a moment.")}
            />
          ) : (
            <BadgesSection badges={earnedBadges} totalBadges={badges.length} />
          )}

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
  const t = useTranslation();
  return (
    <div className="mb-4 rounded-[14px] border border-line bg-cream p-5 md:p-[26px]">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="shrink-0">
          <UserAvatar
            avatarUrl={profile.avatar_url}
            name={profile.display_name}
            size={88}
            fontSize={32}
            className="border-2 border-ink"
          />
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
            <span>{formatJoinedLabel(profile.created_at, new Date(), t)}</span>
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
  /** `null` when `sys_gamification` is off: the badge count is unknown, not
   *  zero, and the tile is dropped rather than reporting a shutdown as the
   *  rider having earned nothing. */
  earnedBadgeCount: number | null;
}
function StatsRow({ profile, earnedBadgeCount }: StatsRowProps) {
  const t = useTranslation();
  const format = useFormat();
  // `splitDistanceKm().value` is already a locale-formatted string (grouping,
  // decimal), so it renders as-is — MetricTile only runs `formatValue` for a
  // raw numeric `value`.
  const distance = format.splitDistanceKm(profile.total_distance_km);
  const formatValue = (n: number) => formatCount(n, format.locale);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5">
      {/* Distance — the dark hero tile (accent number). */}
      <MetricTile
        variant="ink"
        accentNumber
        label={t("Distance")}
        value={distance.value}
        unit={distance.unit}
        unitPosition={distance.unitPosition}
      />
      <MetricTile
        label={t("Rides shared")}
        value={profile.shared_ride_count}
        formatValue={formatValue}
      />
      <MetricTile
        label={t("Followers")}
        value={profile.follower_count}
        formatValue={formatValue}
      />
      <MetricTile
        label={t("Following")}
        value={profile.following_count}
        formatValue={formatValue}
      />
      {earnedBadgeCount !== null && (
        <MetricTile
          label={t("Badges")}
          value={earnedBadgeCount}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

// ── Badges ──
interface BadgesSectionProps {
  badges: UserBadge[];
  totalBadges: number;
}
function BadgesSection({ badges, totalBadges }: BadgesSectionProps) {
  const t = useTranslation();
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
  const t = useTranslation();
  const color = tierColor(badge.tier);
  const copy = badgeCopyForKey(badge.key, t);
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
      <div className="text-sm font-extrabold text-ink">{copy.name}</div>
      <p className="min-h-[30px] text-[11px] leading-tight text-fg-dim">
        {copy.description}
      </p>
      {badge.tier && (
        <span
          className="font-mono text-[10px] font-extrabold uppercase tracking-[1.5px]"
          style={{ color }}
        >
          {badgeTierLabel(badge.tier, t)}
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
