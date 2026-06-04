"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Mono, QualityBars } from "@tarmoto/ui";
import {
  formatDurationCompact,
  formatShortDate,
  scoreToQualityTier,
} from "@/lib/utils";
import type { RideSummary } from "./useRidesQuery";
import { ROW_COLS } from "./RidesTable";

interface Props {
  ride: RideSummary;
  last: boolean;
}

/**
 * A single Ride History table row. The RIDE cell holds a real `<Link>` to the
 * ride detail page (`/rides/[rideId]`, where rename + full stats live); a
 * stretched `::after` overlay makes the entire row clickable while keeping a
 * single, discoverable link in the accessibility tree (the prior whole-row
 * `<a role="row">` overrode its own link role, so screen readers exposed a
 * row with no navigable control). Mirrors the home `RecentRidesTable` styling.
 *
 * Honest data gaps (per the v2 plan): the per-ride region subtext and the
 * ⚠ hazard badge have no backing data on the summary, so the RIDE cell shows
 * the ride type alone.
 */
export function RideRow({ ride, last }: Props) {
  const tier = scoreToQualityTier(ride.avg_road_quality);
  const name = ride.name ?? formatShortDate(ride.started_at);
  return (
    <div
      role="row"
      className={`${ROW_COLS} relative px-5 py-3 text-[13px] transition hover:bg-paper focus-within:bg-paper ${
        last ? "" : "border-b border-line"
      }`}
    >
      <span role="cell">
        <Mono className="text-fg-dim">{formatShortDate(ride.started_at)}</Mono>
      </span>
      <span role="cell" className="min-w-0 leading-tight">
        <Link
          href={`/rides/${ride.id}`}
          className="block truncate rounded-sm font-bold text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {name}
        </Link>
        <Mono className="text-[10px] uppercase text-fg-mute">
          {ride.ride_type}
        </Mono>
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
        <Mono className="text-ink">
          {ride.max_lean_angle != null
            ? `${Math.round(ride.max_lean_angle)}°`
            : "—"}
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
        <ArrowRight size={14} className="text-fg-mute" aria-hidden />
      </span>
    </div>
  );
}
