import type * as GeoJSON from "geojson";
import type { RoutePreviewSegment, Trip, TripDay } from "@/lib/types";
import type { RouteSegment } from "@/lib/planner/types";
import {
  buildPlannerQualityRouteCollection,
  buildPlannerRouteOverviewCollection,
  buildTripPlannerSegmentHighlightCollection,
  buildTripPlannerWaypointCollection,
  deriveDayQualitySegments,
  findPlannerQualitySegment,
  getTripPlannerBounds,
  plannerRouteLineColor,
  plannerSegmentBounds,
} from "../trip-planner-map";

function trip(overrides?: Partial<Trip>): Trip {
  return {
    id: "trip-1",
    name: "Planner test trip",
    status: "draft",
    num_days: 2,
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

describe("buildPlannerQualityRouteCollection", () => {
  it("falls back to ordered waypoints when a day lacks route geometry", () => {
    const collection = buildPlannerQualityRouteCollection(trip());

    const day1 = collection.features.filter(
      (f) => f.properties.dayNumber === 1,
    );
    expect(day1.length).toBeGreaterThanOrEqual(1);
    // Segments cover the waypoint line end-to-end.
    expect(day1[0]!.geometry.coordinates[0]).toEqual([14.41, 50.08]);
    const last = day1[day1.length - 1]!;
    expect(
      last.geometry.coordinates[last.geometry.coordinates.length - 1],
    ).toEqual([14.61, 50.19]);
  });

  it("prefers persisted route geometry when present", () => {
    const collection = buildPlannerQualityRouteCollection(trip());

    const day2 = collection.features.filter(
      (f) => f.properties.dayNumber === 2,
    );
    expect(day2.length).toBeGreaterThanOrEqual(1);
    expect(day2[0]!.geometry.coordinates[0]).toEqual([14.7, 50.25]);
    const last = day2[day2.length - 1]!;
    expect(
      last.geometry.coordinates[last.geometry.coordinates.length - 1],
    ).toEqual([14.95, 50.36]);
  });

  it("stamps quality properties onto every segment feature", () => {
    const collection = buildPlannerQualityRouteCollection(trip());

    expect(collection.features.length).toBeGreaterThan(0);
    for (const feature of collection.features) {
      expect(feature.properties.segmentId).toMatch(/^d\d+-s\d+$/);
      expect(["good", "fair", "rough", "no_data"]).toContain(
        feature.properties.band,
      );
      expect(typeof feature.properties.surface).toBe("string");
      expect(feature.properties.passes).toBeGreaterThanOrEqual(0);
      if (feature.properties.band === "no_data") {
        expect(feature.properties.score).toBeNull();
      } else {
        expect(feature.properties.score).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic for the same trip geometry", () => {
    expect(buildPlannerQualityRouteCollection(trip())).toEqual(
      buildPlannerQualityRouteCollection(trip()),
    );
  });

  it("falls back to waypoints when route geometry does not contain two valid points", () => {
    const collection = buildPlannerQualityRouteCollection(
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

    expect(collection.features.length).toBeGreaterThanOrEqual(1);
    expect(collection.features[0]?.geometry.coordinates[0]).toEqual([
      14.41, 50.08,
    ]);
  });

  it("skips days that do not have enough points to draw a line", () => {
    const collection = buildPlannerQualityRouteCollection(
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

  it("marks segments of the selected day and dims the rest", () => {
    const collection = buildPlannerQualityRouteCollection(trip(), 1);

    const day1 = collection.features.filter(
      (f) => f.properties.dayNumber === 1,
    );
    const day2 = collection.features.filter(
      (f) => f.properties.dayNumber === 2,
    );
    expect(day1.every((f) => f.properties.selected)).toBe(true);
    expect(day2.every((f) => !f.properties.selected)).toBe(true);
  });

  it("marks every day as selected when no selectedDayNumber is provided", () => {
    const collection = buildPlannerQualityRouteCollection(trip());
    expect(collection.features.every((f) => f.properties.selected)).toBe(true);
  });

  it("emits only the selected day when focusSelectedDay is true", () => {
    const collection = buildPlannerQualityRouteCollection(trip(), 2, true);

    expect(collection.features.length).toBeGreaterThanOrEqual(1);
    expect(collection.features.every((f) => f.properties.dayNumber === 2)).toBe(
      true,
    );
    expect(collection.features.every((f) => f.properties.selected)).toBe(true);
  });

  it("emits all days when focusSelectedDay is false", () => {
    const collection = buildPlannerQualityRouteCollection(trip(), 1, false);
    const dayNumbers = new Set(
      collection.features.map((f) => f.properties.dayNumber),
    );
    expect(dayNumbers).toEqual(new Set([1, 2]));
  });
});

describe("buildPlannerRouteOverviewCollection", () => {
  it("keeps each day as one continuous low-zoom feature", () => {
    const sourceTrip = trip();
    const collection = buildPlannerRouteOverviewCollection(sourceTrip);

    expect(collection.features).toHaveLength(2);
    expect(collection.features[0]?.geometry.coordinates).toEqual([
      [14.41, 50.08],
      [14.52, 50.13],
      [14.61, 50.19],
    ]);
    expect(collection.features[1]?.geometry.coordinates).toEqual(
      sourceTrip.days[1]?.routeGeometry?.coordinates,
    );
    expect(
      collection.features.every((feature) => feature.properties.selected),
    ).toBe(true);
  });

  it("honours the focused-day filter", () => {
    const collection = buildPlannerRouteOverviewCollection(trip(), 2, true);

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties).toEqual({
      dayNumber: 2,
      selected: true,
    });
  });
});

describe("deriveDayQualitySegments (#862)", () => {
  const routedGeometry: GeoJSON.LineString = {
    type: "LineString",
    coordinates: [
      [14.2, 49.4],
      [14.6, 49.42],
      [15.0, 49.41],
    ],
  };
  const stored: RouteSegment[] = [
    {
      id: "d1-s0",
      geometry: {
        type: "LineString",
        coordinates: [
          [14.2, 49.4],
          [15.0, 49.41],
        ],
      },
      band: "good",
      surface: "asphalt",
      score: 4.2,
      passes: 12,
      lengthKm: 30,
      dayNumber: 1,
    },
  ];
  function dayWith(overrides: Partial<TripDay>): TripDay {
    return {
      dayNumber: 1,
      waypoints: [
        { id: "s", type: "start", location: { lng: 14.2, lat: 49.4 } },
        { id: "e", type: "end", location: { lng: 15.0, lat: 49.41 } },
      ],
      routeGeometry: routedGeometry,
      distanceKm: 30,
      durationMinutes: 40,
      elevationGain: 100,
      avgQuality: 4,
      ...overrides,
    };
  }

  it("returns stored quality while the day still has its routed line", () => {
    expect(deriveDayQualitySegments(dayWith({ qualitySegments: stored }))).toBe(
      stored,
    );
  });

  it("falls back to the no_data baseline when no quality is stored", () => {
    const segments = deriveDayQualitySegments(dayWith({}));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.band === "no_data")).toBe(true);
  });

  it("ignores stored quality once the route geometry is gone", () => {
    // updatePlannerDayRoute drops routeGeometry when a day becomes unroutable;
    // stored quality must not keep drawing a line the route no longer has.
    const day = dayWith({
      qualitySegments: stored,
      routeGeometry: undefined,
      waypoints: [
        { id: "s", type: "start", location: { lng: 14.2, lat: 49.4 } },
      ],
    });
    expect(deriveDayQualitySegments(day)).toEqual([]);
  });
});

describe("findPlannerQualitySegment / plannerSegmentBounds", () => {
  it("resolves a segment id from the collection back to its segment", () => {
    const collection = buildPlannerQualityRouteCollection(trip());
    const id = collection.features[0]!.properties.segmentId;

    const segment = findPlannerQualitySegment(trip(), id);
    expect(segment).not.toBeNull();
    expect(segment!.id).toBe(id);
    expect(segment!.geometry).toEqual(collection.features[0]!.geometry);
  });

  it("returns null for unknown ids and null input", () => {
    expect(findPlannerQualitySegment(trip(), "d9-s9")).toBeNull();
    expect(findPlannerQualitySegment(null, "d1-s0")).toBeNull();
    expect(findPlannerQualitySegment(trip(), null)).toBeNull();
  });

  it("resolves a run id to the whole run's combined geometry (#862)", () => {
    const roughSeg = (
      id: string,
      coords: [number, number][],
    ): RouteSegment => ({
      id,
      geometry: { type: "LineString", coordinates: coords },
      band: "rough",
      surface: "gravel",
      score: 2,
      passes: 3,
      lengthKm: 5,
      dayNumber: 1,
    });
    const runTrip = trip({
      num_days: 1,
      days: [
        {
          dayNumber: 1,
          title: "Rough run",
          distanceKm: 10,
          durationMinutes: 20,
          elevationGain: 0,
          avgQuality: 2,
          waypoints: [],
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
          },
          qualitySegments: [
            roughSeg("d1-s0", [
              [0, 0],
              [1, 0],
            ]),
            roughSeg("d1-s1", [
              [1, 0],
              [2, 0],
            ]),
          ],
        },
      ],
    });

    // The coalesced run spans both spans: combined geometry + summed length,
    // so a flagged-card reroute/preview covers the whole run.
    const run = findPlannerQualitySegment(runTrip, "run:d1-s0:d1-s1")!;
    expect(run.lengthKm).toBe(10);
    expect(run.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    // A fine segment id still resolves to just that span (map clicks).
    const fine = findPlannerQualitySegment(runTrip, "d1-s0")!;
    expect(fine.lengthKm).toBe(5);
    expect(fine.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("resolves a run id that spans a day boundary (whole-route inspect)", () => {
    const seg = (
      id: string,
      dayNumber: number,
      coords: [number, number][],
    ): RouteSegment => ({
      id,
      geometry: { type: "LineString", coordinates: coords },
      band: "rough",
      surface: "gravel",
      score: 2,
      passes: 3,
      lengthKm: 5,
      dayNumber,
    });
    const crossDayTrip = trip({
      num_days: 2,
      days: [
        {
          dayNumber: 1,
          title: "Day 1",
          distanceKm: 5,
          durationMinutes: 10,
          elevationGain: 0,
          avgQuality: 2,
          waypoints: [],
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
            ],
          },
          qualitySegments: [
            seg("d1-s0", 1, [
              [0, 0],
              [1, 0],
            ]),
          ],
        },
        {
          dayNumber: 2,
          title: "Day 2",
          distanceKm: 5,
          durationMinutes: 10,
          elevationGain: 0,
          avgQuality: 2,
          waypoints: [],
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [1, 0],
              [2, 0],
            ],
          },
          qualitySegments: [
            seg("d2-s0", 2, [
              [1, 0],
              [2, 0],
            ]),
          ],
        },
      ],
    });

    // The whole-route inspect view coalesces both days into one run; the run id
    // spans the boundary and must resolve against all days' segments, not fail.
    const run = findPlannerQualitySegment(crossDayTrip, "run:d1-s0:d2-s0")!;
    expect(run).not.toBeNull();
    expect(run.lengthKm).toBe(10);
    expect(run.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("computes a bounding box that contains the segment", () => {
    const segment = findPlannerQualitySegment(
      trip(),
      buildPlannerQualityRouteCollection(trip()).features[0]!.properties
        .segmentId,
    )!;
    const bounds = plannerSegmentBounds(segment)!;
    expect(bounds[0]).toBeLessThanOrEqual(bounds[2]);
    expect(bounds[1]).toBeLessThanOrEqual(bounds[3]);
    for (const [lng, lat] of segment.geometry.coordinates as [
      number,
      number,
    ][]) {
      expect(lng).toBeGreaterThanOrEqual(bounds[0]);
      expect(lng).toBeLessThanOrEqual(bounds[2]);
      expect(lat).toBeGreaterThanOrEqual(bounds[1]);
      expect(lat).toBeLessThanOrEqual(bounds[3]);
    }
  });
});

describe("plannerRouteLineColor", () => {
  const surfaceColors = { asphalt: "#111111", unknown: "#222222" };

  it("colors by band in quality mode", () => {
    const expression = plannerRouteLineColor("quality", surfaceColors);
    expect(expression[0]).toBe("match");
    expect(expression[1]).toEqual(["get", "band"]);
    expect(expression).toContain("good");
  });

  it("colors by surface in surface mode", () => {
    const expression = plannerRouteLineColor("surface", surfaceColors);
    expect(expression[0]).toBe("match");
    expect(expression[1]).toEqual(["get", "surface"]);
    expect(expression).toContain("#111111");
  });
});

describe("buildTripPlannerWaypointCollection", () => {
  it("emits each waypoint with day and waypoint metadata", () => {
    const collection = buildTripPlannerWaypointCollection(trip());

    expect(collection.features).toHaveLength(5);
    expect(collection.features[0]).toMatchObject({
      properties: {
        dayNumber: 1,
        waypointId: "start-1",
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
        waypointId: "end-2",
        waypointType: "end",
        label: "Decin",
      },
    });
  });

  it("emits only the selected day's markers in focus mode", () => {
    const all = buildTripPlannerWaypointCollection(trip());
    const focused = buildTripPlannerWaypointCollection(trip(), 2, true);
    // Focus mode must drop other days' markers (they're also the drag source),
    // so the map is truly isolated to the selected day.
    expect(focused.features.length).toBeGreaterThan(0);
    expect(focused.features.length).toBeLessThan(all.features.length);
    expect(focused.features.every((f) => f.properties.dayNumber === 2)).toBe(
      true,
    );
  });

  it("suppresses a linked day's start so the shared overnight stop renders once", () => {
    // Day 1 ends at the overnight stop; day 2 has startLinked: true and its
    // start waypoint is at the same physical point. The builder must emit the
    // overnight stop exactly once (as day 1's end) and omit day 2's start.
    const overnightLng = 14.61;
    const overnightLat = 50.19;
    const overnightTrip = trip({
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
              id: "end-1",
              name: "Overnight stop",
              location: { lng: overnightLng, lat: overnightLat },
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
          startLinked: true,
          waypoints: [
            {
              id: "start-2",
              name: "Overnight stop",
              location: { lng: overnightLng, lat: overnightLat },
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
    });

    const collection = buildTripPlannerWaypointCollection(overnightTrip);

    // Naive total: 4 waypoints across 2 days. Deduped: 3 (linked start omitted).
    expect(collection.features).toHaveLength(3);

    // The overnight point must appear exactly once — as day 1's end.
    const overnightFeatures = collection.features.filter(
      (f) =>
        f.geometry.coordinates[0] === overnightLng &&
        f.geometry.coordinates[1] === overnightLat,
    );
    expect(overnightFeatures).toHaveLength(1);
    expect(overnightFeatures[0]?.properties).toMatchObject({
      dayNumber: 1,
      waypointId: "end-1",
      waypointType: "end",
    });

    // Day 2's linked start must be absent.
    const linkedStart = collection.features.find(
      (f) => f.properties.waypointId === "start-2",
    );
    expect(linkedStart).toBeUndefined();
  });

  it("renders a focused linked day's start (predecessor isn't drawn in focus mode)", () => {
    const overnightTrip = trip({
      days: [
        {
          dayNumber: 1,
          title: "Day one",
          distanceKm: 120,
          durationMinutes: 180,
          elevationGain: 800,
          avgQuality: 4,
          waypoints: [
            {
              id: "start-1",
              name: "Start",
              location: { lng: 14.41, lat: 50.08 },
              type: "start",
            },
            {
              id: "end-1",
              name: "Overnight",
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
          startLinked: true,
          waypoints: [
            {
              id: "start-2",
              name: "Overnight",
              location: { lng: 14.61, lat: 50.19 },
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
    });

    // Non-focus: the linked start is suppressed (drawn as day 1's end).
    const all = buildTripPlannerWaypointCollection(overnightTrip);
    expect(
      all.features.find((f) => f.properties.waypointId === "start-2"),
    ).toBeUndefined();

    // Focus on day 2: day 1 isn't drawn, so day 2's linked start MUST render —
    // otherwise the focused leg has no overnight/start marker at all.
    const focused = buildTripPlannerWaypointCollection(overnightTrip, 2, true);
    expect(
      focused.features.find((f) => f.properties.waypointId === "start-2"),
    ).toBeDefined();
    expect(focused.features.every((f) => f.properties.dayNumber === 2)).toBe(
      true,
    );
  });

  it("does not suppress a non-linked day's start", () => {
    // When startLinked is false/undefined, the start waypoint must still render.
    const collection = buildTripPlannerWaypointCollection(trip());
    const day2Start = collection.features.find(
      (f) => f.properties.waypointId === "start-2",
    );
    expect(day2Start).toBeDefined();
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
