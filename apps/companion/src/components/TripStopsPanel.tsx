"use client";

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
      <div className="space-y-3 pt-2 border-t border-slate-800">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
          <BedDouble size={14} className="text-slate-500" />
          Trip stops & stays
        </div>
        <p className="text-xs text-slate-500">
          Load or import a trip to start finding overnight stays and route-side
          stops.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-2 border-t border-slate-800">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
        <BedDouble size={14} className="text-slate-500" />
        Trip stops & stays
      </div>

      <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
        <div>
          <label
            htmlFor="trip-stops-rating"
            className="block text-xs text-slate-500 mb-1"
          >
            Minimum stay rating
          </label>
          <select
            id="trip-stops-rating"
            value={minAccommodationStars ?? ""}
            onChange={(event) =>
              setMinAccommodationStars(
                event.target.value ? Number(event.target.value) : undefined,
              )
            }
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition focus:border-tarmoto-cyan focus:outline-none"
          >
            <option value="">Any</option>
            <option value="3">3 stars or better</option>
            <option value="4">4 stars or better</option>
            <option value="5">5 stars only</option>
          </select>
        </div>

        <div>
          <p className="mb-2 text-xs text-slate-500">POI types</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DEFAULT_POI_KINDS.map((kind) => (
              <label
                key={kind}
                className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-300"
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
                  className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
                />
                {POI_LABELS[kind]}
              </label>
            ))}
          </div>
        </div>
      </div>

      {error ? <p className="text-xs text-amber-300">{error}</p> : null}
      {loading ? (
        <p className="text-xs text-slate-500">Loading stop suggestions…</p>
      ) : (
        <div className="space-y-3">
          {days.map((day, dayIndex) => (
            <section
              key={day.dayNumber}
              className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"
            >
              <div className="mb-3">
                <h4 className="text-sm font-semibold text-slate-100">
                  Day {day.dayNumber}
                  {day.title ? ` · ${day.title}` : ""}
                </h4>
                <p className="text-xs text-slate-500">
                  Overnight stays
                  {day.endLabel ? ` near ${day.endLabel}` : " near the day end"}
                </p>
              </div>

              <div className="space-y-2">
                {day.accommodations.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No overnight stays matched the current filters.
                  </p>
                ) : (
                  day.accommodations
                    .slice(0, 3)
                    .map((stay) => (
                      <StopRow
                        key={stay.external_id}
                        label={stay.name ?? "Suggested stay"}
                        detail={`${formatDistance(stay.distance_km, unitSystem)} from the finish${
                          stay.stars ? ` · ${stay.stars}★` : ""
                        }`}
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

              <div className="mt-4 border-t border-slate-800 pt-3">
                <p className="text-xs text-slate-500 mb-2">Along the route</p>
                {!day.routeAvailable ? (
                  <p className="text-xs text-slate-500">
                    Add at least two waypoints to surface along-route stops.
                  </p>
                ) : day.pois.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No route-side stops matched the current POI filters.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {day.pois.slice(0, 6).map((poi) => {
                      const Icon = POI_ICONS[poi.kind];
                      return (
                        <StopRow
                          key={poi.external_id}
                          label={poi.name ?? POI_BADGES[poi.kind]}
                          detail={`${formatDistance(
                            poi.distance_along_route_km,
                            unitSystem,
                          )} into the day · ${formatDistance(
                            poi.distance_from_route_km,
                            unitSystem,
                          )} off route`}
                          hint={poi.hint}
                          badge={
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
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
    <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-100">{label}</p>
          {badge}
        </div>
        <p className="text-xs text-slate-400">{detail}</p>
        {hint ? (
          <p className="text-xs text-slate-500 truncate">{hint}</p>
        ) : null}
      </div>

      <button
        type="button"
        aria-label={added ? addedLabel : addLabel}
        disabled={added}
        onClick={onAdd}
        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
          added
            ? "cursor-not-allowed bg-emerald-500/10 text-emerald-300"
            : "bg-tarmoto-cyan text-slate-950 hover:bg-tarmoto-cyan-light"
        }`}
      >
        {added ? "Added" : "Add"}
      </button>
    </div>
  );
}
