import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { poiApi } from "@/lib/api";
import {
  buildTripDayStops,
  buildTripStopsRequestPlan,
  type TripDayStops,
  type TripStopsOptions,
} from "@/lib/trip-stops";
import type { Trip } from "@/lib/types";

interface TripStopsResult {
  days: TripDayStops[];
  loading: boolean;
  error: string | null;
}

const ACCOMMODATION_RADIUS_KM = 12;
const ALONG_ROUTE_BUFFER_KM = 2;
const EMPTY_DAYS: TripDayStops[] = [];

export function useTripStops(
  trip: Trip | null,
  options: TripStopsOptions,
): TripStopsResult {
  const normalizedKinds = useMemo(
    () => [...options.poiKinds].sort(),
    [options.poiKinds],
  );

  const requestPlan = useMemo(() => buildTripStopsRequestPlan(trip), [trip]);

  // Skeleton days the UI can show while loading: same `dayNumber` /
  // `endLabel` / `routeAvailable` columns as the eventual result,
  // just with empty accommodation + POI arrays. Without this, the
  // first render of a new trip would show nothing instead of the
  // shape the planner is about to fill in.
  const skeletonDays = useMemo(
    () => (trip ? buildTripDayStops(trip, new Map(), new Map()) : EMPTY_DAYS),
    [trip],
  );

  const query = useQuery({
    queryKey: [
      "trip-stops",
      requestPlan?.tripId ?? null,
      requestPlan,
      normalizedKinds,
      options.minAccommodationStars ?? null,
    ],
    enabled: trip != null && requestPlan != null,
    queryFn: async ({ signal }) => {
      if (!trip || !requestPlan) {
        return { days: EMPTY_DAYS, failures: [] as string[] };
      }
      const accommodationsByDay = new Map();
      const poisByDay = new Map();
      const failures: string[] = [];

      await Promise.all(
        requestPlan.days.map(async (day) => {
          const { endAnchor, routePoints } = day;
          const [accommodationsResult, poisResult] = await Promise.allSettled([
            endAnchor
              ? poiApi.getAccommodations(
                  {
                    lat: endAnchor.lat,
                    lng: endAnchor.lng,
                    radius_km: ACCOMMODATION_RADIUS_KM,
                    ...(options.minAccommodationStars !== undefined
                      ? { min_stars: options.minAccommodationStars }
                      : {}),
                  },
                  { signal },
                )
              : Promise.resolve({ data: { accommodations: [] } }),
            routePoints.length >= 2 && normalizedKinds.length > 0
              ? poiApi.getAlongRoute(
                  {
                    route: routePoints,
                    buffer_km: ALONG_ROUTE_BUFFER_KM,
                    kinds: normalizedKinds,
                  },
                  { signal },
                )
              : Promise.resolve({ data: { pois: [] } }),
          ]);

          if (accommodationsResult.status === "fulfilled") {
            accommodationsByDay.set(
              day.dayNumber,
              accommodationsResult.value.data.accommodations,
            );
          } else {
            failures.push(`Day ${day.dayNumber} stays`);
            accommodationsByDay.set(day.dayNumber, []);
          }

          if (poisResult.status === "fulfilled") {
            poisByDay.set(day.dayNumber, poisResult.value.data.pois);
          } else {
            failures.push(`Day ${day.dayNumber} stops`);
            poisByDay.set(day.dayNumber, []);
          }
        }),
      );

      return {
        days: buildTripDayStops(trip, accommodationsByDay, poisByDay),
        failures,
      };
    },
  });

  if (!trip || !requestPlan) {
    return { days: EMPTY_DAYS, loading: false, error: null };
  }

  if (query.isError) {
    return {
      days: skeletonDays,
      loading: false,
      error:
        query.error instanceof Error
          ? query.error.message
          : "Failed to load planner stop suggestions.",
    };
  }

  const days = query.data?.days ?? skeletonDays;
  const failures = query.data?.failures ?? [];
  return {
    days,
    loading: query.isLoading,
    error:
      failures.length > 0
        ? `Some planner stop suggestions could not be loaded (${failures.join(", ")}).`
        : null,
  };
}
