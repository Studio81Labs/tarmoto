import { describe, expect, it } from "vitest";
import {
  parseTripSnapshot,
  tripRouteLines,
  tripSummary,
} from "@/lib/trip-share";
import type { Trip } from "@/lib/types";

const validTrip: Trip = {
  id: "trip-1",
  name: "Pyrenees Loop",
  status: "planned",
  num_days: 2,
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
      waypoints: [
        {
          id: "w-1",
          type: "start",
          location: { lat: 43.0, lng: 1.5 },
        },
        {
          id: "w-2",
          type: "end",
          location: { lat: 43.5, lng: 1.8 },
        },
      ],
      routeGeometry: {
        type: "LineString",
        coordinates: [
          [1.5, 43.0],
          [1.6, 43.2],
          [1.8, 43.5],
        ],
      },
      distanceKm: 120,
      durationMinutes: 180,
      elevationGain: 800,
      avgQuality: 4.1,
    },
    {
      dayNumber: 2,
      waypoints: [
        {
          id: "w-3",
          type: "start",
          location: { lat: 43.5, lng: 1.8 },
        },
        {
          id: "w-4",
          type: "end",
          location: { lat: 44.0, lng: 2.2 },
        },
      ],
      distanceKm: 140,
      durationMinutes: 210,
      elevationGain: 900,
      avgQuality: 3.9,
    },
  ],
  createdAt: "2026-04-20T10:00:00.000Z",
  updatedAt: "2026-04-20T10:00:00.000Z",
};

describe("parseTripSnapshot", () => {
  it("accepts a valid Trip shape", () => {
    const parsed = parseTripSnapshot(
      validTrip as unknown as Record<string, unknown>,
    );
    expect(parsed?.name).toBe("Pyrenees Loop");
    expect(parsed?.days).toHaveLength(2);
  });

  it("rejects snapshots without a days array", () => {
    expect(parseTripSnapshot({ id: "trip-1" })).toBeNull();
  });

  it("rejects days whose waypoints lack numeric lat/lng", () => {
    const bad = {
      days: [{ waypoints: [{ location: { lat: "43.0", lng: "1.5" } }] }],
    };
    expect(parseTripSnapshot(bad)).toBeNull();
  });

  it("rejects days whose routeGeometry has non-pair coordinates", () => {
    const bad = {
      days: [
        {
          waypoints: [
            {
              id: "w-1",
              type: "start",
              location: { lat: 43.0, lng: 1.5 },
            },
          ],
          routeGeometry: {
            type: "LineString",
            // Flat numbers instead of [lng, lat] pairs — would crash
            // `tripRouteLines`'s destructure without the guard.
            coordinates: [1, 2, 3],
          },
        },
      ],
    };
    expect(parseTripSnapshot(bad)).toBeNull();
  });

  it("accepts days whose routeGeometry is absent or has empty coordinates", () => {
    const okNoGeometry = {
      days: [
        {
          waypoints: [
            {
              id: "w-1",
              type: "start",
              location: { lat: 43.0, lng: 1.5 },
            },
          ],
        },
      ],
    };
    expect(parseTripSnapshot(okNoGeometry)).not.toBeNull();
  });
});

describe("tripRouteLines", () => {
  it("keeps one polyline per day, preferring routeGeometry over waypoints", () => {
    const lines = tripRouteLines(validTrip);
    // Day 1 has 3 geometry coords, day 2 has only waypoints (2 coords) —
    // each stays its own line so the preview doesn't connect them.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(3);
    expect(lines[1]).toHaveLength(2);
    // First point comes from day-1 routeGeometry (lng,lat → lat,lng).
    expect(lines[0]?.[0]).toEqual({ lat: 43.0, lng: 1.5 });
  });

  it("skips non-finite coordinates in routeGeometry", () => {
    const baseDay = validTrip.days[0];
    if (!baseDay) throw new Error("expected a base day");
    const tripWithBad: Trip = {
      ...validTrip,
      days: [
        {
          ...baseDay,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [1.5, 43.0],
              [Number.NaN, 43.2],
              [1.8, 43.5],
            ],
          },
        },
      ],
    };
    const lines = tripRouteLines(tripWithBad);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2);
  });

  it("skips non-pair entries in routeGeometry without throwing", () => {
    // Bypasses `parseTripSnapshot` to mirror callers that hand in a trip
    // directly (demo trips, imports): the splitter must not destructure
    // a scalar as `[lng, lat]`.
    const tripWithScalars = {
      ...validTrip,
      days: [
        {
          ...validTrip.days[0],
          routeGeometry: {
            type: "LineString",
            coordinates: [[1.5, 43.0], 1, null, [1.8, 43.5]] as unknown as [
              number,
              number,
            ][],
          },
        },
      ],
    } as Trip;
    expect(() => tripRouteLines(tripWithScalars)).not.toThrow();
    expect(tripRouteLines(tripWithScalars)[0]).toHaveLength(2);
  });
});

describe("tripSummary", () => {
  it("aggregates distance, duration, and waypoint counts across days", () => {
    const summary = tripSummary(validTrip);
    expect(summary).toEqual({
      totalDistanceKm: 260,
      totalDurationMin: 390,
      dayCount: 2,
      waypointCount: 4,
    });
  });
});
