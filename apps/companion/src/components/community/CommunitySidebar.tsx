"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useState } from "react";
import { useSystemSwitch } from "@/hooks/useEntitlements";
import { SystemSwitchGate } from "@/components/entitlements/SystemSwitchGate";
import Link from "next/link";
import { Button, Stamp, Mono } from "@tarmoto/ui";
import {
  challengeContentKeyForMetric,
  isDistanceChallengeMetric,
  type Formatters,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";
import { UserAvatar } from "@/components/UserAvatar";
import { useFormat } from "@/format/FormatProvider";
import {
  fetchActiveChallengeCard,
  fetchSuggestedRiders,
  type ActiveChallengeCard,
  type SuggestedRider,
} from "@/lib/community-sidebar";
import { fetchRegionalLeaderboards } from "@/lib/gamification-fetch";
import type { RegionalDimensionLeaderboard } from "@/lib/gamification";
import { followRider } from "@/lib/rider-profile";
import { challengeCopyForKey } from "@/lib/gamification";
import type { EnglishMessageKey } from "@/i18n";

const CHALLENGE_PROGRESS_MESSAGES: Record<string, EnglishMessageKey> = {
  ride_count: "{current} / {target} {target, plural, one {ride} other {rides}}",
  roads_discovered:
    "{current} / {target} {target, plural, one {road} other {roads}}",
  reviews_written:
    "{current} / {target} {target, plural, one {review} other {reviews}}",
  hazards_reported:
    "{current} / {target} {target, plural, one {report} other {reports}}",
  rides_shared:
    "{current} / {target} {target, plural, one {ride} other {rides}}",
};

export function CommunitySidebar() {
  const t = useTranslation();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const format = useFormat();
  // Declared before the fetch effect, which depends on it.
  const { enabled: gamificationEnabled } = useSystemSwitch("sys_gamification");

  const [challenge, setChallenge] = useState<ActiveChallengeCard | null>(null);
  const [board, setBoard] = useState<RegionalDimensionLeaderboard | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedRider[]>([]);

  useEffect(() => {
    if (!authReady) return;
    const ac = new AbortController();
    // Each widget is independent — a failure leaves the others intact, and the
    // switch only covers the gamification ones. With `sys_gamification` off
    // the backend returns no active challenges and no standings, so both would
    // simply vanish — indistinguishable from "nothing is running". Skip those
    // fetches and let the gate below say why.
    //
    // Suggested riders are COMMUNITY, not gamification, and keep loading.
    if (gamificationEnabled) {
      void fetchActiveChallengeCard(new Date(), ac.signal, t)
        .then(setChallenge)
        .catch(() => undefined);
    }
    // Standings are deliberately OUTSIDE the gate. The switch design lists
    // leaderboards as out of scope — "stays live per decision 2" — so the
    // backend keeps serving them, and gating the fetch here would remove a
    // working feature rather than reflect a shutdown.
    void fetchRegionalLeaderboards({
      ...(currentUserId != null ? { currentUserId } : {}),
      limit: 8,
      signal: ac.signal,
      translate: t,
    })
      .then((b) => {
        setBoard(b.total_distance_km);
        setRegion(b.region);
      })
      .catch(() => undefined);
    void fetchSuggestedRiders(3, ac.signal)
      .then(setSuggestions)
      .catch(() => undefined);
    return () => ac.abort();
  }, [authReady, currentUserId, t, gamificationEnabled]);

  return (
    <aside className="flex flex-col gap-[14px]">
      {/* For the challenge card only. Says why rather than disappearing: an
          absent card reads as "no challenge is running", which is exactly the
          silent empty state this epic forbids. The standings below are not
          gamification-gated (see the fetch above). */}
      {!gamificationEnabled && (
        <SystemSwitchGate feature="sys_gamification">{null}</SystemSwitchGate>
      )}
      {gamificationEnabled && challenge && (
        <ChallengeCard challenge={challenge} format={format} />
      )}
      {board && board.entries.length > 0 && (
        <LeaderboardCard board={board} region={region} format={format} />
      )}
      {suggestions.length > 0 && <SuggestionsCard riders={suggestions} />}
    </aside>
  );
}

function ChallengeCard({
  challenge,
  format,
}: {
  challenge: ActiveChallengeCard;
  format: Formatters;
}) {
  const t = useTranslation();
  const pct =
    challenge.target > 0
      ? Math.min(100, Math.round((challenge.current / challenge.target) * 100))
      : 0;
  const copy = challengeCopyForKey(
    {
      contentKey: challenge.contentKey,
      metric: challenge.metric,
      target: challenge.target,
    },
    format,
    t,
  );
  const distanceMetric = isDistanceChallengeMetric(challenge.metric);
  const progressMessage =
    CHALLENGE_PROGRESS_MESSAGES[
      challengeContentKeyForMetric(challenge.metric) ?? challenge.metric
    ];
  return (
    <div className="rounded-[14px] bg-ink p-[18px] text-cream">
      <Stamp tone="accent">{t("Active challenge")}</Stamp>
      <div className="mt-1.5 text-[18px] font-extrabold tracking-[-0.2px]">
        {copy.title}
      </div>
      <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-cream/15">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-fg-on-dark-mute">
        <Mono>
          {distanceMetric
            ? t("{current} / {target}", {
                current: format.distanceKm(challenge.current),
                target: format.distanceKm(challenge.target),
              })
            : progressMessage
              ? t(progressMessage, {
                  current: format.integer(challenge.current),
                  target: challenge.target,
                })
              : t("{current} / {target}", {
                  current: format.integer(challenge.current),
                  target: format.integer(challenge.target),
                })}
        </Mono>
        <Mono>
          {challenge.daysLeft === 0
            ? t("Ends today")
            : t("{count, plural, one {# day left} other {# days left}}", {
                count: challenge.daysLeft,
              })}
        </Mono>
      </div>
    </div>
  );
}

function LeaderboardCard({
  board,
  region,
  format,
}: {
  board: RegionalDimensionLeaderboard;
  region: string | null;
  format: Formatters;
}) {
  const t = useTranslation();
  // Show the top rows; if the rider is outside them, append their own row.
  const rows = board.entries.slice(0, 5);
  const meInRows = board.me != null && rows.some((e) => e.isMe);
  const display = board.me != null && !meInRows ? [...rows, board.me] : rows;
  return (
    <div className="rounded-[14px] border border-line bg-cream p-[18px]">
      <Stamp>
        {t("Your region")} · {region ?? t("Global")}
      </Stamp>
      <div className="mt-1 text-sm font-bold text-ink">{t("Km ridden")}</div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {display.map((e) => (
          <li
            key={e.userId}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${
              e.isMe ? "bg-ink text-cream" : "text-ink"
            }`}
          >
            <Mono
              className={`w-[22px] font-bold ${
                e.isMe ? "text-accent" : "text-fg-mute"
              }`}
            >
              #
              {format.number(e.rank, {
                useGrouping: false,
                maximumFractionDigits: 0,
              })}
            </Mono>
            <UserAvatar
              name={e.displayName}
              size={22}
              fontSize={10}
              accent={e.isMe}
            />
            {e.isMe ? (
              <span className="flex-1 truncate text-[13px] font-bold">
                {t("You")}
              </span>
            ) : (
              <Link
                href={`/community/${encodeURIComponent(e.userId)}`}
                className="flex-1 truncate text-[13px] font-medium transition-colors hover:text-accent"
              >
                {e.displayName}
              </Link>
            )}
            <Mono
              className={`text-[11px] ${
                e.isMe ? "text-fg-on-dark-mute" : "text-fg-dim"
              }`}
            >
              {format.distanceKm(e.value)}
            </Mono>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SuggestionsCard({ riders }: { riders: SuggestedRider[] }) {
  const t = useTranslation();
  return (
    <div className="rounded-[14px] border border-line bg-cream p-[18px]">
      <Stamp>{t("People you might follow")}</Stamp>
      <ul className="mt-3 flex flex-col gap-2.5">
        {riders.map((r) => (
          <SuggestionRow key={r.id} rider={r} />
        ))}
      </ul>
    </div>
  );
}

function SuggestionRow({ rider }: { rider: SuggestedRider }) {
  const t = useTranslation();
  const format = useFormat();
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  const follow = async () => {
    if (busy || following) return;
    setBusy(true);
    setFollowing(true);
    try {
      await followRider(rider.id, t);
    } catch {
      setFollowing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-2.5">
      <Link
        href={`/community/${encodeURIComponent(rider.id)}`}
        className="group flex min-w-0 flex-1 items-center gap-2.5"
        aria-label={t("View {name}'s profile", { name: rider.display_name })}
      >
        <UserAvatar name={rider.display_name} size={32} fontSize={13} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold text-ink transition-colors group-hover:text-accent">
            {rider.display_name}
          </div>
          <Mono className="text-[10px] uppercase text-fg-mute">
            {rider.home_region ? `${rider.home_region} · ` : ""}
            {t("{count, plural, one {{n} ride} other {{n} rides}}", {
              count: rider.ride_count,
              n: format.integer(rider.ride_count),
            })}
          </Mono>
        </div>
      </Link>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={follow}
        disabled={busy || following}
      >
        {following ? t("Following") : t("Follow")}
      </Button>
    </li>
  );
}
