import { describe, expect, it } from "vitest";
import type { TripDay, Waypoint } from "@/lib/types";
import { planRerouteAroundSegment, rerouteViaWaypoint } from "../reroute";
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
