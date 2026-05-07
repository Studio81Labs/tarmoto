import { t } from "@/i18n";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  Activity,
  CalendarDays,
  Gauge,
  MousePointerClick,
  Route as RouteIcon,
  Timer,
  Wind,
} from "lucide-react";
import { RouteEmbedPanel } from "./_components/RouteEmbedPanel";
import { buildRoutePreview } from "@/lib/ride-detail";
import { fetchSharedRide } from "@/lib/shared-rides";
import { siteUrl } from "@/lib/site";
import {
  formatDistance,
  formatDuration,
  formatRelativeTime,
  formatRideType,
} from "@/lib/utils";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Shared ride — Tarmoto",
    description: "Public Tarmoto shared ride page.",
    robots: { index: false, follow: false },
  };
}
export default async function SharedRidePage({
  params,
}: {
  params: Promise<{
    token: string;
  }>;
}) {
  const { token } = await params;
  const ride = await fetchSharedRide(token);
  if (!ride) notFound();
  const pageUrl = `${siteUrl()}/rides/shared/${token}`;
  const origin = new URL(pageUrl).origin;
  const preview = buildRoutePreview(ride.route_geometry, 960, 14);
  const rideLabel = `${ride.rider_name} · ${formatRideType(ride.ride_type)} ride`;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/" className="hover:text-white">
          {t("Tarmoto ")}
        </Link>
        <span className="mx-2">/</span>
        <span>{t("Shared ride")}</span>
      </nav>

      <header className="mb-8 rounded-3xl border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.14),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-tarmoto-cyan">
          {t("Public route share ")}
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">
          {ride.rider_name}
          {t("'s")} {formatRideType(ride.ride_type).toLowerCase()}
          {t("ride ")}
        </h1>
        <p className="mt-3 max-w-3xl text-slate-300">
          {t(
            "Shared from Tarmoto for blogs, forums, and ride reports. Each page load counts as a view, and widget CTA clicks are tracked separately. ",
          )}
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-sm text-slate-300">
          <Pill icon={<CalendarDays size={14} />}>
            {formatRelativeTime(ride.started_at)}
          </Pill>
          <Pill icon={<Activity size={14} />}>
            {ride.view_count}
            {t("views")}
          </Pill>
          <Pill icon={<MousePointerClick size={14} />}>
            {ride.embed_click_count}
            {t("embed clicks ")}
          </Pill>
        </div>
      </header>

      <section className="mb-8 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{t("Route preview")}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t("Snapshot of the shared route and its current ride metrics. ")}
          </p>
        </div>

        {preview ? (
          <svg
            viewBox={preview.viewBox}
            role="img"
            aria-label={`${ride.rider_name} route preview`}
            className="h-auto w-full rounded-2xl bg-[linear-gradient(180deg,_rgba(15,23,42,0.94),_rgba(2,6,23,1))]"
          >
            <path
              d={preview.path}
              fill="none"
              stroke="#22d3ee"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="6"
            />
          </svg>
        ) : (
          <div className="flex h-60 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-950/80 text-sm text-slate-500">
            {t("Route preview unavailable for this shared ride. ")}
          </div>
        )}
      </section>

      <section className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<RouteIcon size={16} />}
          label="Distance"
          value={
            ride.distance_km != null ? formatDistance(ride.distance_km) : "—"
          }
        />
        <StatCard
          icon={<Timer size={16} />}
          label="Duration"
          value={formatDuration(ride.duration_min)}
        />
        <StatCard
          icon={<Gauge size={16} />}
          label="Quality"
          value={
            ride.avg_road_quality != null
              ? `${ride.avg_road_quality.toFixed(1)}/5`
              : "—"
          }
        />
        <StatCard
          icon={<Wind size={16} />}
          label="Curviness"
          value={
            ride.avg_curviness != null ? ride.avg_curviness.toFixed(1) : "—"
          }
        />
      </section>

      <RouteEmbedPanel
        origin={origin}
        token={token}
        rideLabel={rideLabel}
        views={ride.view_count}
        clicks={ride.embed_click_count}
      />
    </main>
  );
}
function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
        {icon}
        {label}
      </div>
      <p className="text-lg font-semibold text-white">{value}</p>
    </article>
  );
}
function Pill({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1.5">
      {icon}
      {children}
    </span>
  );
}
