import { pointsDistanceKm } from "../gpx-kml-import";
import { rebuildPlannerDay } from "../trip-planner-builder";
import type { TripDay, TripParameters } from "../types";

const BASE_PARAMETERS: TripParameters = {
  days: 1,
  dailyKmTarget: 250,
  roadPreference: "mixed",
  surfacePreference: ["asphalt"],
  avoidHighways: true,
  avoidTolls: false,
  avoidUnpaved: true,
  minQuality: 3,
};

function buildDay(): TripDay {
  return {
    dayNumber: 1,
    title: "Day 1",
    distanceKm: 0,
    durationMinutes: 0,
    elevationGain: 0,
    avgQuality: 0,
    segments: [],
    waypoints: [
      {
        id: "start",
        name: "Start",
        location: { lng: 14.41, lat: 50.08 },
        type: "start",
      },
      {
        id: "end",
        name: "End",
        location: { lng: 14.414, lat: 50.0815 },
        type: "end",
      },
    ],
  };
}

describe("rebuildPlannerDay", () => {
  it("keeps direct preview legs on the straight anchor line", () => {
    const rebuilt = rebuildPlannerDay(buildDay(), {
      ...BASE_PARAMETERS,
      roadPreference: "direct",
    });

    expect(rebuilt.routeGeometry?.coordinates).toEqual([
      [14.41, 50.08],
      [14.414, 50.0815],
    ]);
  });

  it("does not add kilometer-scale detours to short preview legs", () => {
    const rebuilt = rebuildPlannerDay(buildDay(), BASE_PARAMETERS);
    const straightDistance = pointsDistanceKm([
      [14.41, 50.08],
      [14.414, 50.0815],
    ]);

    expect(rebuilt.routeGeometry?.coordinates).toHaveLength(5);
    expect(rebuilt.distanceKm).toBeLessThan(straightDistance * 1.6);
  });

  it("keeps generated preview metadata valid when a segment seed would be negative", () => {
    const rebuilt = rebuildPlannerDay(
      {
        dayNumber: 1,
        title: "Seed regression",
        distanceKm: 0,
        durationMinutes: 0,
        elevationGain: 0,
        avgQuality: 0,
        segments: [],
        waypoints: [
          {
            id: "start",
            name: "Start",
            location: { lng: 19.70022407454256, lat: 45.51632164194439 },
            type: "start",
          },
          {
            id: "via",
            name: "Via",
            location: { lng: 19.80393561867295, lat: 45.647771249118705 },
            type: "via",
          },
          {
            id: "end",
            name: "End",
            location: { lng: 19.739153515865382, lat: 45.71547276223144 },
            type: "end",
          },
        ],
      },
      {
        ...BASE_PARAMETERS,
        surfacePreference: [],
        avoidUnpaved: false,
      },
    );

    expect(rebuilt.segments?.length).toBeGreaterThan(0);
    expect(
      rebuilt.segments?.every((segment) =>
        ["asphalt", "concrete", "gravel"].includes(segment.surfaceType),
      ),
    ).toBe(true);
    expect(
      rebuilt.segments?.every((segment) =>
        segment.elevationProfile.every((value) => Number.isFinite(value)),
      ),
    ).toBe(true);
  });
});
