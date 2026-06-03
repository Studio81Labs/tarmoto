"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, Mono, QualityBars } from "@tarmoto/ui";
import type { UserRide } from "@/hooks/useUserRides";
import {
  formatDurationCompact,
  formatShortDate,
  scoreToQualityTier,
} from "@/lib/utils";

const COLS = "grid grid-cols-[90px_1fr_80px_90px_70px_90px_40px] items-center";

export function RecentRidesTable({ rides }: { rides: UserRide[] }) {
  return (
    <Card padded={false} className="overflow-hidden" role="table">
      <div
        role="row"
        className={`${COLS} border-b border-line bg-paper px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute`}
      >
        <span role="columnheader">DATE</span>
        <span role="columnheader">RIDE</span>
        <span role="columnheader">KM</span>
        <span role="columnheader">DURATION</span>
        <span role="columnheader">AVG</span>
        <span role="columnheader">QUALITY</span>
        <span role="columnheader" />
      </div>
      {rides.map((ride, i) => {
        const tier = scoreToQualityTier(ride.avg_road_quality);
        return (
          <Link
            key={ride.id}
            href={`/rides/${ride.id}`}
            role="row"
            className={`${COLS} px-5 py-3.5 text-[13px] transition hover:bg-paper ${
              i < rides.length - 1 ? "border-b border-line" : ""
            }`}
          >
            <span role="cell">
              <Mono className="text-fg-dim">
                {formatShortDate(ride.started_at)}
              </Mono>
            </span>
            <span role="cell" className="truncate font-bold text-ink">
              {ride.name ?? formatShortDate(ride.started_at)}
            </span>
            <span role="cell">
              <Mono className="font-bold text-ink">
                {ride.distance_km != null ? Math.round(ride.distance_km) : "—"}
              </Mono>
            </span>
            <span role="cell">
              <Mono className="text-fg-dim">
                {formatDurationCompact(ride.duration_min)}
              </Mono>
            </span>
            <span role="cell">
              <Mono className="text-ink">
                {ride.avg_speed != null ? Math.round(ride.avg_speed) : "—"}
              </Mono>
            </span>
            <span role="cell">
              {tier != null ? (
                <QualityBars q={tier} size={4} />
              ) : (
                <span className="text-fg-mute">—</span>
              )}
            </span>
            <span role="cell" className="justify-self-end">
              <ArrowRight size={14} className="text-fg-mute" />
            </span>
          </Link>
        );
      })}
    </Card>
  );
}
