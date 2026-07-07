import type { RouteSegment } from "@/lib/planner/types";
import type { Trip, TripDay } from "@/lib/types";
import { tripSnapshotForSharing } from "../trip-snapshot";

function day(dayNumber: number, qualitySegments?: RouteSegment[]): TripDay {
  return {
    dayNumber,
    waypoints: [],
    distanceKm: 10,
    durationMinutes: 20,
    elevationGain: 0,
    avgQuality: 4,
    ...(qualitySegments ? { qualitySegments } : {}),
  };
}

const segment: RouteSegment = {
  id: "d1-s0",
  geometry: {
    type: "LineString",
    coordinates: [
      [14.2, 49.4],
      [14.6, 49.42],
    ],
  },
  band: "good",
  surface: "asphalt",
  score: 4.2,
  passes: 12,
  lengthKm: 30,
  dayNumber: 1,
};

describe("tripSnapshotForSharing", () => {
  it("strips client-only qualitySegments from every day", () => {
    const trip = {
      id: "t1",
      name: "Test trip",
      days: [day(1, [segment]), day(2)],
    } as unknown as Trip;

    const snapshot = tripSnapshotForSharing(trip);

    expect(snapshot.days.every((d) => d.qualitySegments === undefined)).toBe(
      true,
    );
    // Other fields survive.
    expect(snapshot.name).toBe("Test trip");
    expect(snapshot.days.map((d) => d.dayNumber)).toEqual([1, 2]);
    expect(snapshot.days[0]!.distanceKm).toBe(10);
  });

  it("does not mutate the original trip", () => {
    const trip = {
      id: "t1",
      name: "Test trip",
      days: [day(1, [segment])],
    } as unknown as Trip;

    tripSnapshotForSharing(trip);

    expect(trip.days[0]!.qualitySegments).toHaveLength(1);
  });
});
