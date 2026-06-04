"use client";
import { t } from "@/i18n";
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
 * A single Ride History table row. The whole row is a `Link` to the ride
 * detail page (`/rides/[rideId]`), where rename + full stats live. Mirrors
 * the home `RecentRidesTable` styling + a11y roles.
 *
 * Honest data gaps (per the v2 plan): the per-ride region subtext and the
 * ⚠ hazard badge have no backing data on the summary, so the RIDE cell shows
 * the ride type alone.
 */
export function RideRow({ ride, last }: Props) {
  const tier = scoreToQualityTier(ride.avg_road_quality);
  const name = ride.name ?? formatShortDate(ride.started_at);
  return (
    <Link
      href={`/rides/${ride.id}`}
      role="row"
      className={`${ROW_COLS} px-5 py-3.5 text-[13px] transition hover:bg-paper ${
        last ? "" : "border-b border-line"
      }`}
    >
      <span role="cell">
        <Mono className="text-fg-dim">{formatShortDate(ride.started_at)}</Mono>
      </span>
      <span role="cell" className="min-w-0">
        <span className="block truncate font-bold text-ink">{name}</span>
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
        <ArrowRight
          size={14}
          className="text-fg-mute"
          aria-label={t("Open ride")}
        />
      </span>
    </Link>
  );
}
