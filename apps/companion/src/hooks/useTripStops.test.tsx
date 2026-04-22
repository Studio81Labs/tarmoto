import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccommodationsResponse, AlongRoutePoisResponse } from "@/lib/api";
import { poiApi } from "@/lib/api";
import { useTripStops } from "./useTripStops";
import type { Trip } from "@/lib/types";
import type { TripStopsOptions } from "@/lib/trip-stops";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function trip(id: string, title: string): Trip {
  return {
    id,
    name: `${title} trip`,
    status: "draft",
    createdAt: "2026-04-01T09:00:00Z",
    updatedAt: "2026-04-14T09:00:00Z",
    parameters: {
      days: 1,
      dailyKmTarget: 240,
      roadPreference: "curvy",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    collaborators: [],
    days: [
      {
        dayNumber: 1,
        title,
        distanceKm: 248,
        durationMinutes: 360,
        elevationGain: 2640,
        avgQuality: 4.1,
        waypoints: [
          {
            id: `${id}-start`,
            name: `${title} start`,
            location: { lat: 46.47, lng: 10.37 },
            type: "start",
          },
          {
            id: `${id}-end`,
            name: `${title} end`,
            location: { lat: 46.61, lng: 10.57 },
            type: "end",
          },
        ],
      },
    ],
  };
}

describe("useTripStops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuilds placeholder day rows when the active trip changes", async () => {
    const options: TripStopsOptions = {
      poiKinds: ["fuel_station"],
      minAccommodationStars: undefined,
    };
    const firstStayRequest = createDeferred<{ data: AccommodationsResponse }>();
    const secondStayRequest = createDeferred<{
      data: AccommodationsResponse;
    }>();
    const firstPoiRequest = createDeferred<{ data: AlongRoutePoisResponse }>();
    const secondPoiRequest = createDeferred<{ data: AlongRoutePoisResponse }>();

    const getAccommodationsMock = vi
      .spyOn(poiApi, "getAccommodations")
      .mockImplementationOnce(() => firstStayRequest.promise)
      .mockImplementationOnce(() => secondStayRequest.promise);
    const getAlongRouteMock = vi
      .spyOn(poiApi, "getAlongRoute")
      .mockImplementationOnce(() => firstPoiRequest.promise)
      .mockImplementationOnce(() => secondPoiRequest.promise);

    const firstTrip = trip("trip-1", "Stelvio");
    const secondTrip = trip("trip-2", "Dolomites");

    const { result, rerender } = renderHook(
      ({ activeTrip }) => useTripStops(activeTrip, options),
      {
        initialProps: { activeTrip: firstTrip },
      },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
      expect(result.current.days[0]?.title).toBe("Stelvio");
    });

    rerender({ activeTrip: secondTrip });

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
      expect(result.current.days[0]?.title).toBe("Dolomites");
    });

    await act(async () => {
      firstStayRequest.resolve({
        data: { accommodations: [], radius_km: 12, kinds: [] },
      });
      firstPoiRequest.resolve({
        data: {
          pois: [],
          buffer_km: 2,
          kinds: ["fuel_station"],
          route_length_km: 0,
        },
      });
      secondStayRequest.resolve({
        data: { accommodations: [], radius_km: 12, kinds: [] },
      });
      secondPoiRequest.resolve({
        data: {
          pois: [],
          buffer_km: 2,
          kinds: ["fuel_station"],
          route_length_km: 0,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.days[0]?.title).toBe("Dolomites");
    });

    expect(getAccommodationsMock).toHaveBeenCalledTimes(2);
    expect(getAlongRouteMock).toHaveBeenCalledTimes(2);
  });
});
