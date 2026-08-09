import { BedDouble, MapPin } from "lucide-react";
import { QualityBars, Stamp } from "@tarmoto/ui";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { useTranslation } from "@/i18n/I18nProvider";
import type { TripDay } from "@/lib/types";
import { useFormat } from "@/format/FormatProvider";
import {
  hasCustomWaypointName,
  poiCategoryDisplayName,
} from "@/lib/planner/labels";
import type { Translate } from "@/i18n";

/**
 * Shared "Day-by-day" itinerary cards. Rendered read-only in the trip
 * preview (`/trips/[tripId]`) and, editable, in the planner's left day
 * column — so a rider sees the same card + active/inactive state whether
 * they're viewing or editing a multi-day trip.
 *
 * The active card (`selectedDayNumber === day.dayNumber`) highlights the
 * matching day on the map; clicking a card calls `onSelectDay` with the
 * day number and each surface wires the selection to its own map/routing.
 */

/** Map a 0–5 quality score onto the 1–5 tier the QualityBars glyph wants. */
export function qualityTierOf(score: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(score))) as 1 | 2 | 3 | 4 | 5;
}

/**
 * "Start → Finish" from the day's endpoints; a saved title wins unless it
 * just repeats the "Day N" heading next to it (the planner's default).
 */
export function dayRouteLabel(day: TripDay, t: Translate): string | null {
  const title = day.title?.trim();
  // "Day N" is the invariant persisted default, not display copy.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  if (title && title.toLowerCase() !== `day ${day.dayNumber}`) return title;
  const startWaypoint = day.waypoints[0];
  const endWaypoint = day.waypoints[day.waypoints.length - 1];
  const startName = startWaypoint?.name;
  const endName = endWaypoint?.name;
  const start = hasCustomWaypointName(
    startName,
    startWaypoint?.nameIsSource || Boolean(startWaypoint?.poiCategory),
  )
    ? startName.trim()
    : "";
  const end = hasCustomWaypointName(
    endName,
    endWaypoint?.nameIsSource || Boolean(endWaypoint?.poiCategory),
  )
    ? endName.trim()
    : "";
  return day.waypoints.length >= 2 && start && end
    ? t("{start} → {end}", { start, end })
    : null;
}

export function TileStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-line bg-paper px-3 py-2.5">
      <span className="block font-mono text-[8.5px] uppercase tracking-[0.5px] text-fg-mute">
        {label}
      </span>
      <div
        className={`mt-1 text-[15px] font-extrabold tracking-[-0.3px] tabular-nums ${
          accent && value !== "—" ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function DayByDayList({
  days,
  selectedDayNumber,
  onSelectDay,
  showHeading = true,
  className,
}: {
  days: TripDay[];
  selectedDayNumber: number | null;
  onSelectDay: (dayNumber: number) => void;
  /** Render the "Day-by-day" stamp heading (preview); planner supplies its own. */
  showHeading?: boolean;
  className?: string;
}) {
  // Read here rather than at the two callers (saved-trip detail and the
  // planner) so neither can be missed. Only the quality bars go — the day's
  // distance, duration and stops are not road-quality data.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const t = useTranslation();
  const format = useFormat();
  if (days.length === 0) return null;
  return (
    <section className={`space-y-2 ${className ?? ""}`}>
      {showHeading ? <Stamp as="h2">{t("Day-by-day")}</Stamp> : null}
      <ul className="space-y-3">
        {days.map((day) => {
          const routeLabel = dayRouteLabel(day, t);
          const selected = selectedDayNumber === day.dayNumber;
          return (
            <li key={day.dayNumber}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={t("Highlight day {day} on the map", {
                  day: day.dayNumber,
                })}
                onClick={() => onSelectDay(day.dayNumber)}
                className={`w-full cursor-pointer rounded-xl border bg-cream/60 p-4 text-left transition ${
                  selected
                    ? "border-accent"
                    : "border-line hover:border-line-strong"
                }`}
              >
                <div className="mb-3.5 flex items-center justify-between gap-2">
                  <h3 className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-[17px] font-extrabold leading-tight tracking-[-0.5px] text-ink">
                      {t("Day {day}", { day: day.dayNumber })}
                    </span>
                    {routeLabel ? (
                      <span className="truncate font-mono text-[11px] text-fg-mute">
                        · {routeLabel}
                      </span>
                    ) : null}
                  </h3>
                  {qualityOverlayEnabled && day.avgQuality > 0 && (
                    <QualityBars
                      q={qualityTierOf(day.avgQuality)}
                      size={4}
                      className="shrink-0"
                    />
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <TileStat
                    label={t("Distance")}
                    value={format.distanceKm(day.distanceKm)}
                  />
                  <TileStat
                    label={t("Ride time")}
                    value={
                      day.durationMinutes > 0
                        ? format.duration(day.durationMinutes)
                        : "—"
                    }
                  />
                  <TileStat
                    label={t("Elevation")}
                    value={
                      day.elevationGain > 0
                        ? format.elevation(day.elevationGain)
                        : "—"
                    }
                    accent
                  />
                </div>
                <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-fg-dim">
                  {day.overnightStop && (
                    <span className="inline-flex items-center gap-1.5">
                      <BedDouble size={12} className="text-fg-mute" />
                      {t("Overnight: {name}", {
                        name: hasCustomWaypointName(
                          day.overnightStop.name,
                          day.overnightStop.nameIsSource ||
                            Boolean(day.overnightStop.poiCategory),
                        )
                          ? day.overnightStop.name
                          : day.overnightStop.poiCategory
                            ? poiCategoryDisplayName(
                                day.overnightStop.poiCategory,
                                t,
                              )
                            : t("Accommodation"),
                      })}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin size={12} className="text-fg-mute" />
                    {t(
                      "{count, plural, one {# waypoint} other {# waypoints}}",
                      {
                        count: day.waypoints.length,
                      },
                    )}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
