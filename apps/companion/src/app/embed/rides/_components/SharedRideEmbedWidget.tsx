"use client";
import { t } from "@/i18n";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Clock3,
  Eye,
  Gauge,
  MousePointerClick,
  Route as RouteIcon,
  Wind,
} from "lucide-react";
import { api } from "@/lib/api";
import { buildRoutePreview } from "@/lib/ride-detail";
import { formatRideEmbedStat, type RideWidgetVariant } from "@/lib/ride-embed";
import type { SharedRideDetail } from "@/lib/shared-rides";
import {
  formatDistance,
  formatDuration,
  formatRelativeTime,
  formatRideType,
} from "@/lib/utils";
type SharedRideWidgetData = Pick<
  SharedRideDetail,
  | "rider_name"
  | "ride_type"
  | "started_at"
  | "distance_km"
  | "duration_min"
  | "avg_road_quality"
  | "avg_curviness"
  | "route_geometry"
  | "view_count"
  | "embed_click_count"
>;
interface Props {
  token: string;
  ride: SharedRideWidgetData;
  pageUrl: string;
  variant: RideWidgetVariant;
}
export function SharedRideEmbedWidget({
  token,
  ride,
  pageUrl,
  variant,
}: Props) {
  const preview = buildRoutePreview(
    ride.route_geometry,
    variant === "landscape" ? 720 : 640,
    14,
  );
  function handleOutboundClick() {
    // Fire-and-forget beacon; the endpoint is public so no bearer is needed
    // (the client only attaches one when a session exists).
    void api.POST("/api/v1/rides/shared/{token}/embed-click", {
      params: { path: { token } },
      keepalive: true,
    });
  }
  return (
    <main className="bg-slate-950 p-4 text-slate-100">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-[24px] border border-slate-800 bg-slate-950 shadow-2xl shadow-black/40">
        <header className="border-b border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.18),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-accent">
                {t("Tarmoto widget ")}
              </p>
              <h1 className="mt-2 text-xl font-semibold text-white">
                {ride.rider_name}
              </h1>
              <p className="mt-1 text-sm text-slate-300">
                {formatRideType(ride.ride_type)}
                {t("ride \u00B7")} {formatRelativeTime(ride.started_at)}
              </p>
            </div>
            <Link
              href={pageUrl}
              target="_blank"
              rel="noreferrer"
              onClick={handleOutboundClick}
              className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/15"
            >
              {t("View full ride ")}
            </Link>
          </div>
        </header>

        <div
          className={
            variant === "landscape"
              ? "grid gap-5 p-5 md:grid-cols-[1.1fr_0.9fr]"
              : "space-y-5 p-5"
          }
        >
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  {t("Route preview ")}
                </h2>
                <p className="text-xs text-slate-400">
                  {t("Shared ride route with Tarmoto ride stats. ")}
                </p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>{formatRideEmbedStat(ride.view_count, "view")}</p>
                <p>{formatRideEmbedStat(ride.embed_click_count, "click")}</p>
              </div>
            </div>

            {preview ? (
              <svg
                viewBox={preview.viewBox}
                role="img"
                aria-label={`${ride.rider_name} route preview`}
                className="h-auto w-full rounded-xl bg-[linear-gradient(180deg,_rgba(15,23,42,0.94),_rgba(2,6,23,1))]"
              >
                <path
                  d={preview.path}
                  fill="none"
                  stroke="#22d3ee"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="5"
                />
              </svg>
            ) : (
              <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-950/80 text-sm text-slate-500">
                {t("Route preview unavailable. ")}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-white">
                {t("Ride stats")}
              </h2>
              <p className="text-xs text-slate-400">
                {t("Snapshot from the shared Tarmoto ride. ")}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <StatTile
                icon={<RouteIcon size={14} />}
                label="Distance"
                value={
                  ride.distance_km != null
                    ? formatDistance(ride.distance_km)
                    : "—"
                }
              />
              <StatTile
                icon={<Clock3 size={14} />}
                label="Duration"
                value={formatDuration(ride.duration_min)}
              />
              <StatTile
                icon={<Gauge size={14} />}
                label="Quality"
                value={
                  ride.avg_road_quality != null
                    ? `${ride.avg_road_quality.toFixed(1)}/5`
                    : "—"
                }
              />
              <StatTile
                icon={<Wind size={14} />}
                label="Curviness"
                value={
                  ride.avg_curviness != null
                    ? ride.avg_curviness.toFixed(1)
                    : "—"
                }
              />
              <StatTile
                icon={<Eye size={14} />}
                label="Views"
                value={formatRideEmbedStat(ride.view_count, "view")}
              />
              <StatTile
                icon={<MousePointerClick size={14} />}
                label="Clicks"
                value={formatRideEmbedStat(ride.embed_click_count, "click")}
              />
            </div>
          </section>
        </div>
      </article>
    </main>
  );
}
function StatTile({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  );
}
