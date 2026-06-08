"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Button, Stamp, Mono } from "@tarmoto/ui";
import { useAuthStore } from "@/stores/auth";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import {
  fetchActiveChallengeCard,
  fetchSuggestedRiders,
  type ActiveChallengeCard,
  type SuggestedRider,
} from "@/lib/community-sidebar";
import { fetchRegionalLeaderboards } from "@/lib/gamification-fetch";
import type { RegionalDimensionLeaderboard } from "@/lib/gamification";
import { followRider } from "@/lib/rider-profile";

// Short unit word for the challenge progress, derived from its metric key.
function challengeUnit(metric: string): string {
  if (/pass/i.test(metric)) return "passes";
  if (/road/i.test(metric)) return "roads";
  if (/hazard/i.test(metric)) return "hazards";
  if (/distance|km/i.test(metric)) return "km";
  return "";
}

export function CommunitySidebar() {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const { format } = useNumberFormat();

  const [challenge, setChallenge] = useState<ActiveChallengeCard | null>(null);
  const [board, setBoard] = useState<RegionalDimensionLeaderboard | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedRider[]>([]);

  useEffect(() => {
    if (!authReady) return;
    const ac = new AbortController();
    // Each widget is independent — a failure leaves the others intact.
    void fetchActiveChallengeCard(new Date(), ac.signal)
      .then(setChallenge)
      .catch(() => undefined);
    void fetchRegionalLeaderboards({
      currentUserId: currentUserId ?? undefined,
      limit: 8,
      signal: ac.signal,
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
  }, [authReady, currentUserId]);

  return (
    <aside className="flex flex-col gap-[14px]">
      {challenge && <ChallengeCard challenge={challenge} format={format} />}
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
  format: (n: number) => string;
}) {
  const pct =
    challenge.target > 0
      ? Math.min(100, Math.round((challenge.current / challenge.target) * 100))
      : 0;
  const unit = challengeUnit(challenge.metric);
  return (
    <div className="rounded-[14px] bg-ink p-[18px] text-cream">
      <Stamp tone="accent">{t("Active challenge")}</Stamp>
      <div className="mt-1.5 text-[18px] font-extrabold tracking-[-0.2px]">
        {challenge.title}
      </div>
      <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-cream/15">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-fg-on-dark-mute">
        <Mono>
          {format(challenge.current)} / {format(challenge.target)}
          {unit ? ` ${unit}` : ""}
        </Mono>
        <Mono>
          {challenge.daysLeft === 0
            ? t("Ends today")
            : t("{count} days left", { count: challenge.daysLeft })}
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
  format: (n: number) => string;
}) {
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
              #{e.rank}
            </Mono>
            <span
              className={`flex-1 truncate text-[13px] ${
                e.isMe ? "font-bold" : "font-medium"
              }`}
            >
              {e.isMe ? t("You") : e.displayName}
            </span>
            <Mono
              className={`text-[11px] ${
                e.isMe ? "text-fg-on-dark-mute" : "text-fg-dim"
              }`}
            >
              {format(Math.round(e.value))} {t("km")}
            </Mono>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SuggestionsCard({ riders }: { riders: SuggestedRider[] }) {
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
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const initial = rider.display_name.trim().charAt(0).toUpperCase() || "R";

  const follow = async () => {
    if (busy || following) return;
    setBusy(true);
    setFollowing(true);
    try {
      await followRider(rider.id);
    } catch {
      setFollowing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F0A03C] text-[13px] font-extrabold text-ink">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-bold text-ink">
          {rider.display_name}
        </div>
        <Mono className="text-[10px] uppercase text-fg-mute">
          {rider.home_region ? `${rider.home_region} · ` : ""}
          {t("{count} rides", { count: rider.ride_count })}
        </Mono>
      </div>
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
