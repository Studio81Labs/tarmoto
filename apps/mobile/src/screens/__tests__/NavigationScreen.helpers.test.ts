import type { LatLng, Trip, Waypoint } from "@/types";
import { resolveNavigationRoute } from "../NavigationScreen.helpers";

const sampleGeometry: LatLng[] = [
  { lat: 49.2, lng: 16.6 },
  { lat: 49.21, lng: 16.61 },
];

function makeWaypoint(over: Partial<Waypoint> = {}): Waypoint {
  return {
    id: "wp-1",
    sequence: 0,
    lat: 49.2,
    lng: 16.6,
    name: "Start",
    waypoint_type: "start",
    ...over,
  };
}

function makeTrip(over: Partial<Trip> = {}): Trip {
  return {
    id: "trip-1",
    title: "Tour",
    region: null,
    num_days: 1,
    status: "planned",
    member_count: 1,
    created_at: "2026-05-01T00:00:00Z",
    daily_km_min: 100,
    daily_km_max: 300,
    min_quality: 3,
    road_preference: "mixed",
    members: [],
    days: [
      {
        id: "day-1",
        day_number: 1,
        title: "Day One",
        distance_km: 50,
        avg_quality: 4.2,
        elevation_gain: 200,
        elevation_loss: 100,
        curviness_score: 0.6,
        scenic_score: 0.7,
        estimated_time_min: 180,
        route_geometry: sampleGeometry,
        waypoints: [makeWaypoint()],
      },
    ],
    ...over,
  };
}

describe("resolveNavigationRoute", () => {
  it("uses inline polyline params verbatim and defaults the title", () => {
    const result = resolveNavigationRoute(
      { source: "polyline", polyline: sampleGeometry },
      null,
    );
    expect(result.polyline).toBe(sampleGeometry);
    expect(result.title).toBe("Navigation");
    expect(result.waypoints).toEqual([]);
  });

  it("preserves caller-supplied title and waypoints in the polyline branch", () => {
    const waypoints = [makeWaypoint({ name: "Mid" })];
    const result = resolveNavigationRoute(
      {
        source: "polyline",
        polyline: sampleGeometry,
        title: "Alternative · 12.4 km",
        waypoints,
      },
      null,
    );
    expect(result.title).toBe("Alternative · 12.4 km");
    expect(result.waypoints).toBe(waypoints);
  });

  it("resolves the trip-day branch from the active trip in the store", () => {
    const trip = makeTrip();
    const result = resolveNavigationRoute(
      { source: "trip-day", tripId: "trip-1", dayNumber: 1 },
      trip,
    );
    expect(result.polyline).toBe(trip.days[0]?.route_geometry);
    expect(result.title).toBe("Day One");
    expect(result.waypoints).toBe(trip.days[0]?.waypoints);
  });

  it("falls back to a 'Day N' title when the trip day has no title", () => {
    const trip = makeTrip();
    const firstDay = trip.days[0];
    if (!firstDay) throw new Error("expected a trip day");
    firstDay.title = null;
    const result = resolveNavigationRoute(
      { source: "trip-day", tripId: "trip-1", dayNumber: 1 },
      trip,
    );
    expect(result.title).toBe("Day 1");
  });

  it("returns an empty geometry when the trip in the store has rotated", () => {
    // Rider opened a different trip in the meantime — the screen must
    // fall through to its empty state instead of rendering a stale
    // route. The polyline guard in NavigationScreen reads `polyline.length < 2`.
    const result = resolveNavigationRoute(
      { source: "trip-day", tripId: "trip-1", dayNumber: 1 },
      makeTrip({ id: "trip-2" }),
    );
    expect(result.polyline).toEqual([]);
    expect(result.title).toBe("Day 1");
    expect(result.waypoints).toEqual([]);
  });

  it("returns an empty geometry when no trip is loaded yet", () => {
    const result = resolveNavigationRoute(
      { source: "trip-day", tripId: "trip-1", dayNumber: 1 },
      null,
    );
    expect(result.polyline).toEqual([]);
  });

  it("returns an empty geometry when the day number does not exist on the trip", () => {
    const result = resolveNavigationRoute(
      { source: "trip-day", tripId: "trip-1", dayNumber: 99 },
      makeTrip(),
    );
    expect(result.polyline).toEqual([]);
    expect(result.title).toBe("Day 99");
  });
});
