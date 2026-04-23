import type { Trip } from "@/lib/types";
import {
  buildTripPlannerRouteCollection,
  buildTripPlannerWaypointCollection,
  getTripPlannerBounds,
} from "../trip-planner-map";

function trip(overrides?: Partial<Trip>): Trip {
  return {
    id: "trip-1",
    name: "Planner test trip",
    status: "draft",
    createdAt: "2026-04-01T09:00:00Z",
    updatedAt: "2026-04-14T09:00:00Z",
    parameters: {
      days: 2,
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
        title: "Day one",
        distanceKm: 120,
        durationMinutes: 180,
        elevationGain: 800,
        avgQuality: 4.1,
        waypoints: [
          {
            id: "start-1",
            name: "Start",
            location: { lng: 14.41, lat: 50.08 },
            type: "start",
          },
          {
            id: "via-1",
            name: "Viewpoint",
            location: { lng: 14.52, lat: 50.13 },
            type: "via",
          },
          {
            id: "end-1",
            name: "End",
            location: { lng: 14.61, lat: 50.19 },
            type: "end",
          },
        ],
      },
      {
        dayNumber: 2,
        title: "Day two",
        distanceKm: 98,
        durationMinutes: 150,
        elevationGain: 620,
        avgQuality: 3.8,
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [14.7, 50.25],
            [14.82, 50.3],
            [14.95, 50.36],
          ],
        },
        waypoints: [
          {
            id: "start-2",
            name: "Louny",
            location: { lng: 14.71, lat: 50.24 },
            type: "start",
          },
          {
            id: "end-2",
            name: "Decin",
            location: { lng: 14.98, lat: 50.37 },
            type: "end",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("buildTripPlannerRouteCollection", () => {
  it("falls back to ordered waypoints when a day lacks route geometry", () => {
    const collection = buildTripPlannerRouteCollection(trip());

    expect(collection.features).toHaveLength(2);
    expect(collection.features[0]).toMatchObject({
      properties: {
        dayNumber: 1,
        title: "Day one",
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [14.41, 50.08],
          [14.52, 50.13],
          [14.61, 50.19],
        ],
      },
    });
  });

  it("prefers persisted route geometry when present", () => {
    const collection = buildTripPlannerRouteCollection(trip());

    expect(collection.features[1]).toMatchObject({
      properties: {
        dayNumber: 2,
        title: "Day two",
      },
      geometry: {
        coordinates: [
          [14.7, 50.25],
          [14.82, 50.3],
          [14.95, 50.36],
        ],
      },
    });
  });

  it("falls back to waypoints when route geometry does not contain two valid points", () => {
    const collection = buildTripPlannerRouteCollection(
      trip({
        days: [
          {
            dayNumber: 1,
            title: "Broken geometry",
            distanceKm: 120,
            durationMinutes: 180,
            elevationGain: 800,
            avgQuality: 4.1,
            routeGeometry: {
              type: "LineString",
              coordinates: [
                [14.7, 50.25],
                [14.8] as unknown as [number, number],
              ],
            },
            waypoints: [
              {
                id: "start-1",
                name: "Start",
                location: { lng: 14.41, lat: 50.08 },
                type: "start",
              },
              {
                id: "end-1",
                name: "End",
                location: { lng: 14.61, lat: 50.19 },
                type: "end",
              },
            ],
          },
        ],
      }),
    );

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry.coordinates).toEqual([
      [14.41, 50.08],
      [14.61, 50.19],
    ]);
  });

  it("skips days that do not have enough points to draw a line", () => {
    const collection = buildTripPlannerRouteCollection(
      trip({
        days: [
          {
            dayNumber: 1,
            title: "Only one stop",
            distanceKm: 20,
            durationMinutes: 40,
            elevationGain: 90,
            avgQuality: 4,
            waypoints: [
              {
                id: "solo",
                name: "Solo",
                location: { lng: 14.41, lat: 50.08 },
                type: "start",
              },
            ],
          },
        ],
      }),
    );

    expect(collection.features).toHaveLength(0);
  });
});

describe("buildTripPlannerWaypointCollection", () => {
  it("emits each waypoint with day and waypoint metadata", () => {
    const collection = buildTripPlannerWaypointCollection(trip());

    expect(collection.features).toHaveLength(5);
    expect(collection.features[0]).toMatchObject({
      properties: {
        dayNumber: 1,
        waypointType: "start",
        label: "Start",
      },
      geometry: {
        type: "Point",
        coordinates: [14.41, 50.08],
      },
    });
    expect(collection.features[4]).toMatchObject({
      properties: {
        dayNumber: 2,
        waypointType: "end",
        label: "Decin",
      },
    });
  });

  it("falls back to a stable label when waypoint type is an empty string", () => {
    const collection = buildTripPlannerWaypointCollection(
      trip({
        days: [
          {
            dayNumber: 1,
            title: "Day one",
            distanceKm: 10,
            durationMinutes: 20,
            elevationGain: 50,
            avgQuality: 4,
            waypoints: [
              {
                id: "unknown-1",
                location: { lng: 14.41, lat: 50.08 },
                type: "" as "" & "start",
              },
            ],
          },
        ],
      }),
    );

    expect(collection.features[0]?.properties.label).toBe("Waypoint");
  });
});

describe("getTripPlannerBounds", () => {
  it("returns the union of route and waypoint coordinates", () => {
    expect(getTripPlannerBounds(trip())).toEqual([14.41, 50.08, 14.98, 50.37]);
  });

  it("returns null when the trip has no routeable points", () => {
    expect(
      getTripPlannerBounds(
        trip({
          days: [
            {
              dayNumber: 1,
              distanceKm: 0,
              durationMinutes: 0,
              elevationGain: 0,
              avgQuality: 0,
              waypoints: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
