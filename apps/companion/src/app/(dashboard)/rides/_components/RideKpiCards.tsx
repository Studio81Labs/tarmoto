"use client";

import type { RideStats } from "@tarmoto/shared";
import { MetricTile, type MetricTileProps } from "@tarmoto/ui";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { usePreferencesStore } from "@/stores/preferences";
import { splitFormattedDistance } from "@/lib/utils";

const DASH = "—";

/**
 * Backend serves unrounded hour totals; round for display, but drop to minutes
 * for sub-hour windows so a 20-minute total doesn't floor to "0 HRS".
 */
function formatRideTime(hours: number): { value: number; unit: string } {
  if (hours > 0 && hours < 1) {
    return { value: Math.round(hours * 60), unit: "MIN" };
  }
  return { value: Math.round(hours), unit: "HRS" };
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
  const { format } = useNumberFormat();
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const has = stats != null;
  // Distance honours the rider's unit preference (km/m vs mi/ft); the unit
  // shows km/mi even on the em-dash state so the card reads consistently.
  const distance = has
    ? splitFormattedDistance(stats.total_distance_km, unitSystem)
    : null;
  const distanceUnit =
    distance?.unit ?? (unitSystem === "imperial" ? "MI" : "KM");
  const rideTime = formatRideTime(stats?.total_hours ?? 0);

  // The KPI brick is the shared `MetricTile` (§12). First tile is the
  // ink + accent "proudest metric"; the rest are default cream tiles.
  // Numeric values are passed raw so MetricTile applies locale grouping;
  // avg quality keeps a fixed 1-decimal, locale-formatted string.
  const tiles: MetricTileProps[] = [
    {
      label: "Distance",
      value: distance ? distance.value : DASH,
      unit: distanceUnit,
      variant: "ink",
      accentNumber: true,
    },
    {
      label: "Ride time",
      value: has ? rideTime.value : DASH,
      unit: rideTime.unit,
    },
    {
      // Distinct roads ridden in the active window — not strictly first-time
      // discoveries (a road repeated in the window still counts), so the
      // sublabel reads RIDDEN rather than overstating DISCOVERED.
      label: "Roads",
      value: has ? stats.new_roads : DASH,
      unit: "RIDDEN",
    },
    {
      label: "Avg quality",
      value:
        has && stats.avg_quality != null
          ? format(stats.avg_quality, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })
          : DASH,
      unit: "/ 5",
    },
  ];

  return (
    <div className="mb-[18px]">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {tiles.map((tile) => (
          <MetricTile key={tile.label} formatValue={format} {...tile} />
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
