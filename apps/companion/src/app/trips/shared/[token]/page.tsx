import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CalendarDays,
  Eye,
  MapPin,
  Route as RouteIcon,
  Timer,
  User,
} from "lucide-react";
import { buildRoutePreview } from "@/lib/ride-detail";
import {
  fetchSharedTrip,
  flattenTripRoute,
  parseTripSnapshot,
  tripSummary,
} from "@/lib/trip-share";
import { formatDuration, formatDistance } from "@/lib/utils";
import type { Waypoint } from "@/lib/types";
import { SharedTripJoinCta } from "./SharedTripJoinCta";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared trip — Tarmoto",
    description: "Public Tarmoto shared trip page.",
    robots: { index: false, follow: false },
  };
}
export default async function SharedTripPage({
  params,
}: {
  params: Promise<{
    token: string;
  }>;
}) {
  const { token } = await params;
  const share = await fetchSharedTrip(token);
  if (!share) notFound();
  const trip = parseTripSnapshot(share.snapshot);
  const summary = trip ? tripSummary(trip) : null;
  const preview = trip
    ? buildRoutePreview(flattenTripRoute(trip), 960, 14)
    : null;
  return (
    <div className="tarmoto-no-cream min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto max-w-5xl px-6 py-10">
        <nav className="mb-4 text-sm text-slate-400">
          <Link href="/" className="hover:text-white">
            {t("Tarmoto ")}
          </Link>
          <span className="mx-2">/</span>
          <span>{t("Shared trip")}</span>
        </nav>

        <header className="mb-8 rounded-3xl border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.14),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-tarmoto-cyan">
            {t("Trip invite ")}
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            {share.title}
          </h1>
          <p className="mt-3 max-w-3xl text-slate-300">
            {share.trip_id
              ? t("Trip preview shared by ")
              : t("Read-only preview shared by ")}
            {share.owner_name}
            {share.trip_id
              ? t(
                  ". Sign in to join the group plan, suggest route changes, and vote with the riders. ",
                )
              : t(". You can view this trip without a Tarmoto account. ")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-sm text-slate-300">
            <Pill icon={<User size={14} />}>{share.owner_name}</Pill>
            <Pill icon={<Eye size={14} />}>
              {t("{count} views", { count: share.view_count })}
            </Pill>
            {summary && (
              <>
                <Pill icon={<CalendarDays size={14} />}>
                  {summary.dayCount} {summary.dayCount === 1 ? "day" : "days"}
                </Pill>
                <Pill icon={<RouteIcon size={14} />}>
                  {formatDistance(summary.totalDistanceKm)}
                </Pill>
                <Pill icon={<Timer size={14} />}>
                  {formatDuration(summary.totalDurationMin)}
                </Pill>
              </>
            )}
          </div>
        </header>

        <SharedTripJoinCta
          token={share.share_token}
          title={share.title}
          tripId={share.trip_id}
        />

        {preview ? (
          <section className="mb-8 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{t("Route preview")}</h2>
              <p className="mt-1 text-sm text-slate-400">
                {t(
                  "Simplified overview of the planned route across all days. ",
                )}
              </p>
            </div>
            <svg
              viewBox={preview.viewBox}
              role="img"
              aria-label={`${share.title} route preview`}
              className="h-auto w-full rounded-2xl bg-[linear-gradient(180deg,_rgba(15,23,42,0.94),_rgba(2,6,23,1))]"
            >
              <path
                d={preview.path}
                fill="none"
                stroke="#22d3ee"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </section>
        ) : null}

        {trip ? (
          <section className="mb-8 space-y-6">
            {trip.days.map((day, index) => (
              <article
                key={index}
                className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5"
              >
                <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">
                      {t("Day ")}
                      {day.dayNumber}
                      {day.title ? ` — ${day.title}` : ""}
                    </h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {formatDistance(day.distanceKm)} ·{" "}
                      {formatDuration(day.durationMinutes)}
                    </p>
                  </div>
                </header>
                <ol className="space-y-2">
                  {day.waypoints.map((wp, waypointIndex) => (
                    <li
                      key={wp.id ?? waypointIndex}
                      className="flex items-start gap-3 rounded-lg border border-slate-800/70 bg-slate-950/50 px-3 py-2 text-sm"
                    >
                      <MapPin
                        size={14}
                        className="mt-0.5 flex-none text-tarmoto-cyan"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="block font-medium text-slate-100">
                          {waypointLabel(wp, waypointIndex)}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {wp.location.lat.toFixed(4)},{" "}
                          {wp.location.lng.toFixed(4)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </section>
        ) : (
          <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-400">
            {t(
              "This shared trip's snapshot is in an unexpected format \u2014 the owner may have saved it with a newer version of the planner. Ask them to regenerate the share link. ",
            )}
          </section>
        )}

        <footer className="text-center text-xs text-slate-500">
          {t("Shared via Tarmoto \u00B7")}{" "}
          <Link href="/trips/planner" className="hover:text-slate-300">
            {t("Plan your own trip ")}
          </Link>
        </footer>
      </main>
    </div>
  );
}
function waypointLabel(wp: Waypoint, index: number): string {
  if (wp.name) return wp.name;
  // `parseTripSnapshot` validates `type` is one of the known strings, but
  // belt-and-suspenders: if a future caller skips that validator we still
  // want a readable label instead of a TypeError on `type[0]`.
  const rawType =
    typeof wp.type === "string" && wp.type.length > 0 ? wp.type : "stop";
  const typeLabel = rawType[0].toUpperCase() + rawType.slice(1);
  return `${typeLabel} ${index + 1}`;
}
function Pill({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/60 px-2.5 py-1">
      {icon}
      {children}
    </span>
  );
}
