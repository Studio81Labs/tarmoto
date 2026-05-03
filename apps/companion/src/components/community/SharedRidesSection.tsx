"use client";

/**
 * SharedRidesSection (#371) — companion mirror of mobile's SharedRidesSection.
 *
 * Renders the rider's most recent shared rides on the public profile page.
 * The backend gates visibility on the rider's `profile_visibility` privacy
 * preference (private profiles 404 for non-self viewers) and on each
 * share's `is_public` flag (private shares are filtered server-side for
 * non-self viewers). This section treats both axes the same way as
 * mobile: a 404 collapses to the empty state instead of an error block,
 * and the per-card "Private" pill is only rendered for the rider's own
 * private shares so the UI never leaks a private flag that slipped past
 * the server filter.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Eye, Lock, Route as RouteIcon, Timer } from "lucide-react";
import { fetchSharedRides, type UserSharedRide } from "@/lib/shared-rides";
import { formatDate, formatDistance, formatDuration } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

const PAGE_SIZE = 5;

interface SharedRidesSectionProps {
  userId: string;
  isSelf: boolean;
  /** Display name used in the third-person empty-state copy. */
  displayName: string;
}

type Phase = "loading" | "ready" | "error";

export function SharedRidesSection({
  userId,
  isSelf,
  displayName,
}: SharedRidesSectionProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [items, setItems] = useState<UserSharedRide[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    // Mirrors the cancellation pattern used by the parent profile page:
    // openapi-fetch swallows AbortError into its result union, so we keep
    // a `cancelled` flag alongside the controller to guard every setState
    // when a userId or accessToken change races with an in-flight request.
    let cancelled = false;
    const controller = new AbortController();

    setPhase("loading");
    setErrorMessage(null);

    fetchSharedRides(userId, { limit: PAGE_SIZE, signal: controller.signal })
      .then((response) => {
        if (cancelled) return;
        setItems(response?.items ?? []);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setPhase("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Could not load shared rides.",
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // accessToken is captured by the typed client through the auth store;
    // re-running on token change re-issues the request with the new viewer
    // identity so `is_self` and the private-share filter stay in sync.
  }, [userId, accessToken]);

  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 mb-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <RouteIcon size={14} /> Shared rides
        </h2>
      </header>

      {phase === "loading" ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded-xl bg-slate-800/40 animate-pulse"
            />
          ))}
        </div>
      ) : phase === "error" ? (
        <p className="text-sm text-red-400">{errorMessage}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500">
          {isSelf
            ? "You haven't shared any rides yet."
            : `${displayName} hasn't shared any rides yet.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((ride) => (
            <li key={ride.share_token}>
              <SharedRideCard ride={ride} isSelf={isSelf} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SharedRideCard({
  ride,
  isSelf,
}: {
  ride: UserSharedRide;
  isSelf: boolean;
}) {
  const showPrivatePill = isSelf && !ride.is_public;
  const href = `/rides/shared/${encodeURIComponent(ride.share_token)}`;

  return (
    <Link
      href={href}
      className="block rounded-xl border border-slate-800 bg-slate-950/60 p-3 transition hover:border-tarmoto-cyan/40 hover:bg-slate-950"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
          <Calendar size={12} />
          {formatDate(ride.started_at)}
        </span>
        {showPrivatePill ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <Lock size={10} /> Private
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric
          icon={<RouteIcon size={12} />}
          label="Distance"
          value={
            ride.distance_km != null ? formatDistance(ride.distance_km) : "—"
          }
        />
        <Metric
          icon={<Timer size={12} />}
          label="Duration"
          value={formatDuration(ride.duration_min)}
        />
        <Metric
          icon={<Eye size={12} />}
          label="Views"
          value={Math.max(0, Math.round(ride.view_count)).toLocaleString()}
        />
      </div>
    </Link>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[11px] text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-white tabular-nums">
        {value}
      </div>
    </div>
  );
}
