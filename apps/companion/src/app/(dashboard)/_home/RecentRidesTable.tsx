"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, Mono, QualityBars } from "@tarmoto/ui";
import type { UserRide } from "@/hooks/useUserRides";

/** Backend `avg_road_quality` is already a 0–5 scale; round into a tier. */
function qualityTier(q: number | null): 1 | 2 | 3 | 4 | 5 | null {
  if (q == null) return null;
  return Math.min(5, Math.max(1, Math.round(q))) as 1 | 2 | 3 | 4 | 5;
}

/** "4h 12m" / "52m" from whole minutes. */
function formatDuration(min: number | null): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDay(iso: string): string {
  // "18 Apr" — locale-stable day + short month.
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

const COLS = "grid grid-cols-[90px_1fr_80px_90px_70px_90px_40px] items-center";

export function RecentRidesTable({ rides }: { rides: UserRide[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div
        className={`${COLS} border-b border-line bg-paper px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute`}
      >
        <span>DATE</span>
        <span>RIDE</span>
        <span>KM</span>
        <span>DURATION</span>
        <span>AVG</span>
        <span>QUALITY</span>
        <span />
      </div>
      {rides.map((ride, i) => {
        const tier = qualityTier(ride.avg_road_quality);
        return (
          <Link
            key={ride.id}
            href={`/rides/${ride.id}`}
            className={`${COLS} px-5 py-3.5 text-[13px] transition hover:bg-paper ${
              i < rides.length - 1 ? "border-b border-line" : ""
            }`}
          >
            <Mono className="text-fg-dim">{formatDay(ride.started_at)}</Mono>
            <span className="truncate font-bold text-ink">
              {ride.name ?? formatDay(ride.started_at)}
            </span>
            <Mono className="font-bold text-ink">
              {ride.distance_km != null ? Math.round(ride.distance_km) : "—"}
            </Mono>
            <Mono className="text-fg-dim">
              {formatDuration(ride.duration_min)}
            </Mono>
            <Mono className="text-ink">
              {ride.avg_speed != null ? Math.round(ride.avg_speed) : "—"}
            </Mono>
            <span>
              {tier != null ? (
                <QualityBars q={tier} size={4} />
              ) : (
                <span className="text-fg-mute">—</span>
              )}
            </span>
            <ArrowRight size={14} className="justify-self-end text-fg-mute" />
          </Link>
        );
      })}
    </Card>
  );
}
