import { useEffect, useMemo, useRef, useState } from "react";
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

export function useTripStops(
  trip: Trip | null,
  options: TripStopsOptions,
): TripStopsResult {
  const [state, setState] = useState<TripStopsResult>({
    days: [],
    loading: false,
    error: null,
  });

  const normalizedKinds = useMemo(
    () => [...options.poiKinds].sort(),
    [options.poiKinds],
  );

  const nextRequestPlan = useMemo(
    () => buildTripStopsRequestPlan(trip),
    [trip],
  );

  const requestPlanKey = useMemo(
    () => JSON.stringify(nextRequestPlan),
    [nextRequestPlan],
  );

  const stableRequestRef = useRef<{
    key: string;
    trip: Trip | null;
    plan: typeof nextRequestPlan;
  }>({
    key: requestPlanKey,
    trip,
    plan: nextRequestPlan,
  });

  if (stableRequestRef.current.key !== requestPlanKey) {
    stableRequestRef.current = {
      key: requestPlanKey,
      trip,
      plan: nextRequestPlan,
    };
  }

  useEffect(() => {
    const stableTrip = stableRequestRef.current.trip;
    const requestPlan = stableRequestRef.current.plan;
    if (!stableTrip || !requestPlan) {
      setState({ days: [], loading: false, error: null });
      return;
    }

    let cancelled = false;

    setState((current) => ({
      days:
        current.days.length > 0
          ? current.days
          : buildTripDayStops(stableTrip, new Map(), new Map()),
      loading: true,
      error: null,
    }));

    const load = async () => {
      const accommodationsByDay = new Map();
      const poisByDay = new Map();
      const failures: string[] = [];

      await Promise.all(
        requestPlan.days.map(async (day) => {
          const { endAnchor, routePoints } = day;

          const [accommodationsResult, poisResult] = await Promise.allSettled([
            endAnchor
              ? poiApi.getAccommodations({
                  lat: endAnchor.lat,
                  lng: endAnchor.lng,
                  radius_km: ACCOMMODATION_RADIUS_KM,
                  min_stars: options.minAccommodationStars,
                })
              : Promise.resolve({ data: { accommodations: [] } }),
            routePoints.length >= 2 && normalizedKinds.length > 0
              ? poiApi.getAlongRoute({
                  route: routePoints,
                  buffer_km: ALONG_ROUTE_BUFFER_KM,
                  kinds: normalizedKinds,
                })
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

      if (cancelled) return;

      setState({
        days: buildTripDayStops(stableTrip, accommodationsByDay, poisByDay),
        loading: false,
        error:
          failures.length > 0
            ? `Some planner stop suggestions could not be loaded (${failures.join(", ")}).`
            : null,
      });
    };

    load().catch((err) => {
      if (cancelled) return;
      setState({
        days: buildTripDayStops(stableTrip, new Map(), new Map()),
        loading: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to load planner stop suggestions.",
      });
    });

    return () => {
      cancelled = true;
    };
  }, [requestPlanKey, normalizedKinds, options.minAccommodationStars]);

  return state;
}
