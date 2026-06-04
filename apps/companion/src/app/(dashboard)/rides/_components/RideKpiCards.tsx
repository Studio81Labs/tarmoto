"use client";

import type { RideStats } from "@tarmoto/shared";
import { MetricTile, type MetricTileProps } from "@tarmoto/ui";

const DASH = "—";

/**
 * Backend serves unrounded km totals; round for display, but drop to meters
 * for sub-km windows so a real 0.4 km total doesn't floor to "0 KM".
 */
function formatDistance(km: number): { value: string; unit: string } {
  if (km > 0 && km < 1) {
    return { value: String(Math.round(km * 1000)), unit: "M" };
  }
  return { value: Math.round(km).toLocaleString(), unit: "KM" };
}

/**
 * Backend serves unrounded hour totals; round for display, but drop to minutes
 * for sub-hour windows so a 20-minute total doesn't floor to "0 HRS".
 */
function formatRideTime(hours: number): { value: string; unit: string } {
  if (hours > 0 && hours < 1) {
    return { value: String(Math.round(hours * 60)), unit: "MIN" };
  }
  return { value: String(Math.round(hours)), unit: "HRS" };
}

/**
 * 4-up KPI row for the Ride History "All rides" tab, reflecting the ACTIVE
 * filter window (search / ride-type / time pills / advanced filters) via
 * `GET /rides/stats`. First card (Distance) is ink + accent per the v2
 * design; the rest are cream cards.
 *
 * Sums/averages are filter-window totals, so we show a neutral unit sublabel
 * (KM / HRS / DISCOVERED / "/ 5") rather than the design mock's month-over-
 * month delta, which has no honest backing here.
 *
 * When stats are unavailable (a `GET /rides/stats` failure, or the first load)
 * the values show an em dash rather than `0` — a zero would misread as "no
 * matching activity" even while the table still lists rides. A failed fetch
 * also surfaces an inline error so the rider knows the cards are stale, not
 * empty.
 */
export function RideKpiCards({
  stats,
  error = false,
}: {
  stats: RideStats | null;
  error?: boolean;
}) {
  const distance = formatDistance(stats?.total_distance_km ?? 0);
  const rideTime = formatRideTime(stats?.total_hours ?? 0);
  const has = stats != null;

  // The KPI brick is the shared `MetricTile` (§12). First tile is the
  // ink + accent "proudest metric"; the rest are default cream tiles.
  const tiles: MetricTileProps[] = [
    {
      label: "Distance",
      value: has ? distance.value : DASH,
      unit: distance.unit,
      variant: "ink",
      accentNumber: true,
    },
    {
      label: "Ride time",
      value: has ? rideTime.value : DASH,
      unit: rideTime.unit,
    },
    {
      label: "New roads",
      value: has ? String(stats.new_roads) : DASH,
      unit: "DISCOVERED",
    },
    {
      label: "Avg quality",
      value:
        has && stats.avg_quality != null ? stats.avg_quality.toFixed(1) : DASH,
      unit: "/ 5",
    },
  ];

  return (
    <div className="mb-[18px]">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {tiles.map((tile) => (
          <MetricTile key={tile.label} {...tile} />
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          Couldn&apos;t load ride stats.
        </p>
      )}
    </div>
  );
}
