"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { BedDouble, Camera, Coffee, Fuel, UtensilsCrossed } from "lucide-react";
import { useTripStops } from "@/hooks/useTripStops";
import {
  buildSuggestionWaypoint,
  isSuggestionWaypointAdded,
  type PoiKind,
} from "@/lib/trip-stops";
import type { Trip } from "@/lib/types";
import { formatDistance } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";
import { useTripStore } from "@/stores/trip";
const DEFAULT_POI_KINDS: PoiKind[] = [
  "fuel_station",
  "restaurant",
  "cafe",
  "viewpoint",
];
const POI_LABELS: Record<PoiKind, string> = {
  fuel_station: "Fuel stations",
  restaurant: "Restaurants",
  cafe: "Cafes",
  viewpoint: "Viewpoints",
};
const POI_BADGES: Record<PoiKind, string> = {
  fuel_station: "Fuel",
  restaurant: "Food",
  cafe: "Cafe",
  viewpoint: "Viewpoint",
};
const POI_ICONS: Record<PoiKind, typeof Fuel> = {
  fuel_station: Fuel,
  restaurant: UtensilsCrossed,
  cafe: Coffee,
  viewpoint: Camera,
};
interface TripStopsPanelProps {
  trip: Trip | null;
}
export function TripStopsPanel({ trip }: TripStopsPanelProps) {
  const [poiKinds, setPoiKinds] = useState<PoiKind[]>(DEFAULT_POI_KINDS);
  const [minAccommodationStars, setMinAccommodationStars] = useState<
    number | undefined
  >(undefined);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const activeTrip = useTripStore((s) => s.activeTrip);
  const addWaypoint = useTripStore((s) => s.addWaypoint);
  const insertWaypointBeforeEnd = useTripStore(
    (s) => s.insertWaypointBeforeEnd,
  );
  const { days, loading, error } = useTripStops(trip, {
    poiKinds,
    minAccommodationStars,
  });
  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);
  if (!trip) {
    return (
      <div className="space-y-3 pt-2 border-t border-line">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <BedDouble size={14} className="text-accent" />
          {t("Trip stops & stays ")}
        </div>
        <p className="text-xs text-fg-mute">
          {t(
            "Load or import a trip to start finding overnight stays and route-side stops. ",
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 pt-2 border-t border-line">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <BedDouble size={14} className="text-accent" />
        {t("Trip stops & stays ")}
      </div>

      <div className="grid gap-3 rounded-xl border border-line bg-paper p-3">
        <div>
          <label
            htmlFor="trip-stops-rating"
            className="block text-xs text-fg-mute mb-1"
          >
            {t("Minimum stay rating ")}
          </label>
          <select
            id="trip-stops-rating"
            value={minAccommodationStars ?? ""}
            onChange={(event) =>
              setMinAccommodationStars(
                event.target.value ? Number(event.target.value) : undefined,
              )
            }
            className="w-full rounded-lg border border-line-strong bg-cream px-3 py-2 text-sm text-ink transition focus:border-accent focus:outline-none"
          >
            <option value="">{t("Any")}</option>
            <option value="3">{t("3 stars or better")}</option>
            <option value="4">{t("4 stars or better")}</option>
            <option value="5">{t("5 stars only")}</option>
          </select>
        </div>

        <div>
          <p className="mb-2 text-xs text-fg-mute">{t("POI types")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DEFAULT_POI_KINDS.map((kind) => (
              <label
                key={kind}
                className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-fg-dim"
              >
                <input
                  type="checkbox"
                  aria-label={POI_LABELS[kind]}
                  checked={poiKinds.includes(kind)}
                  onChange={() =>
                    setPoiKinds((current) =>
                      current.includes(kind)
                        ? current.filter((value) => value !== kind)
                        : [...current, kind],
                    )
                  }
                  className="rounded border-line-strong bg-cream text-accent focus:ring-accent"
                />
                {POI_LABELS[kind]}
              </label>
            ))}
          </div>
        </div>
      </div>

      {error ? <p className="text-xs text-amber-600">{error}</p> : null}
      {loading ? (
        <p className="text-xs text-fg-mute">
          {t("Loading stop suggestions\u2026")}
        </p>
      ) : (
        <div className="space-y-3">
          {days.map((day, dayIndex) => (
            <section
              key={day.dayNumber}
              className="rounded-xl border border-line bg-paper p-3"
            >
              <div className="mb-3">
                <h4 className="text-sm font-semibold text-ink">
                  {t("Day ")}
                  {day.dayNumber}
                  {day.title ? ` · ${day.title}` : ""}
                </h4>
                <p className="text-xs text-fg-mute">
                  {t("Overnight stays ")}
                  {day.endLabel ? ` near ${day.endLabel}` : " near the day end"}
                </p>
              </div>

              <div className="space-y-2">
                {day.accommodations.length === 0 ? (
                  <p className="text-xs text-fg-mute">
                    {t("No overnight stays matched the current filters. ")}
                  </p>
                ) : (
                  day.accommodations
                    .slice(0, 3)
                    .map((stay) => (
                      <StopRow
                        key={stay.external_id}
                        label={stay.name ?? "Suggested stay"}
                        detail={`${formatDistance(stay.distance_km, unitSystem)} from the finish${stay.stars ? ` · ${stay.stars}★` : ""}`}
                        hint={stay.website ?? stay.phone}
                        added={Boolean(
                          activeTrip?.days[dayIndex] &&
                          isSuggestionWaypointAdded(
                            activeTrip.days[dayIndex]!,
                            stay,
                          ),
                        )}
                        addLabel={`Add ${stay.name ?? "suggestion"} to day ${day.dayNumber} itinerary`}
                        addedLabel={`Added ${stay.name ?? "suggestion"} to day ${day.dayNumber} itinerary`}
                        onAdd={() =>
                          addWaypoint(dayIndex, buildSuggestionWaypoint(stay))
                        }
                      />
                    ))
                )}
              </div>

              <div className="mt-4 border-t border-line pt-3">
                <p className="text-xs text-fg-mute mb-2">
                  {t("Along the route")}
                </p>
                {!day.routeAvailable ? (
                  <p className="text-xs text-fg-mute">
                    {t(
                      "Add at least two waypoints to surface along-route stops. ",
                    )}
                  </p>
                ) : day.pois.length === 0 ? (
                  <p className="text-xs text-fg-mute">
                    {t("No route-side stops matched the current POI filters. ")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {day.pois.slice(0, 6).map((poi) => {
                      const Icon = POI_ICONS[poi.kind];
                      return (
                        <StopRow
                          key={poi.external_id}
                          label={poi.name ?? POI_BADGES[poi.kind]}
                          detail={`${formatDistance(poi.distance_along_route_km, unitSystem)} into the day · ${formatDistance(poi.distance_from_route_km, unitSystem)} off route`}
                          hint={poi.hint}
                          badge={
                            <span className="inline-flex items-center gap-1 rounded-full bg-cream px-2 py-0.5 text-[11px] text-fg-dim">
                              <Icon size={11} />
                              {POI_BADGES[poi.kind]}
                            </span>
                          }
                          added={Boolean(
                            activeTrip?.days[dayIndex] &&
                            isSuggestionWaypointAdded(
                              activeTrip.days[dayIndex]!,
                              poi,
                            ),
                          )}
                          addLabel={`Add ${poi.name ?? "suggestion"} to day ${day.dayNumber} itinerary`}
                          addedLabel={`Added ${poi.name ?? "suggestion"} to day ${day.dayNumber} itinerary`}
                          onAdd={() =>
                            insertWaypointBeforeEnd(
                              dayIndex,
                              buildSuggestionWaypoint(poi),
                            )
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
function StopRow({
  label,
  detail,
  hint,
  badge,
  added,
  addLabel,
  addedLabel,
  onAdd,
}: {
  label: string;
  detail: string;
  hint?: string | null;
  badge?: React.ReactNode;
  added: boolean;
  addLabel: string;
  addedLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-paper p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-ink">{label}</p>
          {badge}
        </div>
        <p className="text-xs text-fg-dim">{detail}</p>
        {hint ? <p className="text-xs text-fg-mute truncate">{hint}</p> : null}
      </div>

      <button
        type="button"
        aria-label={added ? addedLabel : addLabel}
        disabled={added}
        onClick={onAdd}
        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
          added
            ? "cursor-not-allowed bg-[#1f8a5b]/10 text-[#1f8a5b]"
            : "bg-accent text-ink hover:brightness-95"
        }`}
      >
        {added ? "Added" : "Add"}
      </button>
    </div>
  );
}
