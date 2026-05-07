"use client";
import { t } from "@/i18n";
import Link from "next/link";
import type { ReactNode } from "react";
import { Eye, Gauge, Route as RouteIcon, Timer, Wind } from "lucide-react";
import type { CommunityRide } from "@/lib/api";
import { buildRoutePreview } from "@/lib/ride-detail";
import {
  QUALITY_CONFIG,
  formatDistance,
  formatDuration,
  formatRelativeTime,
  formatRideType,
  scoreToTier,
} from "@/lib/utils";
export function CommunityRideCard({ ride }: { ride: CommunityRide }) {
  const preview = buildRoutePreview(ride.route_geometry, 220, 10);
  const tier =
    ride.avg_road_quality != null ? scoreToTier(ride.avg_road_quality) : null;
  const qualityMeta = tier ? QUALITY_CONFIG[tier] : null;
  const riderInitial = ride.rider_name.trim().charAt(0).toUpperCase() || "R";
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90">
      <div className="border-b border-slate-800 bg-slate-950/70 p-3">
        {preview ? (
          <svg
            viewBox={preview.viewBox}
            className="h-36 w-full rounded-xl bg-slate-950"
            aria-label={`${ride.rider_name} route preview`}
            role="img"
          >
            <path
              d={preview.path}
              fill="none"
              stroke="#22d3ee"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="4"
            />
          </svg>
        ) : (
          <div className="flex h-36 items-center justify-center rounded-xl bg-slate-950 text-sm text-slate-500">
            {t("Preview unavailable ")}
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <Link
            href={`/community/${encodeURIComponent(ride.rider_id)}`}
            className="flex min-w-0 items-center gap-3 text-white transition hover:text-tarmoto-cyan"
          >
            {ride.rider_avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ride.rider_avatar_url}
                alt={ride.rider_name}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-tarmoto-cyan/15 text-sm font-semibold text-tarmoto-cyan">
                {riderInitial}
              </div>
            )}

            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {ride.rider_name}
              </p>
              <p className="text-xs text-slate-500">
                {formatRideType(ride.ride_type)}
                {t("ride \u00B7")} {formatRelativeTime(ride.started_at)}
              </p>
            </div>
          </Link>

          <div className="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300">
            <span className="inline-flex items-center gap-1">
              <Eye size={12} />
              {t("{count} views", { count: ride.view_count.toLocaleString() })}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            icon={<RouteIcon size={14} />}
            label="Distance"
            value={
              ride.distance_km != null ? formatDistance(ride.distance_km) : "—"
            }
          />
          <StatTile
            icon={<Timer size={14} />}
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
            accentClassName={qualityMeta?.color}
          />
          <StatTile
            icon={<Wind size={14} />}
            label="Curviness"
            value={
              ride.avg_curviness != null ? ride.avg_curviness.toFixed(1) : "—"
            }
          />
        </div>
      </div>
    </article>
  );
}
function StatTile({
  icon,
  label,
  value,
  accentClassName,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  accentClassName?: string;
}) {
  const valueClassName = accentClassName ?? "text-white";
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className={`text-sm font-semibold ${valueClassName}`}>{value}</div>
    </div>
  );
}
