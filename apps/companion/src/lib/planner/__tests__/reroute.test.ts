import { describe, expect, it } from "vitest";
import type { TripDay, Waypoint } from "@/lib/types";
import {
  insertionAnchorForPoint,
  planRerouteAroundSegment,
  rerouteViaWaypoint,
} from "../reroute";
import { rerouteAroundConditionInTrip } from "../reroute";
import type { RouteSegment } from "../types";

/** Straight west→east route along 50°N with waypoints on the line. */
function day(): Pick<TripDay, "routeGeometry" | "waypoints"> {
  const waypoints: Waypoint[] = [
    {
      id: "start",
      name: "Start",
      location: { lng: 14.0, lat: 50 },
      type: "start",
    },
    {
      id: "mid-via",
      name: "Via",
      location: { lng: 14.5, lat: 50 },
      type: "via",
    },
    {
      id: "end",
      name: "Finish",
      location: { lng: 15.0, lat: 50 },
      type: "end",
    },
  ];
  return {
    waypoints,
    routeGeometry: {
      type: "LineString",
      coordinates: Array.from({ length: 11 }, (_, i) => [14 + i * 0.1, 50]),
    },
  };
}

function segment(coordinates: [number, number][]): RouteSegment {
  return {
    id: "d1-s1",
    geometry: { type: "LineString", coordinates },
    band: "rough",
    surface: "gravel",
    score: 1.9,
    passes: 4,
    lengthKm: 7,
    dayNumber: 1,
  };
}

describe("planRerouteAroundSegment", () => {
  it("offsets the via perpendicular to the flagged segment", () => {
    const plan = planRerouteAroundSegment(
      day(),
      segment([
        [14.1, 50],
        [14.2, 50],
      ]),
    );

    expect(plan).not.toBeNull();
    // Perpendicular to a west→east segment is due north/south: longitude
    // stays at the midpoint, latitude moves by the offset.
    expect(plan!.location.lng).toBeCloseTo(14.2, 5);
    expect(Math.abs(plan!.location.lat - 50)).toBeGreaterThan(0.005);
    expect(Math.abs(plan!.location.lat - 50)).toBeLessThan(0.05);
  });

  it("inserts before the first routing waypoint beyond the segment", () => {
    // Segment sits between start (14.0) and the via (14.5).
    const plan = planRerouteAroundSegment(
      day(),
      segment([
        [14.1, 50],
        [14.2, 50],
      ]),
    );
    expect(plan!.insertBeforeWaypointId).toBe("mid-via");
  });

  it("inserts before the finish when the segment is beyond every via", () => {
    const plan = planRerouteAroundSegment(
      day(),
      segment([
        [14.7, 50],
        [14.8, 50],
      ]),
    );
    expect(plan!.insertBeforeWaypointId).toBe("end");
  });

  it("returns null when the day has no routed geometry", () => {
    const bare = { ...day(), routeGeometry: undefined };
    expect(
      planRerouteAroundSegment(
        bare,
        segment([
          [14.1, 50],
          [14.2, 50],
        ]),
      ),
    ).toBeNull();
  });

  it("returns null for a zero-length segment", () => {
    expect(
      planRerouteAroundSegment(
        day(),
        segment([
          [14.2, 50],
          [14.2, 50],
        ]),
      ),
    ).toBeNull();
  });
});

describe("rerouteViaWaypoint", () => {
  it("builds a via waypoint at the planned location", () => {
    const plan = planRerouteAroundSegment(
      day(),
      segment([
        [14.1, 50],
        [14.2, 50],
      ]),
    )!;
    const waypoint = rerouteViaWaypoint(plan, "d1-s1");
    expect(waypoint.type).toBe("via");
    expect(waypoint.location).toEqual(plan.location);
    expect(waypoint.name).toBe("Reroute via");
    expect(waypoint.id).toContain("d1-s1");
  });
});

describe("rerouteAroundConditionInTrip (revision 7)", () => {
  const trip = {
    id: "t1",
    name: "Test",
    status: "draft",
    num_days: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    collaborators: [],
    parameters: {
      days: 1,
      dailyKmTarget: 250,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
      minQuality: 3,
    },
    days: [
      {
        dayNumber: 1,
        distanceKm: 50,
        durationMinutes: 60,
        elevationGain: 0,
        avgQuality: 4,
        segments: [],
        routeGeometry: {
          type: "LineString" as const,
          coordinates: [
            [15.0, 49.0],
            [15.1, 49.05],
            [15.2, 49.1],
            [15.3, 49.15],
            [15.4, 49.2],
          ],
        },
        waypoints: [
          {
            id: "s",
            name: "Start",
            type: "start" as const,
            location: { lng: 15.0, lat: 49.0 },
          },
          {
            id: "e",
            name: "End",
            type: "end" as const,
            location: { lng: 15.4, lat: 49.2 },
          },
        ],
      },
    ],
  };

  it("inserts an offset via before the finish for a closure line on the route", () => {
    const insert = vi.fn();
    const done = rerouteAroundConditionInTrip(
      trip as never,
      {
        id: "closure-1",
        location: { lng: 15.2, lat: 49.1 },
        line: [
          { lng: 15.15, lat: 49.075 },
          { lng: 15.25, lat: 49.125 },
        ],
      },
      insert,
    );
    expect(done).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    const [dayIndex, beforeId, via] = insert.mock.calls[0]!;
    expect(dayIndex).toBe(0);
    expect(beforeId).toBe("e");
    expect(via.type).toBe("via");
    expect(via.id).toContain("condition-closure-1");
    // The via lands offset from the condition, not on top of it.
    expect(
      Math.hypot(via.location.lng - 15.2, via.location.lat - 49.1),
    ).toBeGreaterThan(0.005);
  });

  it("picks the owning day from the WHOLE closure line, not its first vertex", () => {
    // Two-day trip: day 1 runs along 49°N near 15°E, day 2 along 50°N
    // near 16°E. The closure's FIRST vertex sits near day 1, but the
    // rest of the line crosses day 2's route much closer — the via must
    // land on day 2.
    const twoDayTrip = {
      ...trip,
      days: [
        trip.days[0]!,
        {
          ...trip.days[0]!,
          dayNumber: 2,
          routeGeometry: {
            type: "LineString" as const,
            coordinates: [
              [16.0, 50.0],
              [16.1, 50.05],
              [16.2, 50.1],
              [16.3, 50.15],
              [16.4, 50.2],
            ],
          },
          waypoints: [
            {
              id: "s2",
              name: "Start 2",
              type: "start" as const,
              location: { lng: 16.0, lat: 50.0 },
            },
            {
              id: "e2",
              name: "End 2",
              type: "end" as const,
              location: { lng: 16.4, lat: 50.2 },
            },
          ],
        },
      ],
    };
    const insert = vi.fn();
    const done = rerouteAroundConditionInTrip(
      twoDayTrip as never,
      {
        id: "closure-long",
        // Callers pass the FIRST line vertex as the location.
        location: { lng: 15.35, lat: 49.4 },
        line: [
          { lng: 15.35, lat: 49.4 },
          { lng: 15.8, lat: 49.8 },
          { lng: 16.19, lat: 50.095 },
        ],
      },
      insert,
    );
    expect(done).toBe(true);
    const [dayIndex, beforeId] = insert.mock.calls[0]!;
    expect(dayIndex).toBe(1);
    expect(beforeId).toBe("e2");
  });

  it("handles point conditions (passes) by borrowing the route direction", () => {
    const insert = vi.fn();
    const done = rerouteAroundConditionInTrip(
      trip as never,
      { id: "pass-1", location: { lng: 15.1, lat: 49.05 } },
      insert,
    );
    expect(done).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("declines when the trip has no routed geometry", () => {
    const insert = vi.fn();
    const bare = {
      ...trip,
      days: [{ ...trip.days[0]!, routeGeometry: undefined }],
    };
    expect(
      rerouteAroundConditionInTrip(
        bare as never,
        { id: "x", location: { lng: 15.1, lat: 49.05 } },
        insert,
      ),
    ).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("insertionAnchorForPoint", () => {
  it("anchors an early-route point before the first later waypoint", () => {
    // Point at ~14.2°E sits before the km-mid via (14.5°E) — inserting
    // before the finish would make the reroute backtrack through it.
    expect(insertionAnchorForPoint(day(), { lat: 50, lng: 14.2 })).toBe(
      "mid-via",
    );
  });

  it("anchors a late-route point before the finish", () => {
    expect(insertionAnchorForPoint(day(), { lat: 50, lng: 14.8 })).toBe("end");
  });

  it("returns null without usable geometry (append is the only option)", () => {
    expect(
      insertionAnchorForPoint(
        { ...day(), routeGeometry: undefined },
        { lat: 50, lng: 14.2 },
      ),
    ).toBeNull();
  });
});
