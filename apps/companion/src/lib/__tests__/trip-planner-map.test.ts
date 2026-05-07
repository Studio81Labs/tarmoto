import type { RoutePreviewSegment, Trip } from "@/lib/types";
import {
  buildTripPlannerRouteCollection,
  buildTripPlannerSegmentHighlightCollection,
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

describe("buildTripPlannerSegmentHighlightCollection", () => {
  function segment(
    overrides: Partial<RoutePreviewSegment>,
  ): RoutePreviewSegment {
    return {
      id: "seg-default",
      name: "Segment",
      dayNumber: 2,
      orderInDay: 0,
      distanceKm: 10,
      qualityScore: 4,
      qualityTier: "good",
      surfaceType: "asphalt",
      curvinessScore: 50,
      elevationProfile: [],
      photos: [],
      activeHazards: [],
      ...overrides,
    };
  }

  // Five vertices stepping due east along the equator: each leg has the
  // same haversine length, so a 50/50 segment split lands exactly on the
  // middle vertex and the assertions stay independent of haversine drift.
  function evenlySpacedTrip(): Trip {
    return trip({
      days: [
        {
          dayNumber: 1,
          title: "Empty day",
          distanceKm: 0,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 0,
          waypoints: [],
          segments: [],
        },
        {
          dayNumber: 2,
          title: "Day two",
          distanceKm: 12,
          durationMinutes: 30,
          elevationGain: 90,
          avgQuality: 4,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
              [4, 0],
            ],
          },
          waypoints: [
            {
              id: "start-2",
              name: "Start",
              location: { lng: 0, lat: 0 },
              type: "start",
            },
            {
              id: "end-2",
              name: "End",
              location: { lng: 4, lat: 0 },
              type: "end",
            },
          ],
          segments: [
            segment({ id: "seg-2-1", orderInDay: 0, distanceKm: 6 }),
            segment({ id: "seg-2-2", orderInDay: 1, distanceKm: 6 }),
          ],
        },
      ],
    });
  }

  it("returns an empty collection when no segment is focused", () => {
    expect(
      buildTripPlannerSegmentHighlightCollection(evenlySpacedTrip(), null)
        .features,
    ).toEqual([]);
  });

  it("returns an empty collection when the trip is null", () => {
    expect(
      buildTripPlannerSegmentHighlightCollection(null, "seg-2-1").features,
    ).toEqual([]);
  });

  it("returns an empty collection for an unknown segment id", () => {
    expect(
      buildTripPlannerSegmentHighlightCollection(
        evenlySpacedTrip(),
        "seg-missing",
      ).features,
    ).toEqual([]);
  });

  it("slices the day route into the chunk for the first segment", () => {
    const collection = buildTripPlannerSegmentHighlightCollection(
      evenlySpacedTrip(),
      "seg-2-1",
    );

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties).toEqual({
      segmentId: "seg-2-1",
      dayNumber: 2,
      orderInDay: 0,
    });
    expect(collection.features[0]?.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("slices the day route into the chunk for the last segment", () => {
    const collection = buildTripPlannerSegmentHighlightCollection(
      evenlySpacedTrip(),
      "seg-2-2",
    );

    expect(collection.features[0]?.geometry.coordinates).toEqual([
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
  });

  it("uses cumulative distance when polyline vertices are unevenly spaced", () => {
    // The first three legs are ~111 km each; the last leg jumps ~890 km.
    // An index-based midpoint would land at coords[2] (~22% of the
    // total km), highlighting the wrong stretch. The distance-based
    // slice should instead reach into the long final leg.
    const unevenTrip = trip({
      days: [
        {
          dayNumber: 1,
          title: "Uneven",
          distanceKm: 1110,
          durationMinutes: 600,
          elevationGain: 0,
          avgQuality: 4,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
              [2, 0],
              [10, 0],
            ],
          },
          waypoints: [
            { id: "start", location: { lng: 0, lat: 0 }, type: "start" },
            { id: "end", location: { lng: 10, lat: 0 }, type: "end" },
          ],
          segments: [
            segment({
              id: "uneven-a",
              dayNumber: 1,
              orderInDay: 0,
              distanceKm: 555,
            }),
            segment({
              id: "uneven-b",
              dayNumber: 1,
              orderInDay: 1,
              distanceKm: 555,
            }),
          ],
        },
      ],
    });

    const collection = buildTripPlannerSegmentHighlightCollection(
      unevenTrip,
      "uneven-a",
    );
    const coords = collection.features[0]?.geometry.coordinates ?? [];

    expect(coords[0]).toEqual([0, 0]);
    expect(coords).toContainEqual([1, 0]);
    expect(coords).toContainEqual([2, 0]);
    // The slice's terminal point sits well past coords[2]; with even legs
    // along the equator a 50% distance split lands near lng 5.
    const last = coords[coords.length - 1]!;
    expect(last[0]).toBeGreaterThan(4);
    expect(last[0]).toBeLessThan(6);
    expect(last[1]).toBeCloseTo(0, 9);
  });

  it("falls back to even fractions when segments lack a usable distance", () => {
    const noDistanceTrip = trip({
      days: [
        {
          dayNumber: 1,
          title: "No distance",
          distanceKm: 0,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 0,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
              [4, 0],
            ],
          },
          waypoints: [
            { id: "s", location: { lng: 0, lat: 0 }, type: "start" },
            { id: "e", location: { lng: 4, lat: 0 }, type: "end" },
          ],
          segments: [
            segment({ id: "fb-1", dayNumber: 1, orderInDay: 0, distanceKm: 0 }),
            segment({ id: "fb-2", dayNumber: 1, orderInDay: 1, distanceKm: 0 }),
          ],
        },
      ],
    });

    const collection = buildTripPlannerSegmentHighlightCollection(
      noDistanceTrip,
      "fb-2",
    );

    expect(collection.features[0]?.geometry.coordinates).toEqual([
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
  });

  it("falls back to the day waypoints line when route geometry is missing", () => {
    const trip = evenlySpacedTrip();
    const day = trip.days[1]!;
    delete (day as { routeGeometry?: unknown }).routeGeometry;

    const collection = buildTripPlannerSegmentHighlightCollection(
      trip,
      "seg-2-1",
    );

    expect(collection.features).toHaveLength(1);
    // With only two waypoints (start and end), the highlight degrades to a
    // half-of-the-straight-line slice — better than no feedback at all.
    const coords = collection.features[0]!.geometry.coordinates;
    expect(coords[0]).toEqual([0, 0]);
    expect(coords[coords.length - 1]![0]).toBeCloseTo(2, 9);
    expect(coords[coords.length - 1]![1]).toBeCloseTo(0, 9);
  });

  it("ignores days that have no segments", () => {
    const collection = buildTripPlannerSegmentHighlightCollection(
      evenlySpacedTrip(),
      "seg-1-anything",
    );
    expect(collection.features).toEqual([]);
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
