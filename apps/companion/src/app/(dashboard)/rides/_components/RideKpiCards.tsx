"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import type { RideStats } from "@tarmoto/shared";
import { MetricTile, type MetricTileProps } from "@tarmoto/ui";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

const DASH = "—";

/**
 * Backend serves unrounded hour totals; round for display, but drop to minutes
 * for sub-hour windows so a 20-minute total doesn't floor to "0 HRS".
 */
function formatRideTime(hours: number, format: ReturnType<typeof useFormat>) {
  if (hours > 0 && hours < 1) {
    return format.splitUnit(Math.round(hours * 60), "minute", {
      unitDisplay: "short",
      maximumFractionDigits: 0,
    });
  }
  return format.splitUnit(Math.round(hours), "hour", {
    unitDisplay: "short",
    maximumFractionDigits: 0,
  });
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
  const t = useTranslation();
  const format = useFormat();
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const has = stats != null;
  // Distance honours the rider's unit preference (km/m vs mi/ft) via the
  // format seam; the unit shows even on the em-dash state so the card reads
  // consistently.
  const distance = format.splitDistanceKm(stats?.total_distance_km ?? 0);
  const rideTime = formatRideTime(stats?.total_hours ?? 0, format);
  const quality =
    has && stats.avg_quality != null
      ? t("{score} / {max}", {
          score: format.decimal(stats.avg_quality, 1),
          max: format.integer(5),
        })
      : DASH;

  // The KPI brick is the shared `MetricTile` (§12). First tile is the
  // ink + accent "proudest metric"; the rest are default cream tiles.
  // Values are formatted through the active regional seam before rendering.
  const tiles: MetricTileProps[] = [
    {
      label: t("Distance"),
      value: has ? distance.value : DASH,
      unit: distance.unit,
      unitPosition: distance.unitPosition,
      variant: "ink",
      accentNumber: true,
    },
    {
      label: t("Ride time"),
      value: has ? rideTime.value : DASH,
      unit: rideTime.unit,
      unitPosition: rideTime.unitPosition,
    },
    {
      // Distinct roads ridden in the active window — not strictly first-time
      // discoveries (a road repeated in the window still counts), so the
      // sublabel reads RIDDEN rather than overstating DISCOVERED.
      label: t("Roads"),
      value: has ? format.integer(stats.new_roads) : DASH,
      unit: t("RIDDEN"),
      unitPosition: "after",
    },
    // Dropped whole under the kill — an em dash beside "Avg quality" still
    // says a figure exists and is being withheld.
    ...(qualityEnabled ? [{ label: t("Avg quality"), value: quality }] : []),
  ];

  return (
    <div className="mb-[18px]">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {tiles.map((tile) => (
          <MetricTile key={tile.label} {...tile} />
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {t("Couldn't load ride stats.")}
        </p>
      )}
    </div>
  );
}
