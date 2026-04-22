import { describe, expect, it } from "vitest";
import {
  buildTripClosureRoutes,
  countClosuresBySeverity,
  previewDateForMonth,
  type PlannerClosure,
} from "../closures-summary";
import type { Trip } from "../types";

function closure(
  overrides: Partial<PlannerClosure> & { id: string },
): PlannerClosure {
  const { id, ...rest } = overrides;
  return {
    id,
    title: "Bridge resurfacing",
    reason: "roadworks",
    severity: "partial",
    geometry: [
      { lat: 46.53, lng: 10.45 },
      { lat: 46.54, lng: 10.46 },
    ],
    detour: null,
    country_code: "IT",
    region: "South Tyrol",
    starts_at: "2026-07-01T00:00:00Z",
    ends_at: "2026-07-18T00:00:00Z",
    notes: null,
    source: "operator",
    created_by: null,
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    ...rest,
  };
}

describe("previewDateForMonth", () => {
  it("pins the preview to the middle of the selected UTC month", () => {
    expect(
      previewDateForMonth(7, new Date("2026-04-22T09:00:00Z")).toISOString(),
    ).toBe("2026-07-15T12:00:00.000Z");
  });
});

describe("countClosuresBySeverity", () => {
  it("tallies all severities and the overall total", () => {
    expect(
      countClosuresBySeverity([
        closure({ id: "a", severity: "full" }),
        closure({ id: "b", severity: "partial" }),
        closure({ id: "c", severity: "partial" }),
        closure({ id: "d", severity: "advisory" }),
      ]),
    ).toEqual({
      full: 1,
      partial: 2,
      advisory: 1,
      total: 4,
    });
  });
});

describe("buildTripClosureRoutes", () => {
  it("extracts one route-check payload per trip day that has geometry", () => {
    const trip: Trip = {
      id: "trip-1",
      name: "Dolomites",
      status: "planned",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      parameters: {
        days: 2,
        dailyKmTarget: 250,
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
          title: "Passo Sella",
          waypoints: [],
          distanceKm: 210,
          durationMinutes: 320,
          elevationGain: 2100,
          avgQuality: 4.2,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [11.76, 46.51],
              [11.78, 46.52],
              [11.8, 46.53],
            ],
          },
        },
        {
          dayNumber: 2,
          title: "No geometry yet",
          waypoints: [],
          distanceKm: 190,
          durationMinutes: 290,
          elevationGain: 1800,
          avgQuality: 3.9,
        },
      ],
    };

    expect(buildTripClosureRoutes(trip)).toEqual([
      {
        id: "day-1",
        label: "Day 1 · Passo Sella",
        points: [
          { lng: 11.76, lat: 46.51 },
          { lng: 11.78, lat: 46.52 },
          { lng: 11.8, lat: 46.53 },
        ],
      },
    ]);
  });
});
