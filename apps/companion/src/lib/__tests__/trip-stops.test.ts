import { describe, expect, it } from "vitest";
import type { TripDay, Waypoint } from "@/lib/types";
import {
  buildDayRoutePoints,
  buildSuggestionWaypoint,
  isSuggestionWaypointAdded,
  type AccommodationSuggestion,
  type RoutePoiSuggestion,
} from "@/lib/trip-stops";

function waypoint(
  overrides: Partial<Waypoint> & { id: string; lat: number; lng: number },
): Waypoint {
  const { id, lat, lng, ...rest } = overrides;
  return {
    id,
    name: rest.name ?? `Waypoint ${id}`,
    location: { lat, lng },
    type: rest.type ?? "via",
  };
}

function day(overrides: Partial<TripDay> = {}): TripDay {
  return {
    dayNumber: overrides.dayNumber ?? 1,
    title: overrides.title ?? "Stelvio day",
    waypoints: overrides.waypoints ?? [
      waypoint({ id: "start", lat: 46.47, lng: 10.37, type: "start" }),
      waypoint({ id: "end", lat: 46.61, lng: 10.57, type: "end" }),
    ],
    routeGeometry: overrides.routeGeometry,
    distanceKm: overrides.distanceKm ?? 248,
    durationMinutes: overrides.durationMinutes ?? 360,
    elevationGain: overrides.elevationGain ?? 2640,
    avgQuality: overrides.avgQuality ?? 4.1,
    segments: overrides.segments,
    overnightStop: overrides.overnightStop,
  };
}

function accommodation(
  overrides: Partial<AccommodationSuggestion> & { external_id: string },
): AccommodationSuggestion {
  return {
    external_id: overrides.external_id,
    name: overrides.name ?? "Hotel Stelvio",
    kind: overrides.kind ?? "hotel",
    lat: overrides.lat ?? 46.61,
    lng: overrides.lng ?? 10.57,
    distance_km: overrides.distance_km ?? 0.8,
    website: overrides.website ?? "https://hotel.example.com",
    phone: overrides.phone ?? "+39000000000",
    stars: overrides.stars ?? 4,
  };
}

function routePoi(
  overrides: Partial<RoutePoiSuggestion> & { external_id: string },
): RoutePoiSuggestion {
  return {
    external_id: overrides.external_id,
    name: overrides.name ?? "Shell Bormio",
    kind: overrides.kind ?? "fuel_station",
    lat: overrides.lat ?? 46.53,
    lng: overrides.lng ?? 10.45,
    distance_along_route_km: overrides.distance_along_route_km ?? 72,
    distance_from_route_km: overrides.distance_from_route_km ?? 0.2,
    website: overrides.website ?? null,
    phone: overrides.phone ?? null,
    hint: overrides.hint ?? "Shell",
  };
}

describe("trip-stops helpers", () => {
  it("falls back to waypoint geometry when a day has no route polyline yet", () => {
    expect(buildDayRoutePoints(day())).toEqual([
      { lat: 46.47, lng: 10.37 },
      { lat: 46.61, lng: 10.57 },
    ]);
  });

  it("prefers stored route geometry when available", () => {
    expect(
      buildDayRoutePoints(
        day({
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.37, 46.47],
              [10.45, 46.53],
              [10.57, 46.61],
            ],
          },
        }),
      ),
    ).toEqual([
      { lat: 46.47, lng: 10.37 },
      { lat: 46.53, lng: 10.45 },
      { lat: 46.61, lng: 10.57 },
    ]);
  });

  it("maps stay and poi suggestions into itinerary waypoint types", () => {
    expect(
      buildSuggestionWaypoint(accommodation({ external_id: "stay-1" })),
    ).toMatchObject({
      id: "suggestion-accommodation-stay-1",
      name: "Hotel Stelvio",
      type: "accommodation",
      location: { lat: 46.61, lng: 10.57 },
    });

    expect(
      buildSuggestionWaypoint(
        routePoi({ external_id: "fuel-1", kind: "fuel_station" }),
      ),
    ).toMatchObject({
      id: "suggestion-fuel_station-fuel-1",
      type: "fuel",
    });

    expect(
      buildSuggestionWaypoint(
        routePoi({ external_id: "view-1", kind: "viewpoint" }),
      ),
    ).toMatchObject({
      id: "suggestion-viewpoint-view-1",
      type: "photo",
    });
  });

  it("detects when a suggestion is already present in the itinerary", () => {
    const stay = accommodation({ external_id: "stay-1" });
    const tripDay = day({
      waypoints: [
        waypoint({ id: "start", lat: 46.47, lng: 10.37, type: "start" }),
        buildSuggestionWaypoint(stay),
        waypoint({ id: "end", lat: 46.61, lng: 10.57, type: "end" }),
      ],
    });

    expect(isSuggestionWaypointAdded(tripDay, stay)).toBe(true);
    expect(
      isSuggestionWaypointAdded(
        tripDay,
        routePoi({ external_id: "fuel-1", kind: "fuel_station" }),
      ),
    ).toBe(false);
  });
});
