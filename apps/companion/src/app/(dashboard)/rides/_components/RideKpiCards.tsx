"use client";

import type { RideStats } from "@tarmoto/shared";
import { Mono, Stamp } from "@tarmoto/ui";

/**
 * 4-up KPI row for the Ride History "All rides" tab, reflecting the ACTIVE
 * filter window (search / ride-type / time pills / advanced filters) via
 * `GET /rides/stats`. First card (Distance) is ink + accent per the v2
 * design; the rest are cream cards.
 *
 * Sums/averages are filter-window totals, so we show a neutral unit sublabel
 * (KM / HRS / DISCOVERED / "/ 5") rather than the design mock's month-over-
 * month delta, which has no honest backing here.
 */
export function RideKpiCards({ stats }: { stats: RideStats | null }) {
  const cards: { label: string; value: string; unit: string; ink?: boolean }[] =
    [
      {
        // Backend returns unrounded totals; round for display here.
        label: "Distance",
        value: Math.round(stats?.total_distance_km ?? 0).toLocaleString(),
        unit: "KM",
        ink: true,
      },
      {
        label: "Ride time",
        value: String(Math.round(stats?.total_hours ?? 0)),
        unit: "HRS",
      },
      {
        label: "New roads",
        value: String(stats?.new_roads ?? 0),
        unit: "DISCOVERED",
      },
      {
        label: "Avg quality",
        value: stats?.avg_quality != null ? stats.avg_quality.toFixed(1) : "—",
        unit: "/ 5",
      },
    ];

  return (
    <div className="mb-[18px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className={
            c.ink
              ? "rounded-[14px] border border-ink bg-ink p-[18px] text-cream"
              : "rounded-[14px] border border-line bg-cream p-[18px] text-ink"
          }
        >
          <Stamp tone={c.ink ? "on-dark" : "dim"}>{c.label}</Stamp>
          <div className="mt-2 flex items-baseline gap-1.5">
            <div
              className={`text-[36px] font-extrabold leading-none tracking-[-1px] ${
                c.ink ? "text-accent" : "text-ink"
              }`}
            >
              {c.value}
            </div>
            <Mono
              className={
                c.ink
                  ? "text-[11px] text-fg-on-dark-mute"
                  : "text-[11px] text-fg-mute"
              }
            >
              {c.unit}
            </Mono>
          </div>
        </div>
      ))}
    </div>
  );
}
