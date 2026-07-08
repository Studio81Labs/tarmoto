import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye, User } from "lucide-react";
import {
  fetchSharedTrip,
  parseTripSnapshot,
  tripRouteLines,
  tripSummary,
} from "@/lib/trip-share";
import { TripRouteOverview } from "@/components/TripRouteOverview";
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
  const lines = trip ? tripRouteLines(trip) : [];
  return (
    <div className="tarmoto-no-cream min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto max-w-3xl px-6 py-10">
        <nav className="mb-4 text-sm text-slate-400">
          <Link href="/" className="hover:text-white">
            {t("Tarmoto ")}
          </Link>
          <span className="mx-2">/</span>
          <span>{t("Shared trip")}</span>
        </nav>

        <header className="mb-8 rounded-3xl border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.14),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-accent">
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
          </div>
        </header>

        <SharedTripJoinCta
          token={share.share_token}
          title={share.title}
          tripId={share.trip_id}
        />

        {trip && summary ? (
          <section className="mb-8">
            <TripRouteOverview
              lines={lines}
              distanceKm={summary.totalDistanceKm}
              dayCount={summary.dayCount}
              region={trip.region ?? null}
              variant="dark"
              label={share.title}
            />
          </section>
        ) : (
          <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-400">
            {t(
              "This shared trip's snapshot is in an unexpected format — the owner may have saved it with a newer version of the planner. Ask them to regenerate the share link. ",
            )}
          </section>
        )}

        <footer className="text-center text-xs text-slate-500">
          {t("Shared via Tarmoto ·")}{" "}
          <Link href="/trips/planner" className="hover:text-slate-300">
            {t("Plan your own trip ")}
          </Link>
        </footer>
      </main>
    </div>
  );
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
