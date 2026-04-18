import {
  averageQuality,
  bboxAroundPoint,
  flattenTripRoute,
  formatDurationMin,
  formatKm,
  formatStatus,
  formatWaypointType,
  summarizeWaypoints,
  sumDistance,
} from "../TripScreens.helpers";
import type { LatLng, TripDay, Waypoint } from "@/types";

const wp = (
  id: string,
  type: Waypoint["waypoint_type"],
  sequence: number,
  overrides: Partial<Waypoint> = {},
): Waypoint => ({
  id,
  sequence,
  lat: 0,
  lng: 0,
  waypoint_type: type,
  ...overrides,
});

const day = (distance_km: number, avg_quality: number): TripDay => ({
  id: `d-${distance_km}-${avg_quality}`,
  day_number: 1,
  distance_km,
  avg_quality,
  elevation_gain: 0,
  estimated_time_min: 0,
  route_geometry: [],
  waypoints: [],
});

describe("formatKm / formatDurationMin / formatStatus / formatWaypointType", () => {
  it("rounds km", () => {
    expect(formatKm(123.4)).toBe("123 km");
    expect(formatKm(0)).toBe("0 km");
    expect(formatKm(Number.NaN)).toBe("0 km");
  });

  it("formats durations", () => {
    expect(formatDurationMin(0)).toBe("0m");
    expect(formatDurationMin(45)).toBe("45m");
    expect(formatDurationMin(60)).toBe("1h");
    expect(formatDurationMin(150)).toBe("2h 30m");
    expect(formatDurationMin(-5)).toBe("0m");
  });

  it("rounds total minutes before splitting so fractional inputs never produce '60m' or '1h 60m'", () => {
    // Rounding the modulo remainder on its own would yield 60 for both
    // of these inputs (59.5 → "60m", 119.5 → "1h 60m"). Rounding the
    // total first avoids the overflow.
    expect(formatDurationMin(59.5)).toBe("1h");
    expect(formatDurationMin(119.5)).toBe("2h");
    expect(formatDurationMin(89.7)).toBe("1h 30m");
  });

  it("title-cases statuses", () => {
    expect(formatStatus("draft")).toBe("Draft");
    expect(formatStatus("completed")).toBe("Completed");
  });

  it("maps 'via' to a friendlier label", () => {
    expect(formatWaypointType("via")).toBe("Waypoint");
    expect(formatWaypointType("fuel")).toBe("Fuel");
    expect(formatWaypointType("start")).toBe("Start");
  });
});

describe("summarizeWaypoints", () => {
  it("splits into fuel, overnight, other, start, end buckets and preserves sequence", () => {
    const waypoints = [
      wp("a", "start", 0),
      wp("b", "via", 2),
      wp("c", "fuel", 1),
      wp("d", "hotel", 3),
      wp("e", "photo", 4),
      wp("f", "end", 5),
    ];
    const summary = summarizeWaypoints(waypoints);
    expect(summary.start?.id).toBe("a");
    expect(summary.end?.id).toBe("f");
    expect(summary.fuelStops.map((w) => w.id)).toEqual(["c"]);
    expect(summary.overnightStops.map((w) => w.id)).toEqual(["d"]);
    // Waypoints emerge in sequence order, not insertion order.
    expect(summary.otherStops.map((w) => w.id)).toEqual(["b", "e"]);
  });

  it("handles empty input", () => {
    const summary = summarizeWaypoints([]);
    expect(summary.start).toBeNull();
    expect(summary.end).toBeNull();
    expect(summary.fuelStops).toEqual([]);
  });
});

describe("sumDistance / averageQuality", () => {
  it("sums day distances", () => {
    expect(sumDistance([day(120, 3), day(180, 4)])).toBe(300);
  });

  it("weights quality by distance — a 400 km quality-4 day outweighs a 50 km quality-1 hop", () => {
    const avg = averageQuality([day(400, 4), day(50, 1)]);
    expect(avg).toBeGreaterThan(3.5);
    expect(avg).toBeLessThan(4);
  });

  it("falls back to a flat mean when total distance is zero (degenerate plan)", () => {
    expect(averageQuality([day(0, 3), day(0, 5)])).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(averageQuality([])).toBe(0);
  });
});

describe("bboxAroundPoint", () => {
  it("produces a west,south,east,north string with lat/lng order", () => {
    const bbox = bboxAroundPoint(49.82, 18.26, 1);
    const parts = bbox.split(",").map((n) => Number.parseFloat(n));
    expect(parts).toHaveLength(4);
    const [minLng, minLat, maxLng, maxLat] = parts;
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
    // Centered on the input point within rounding.
    expect((minLat + maxLat) / 2).toBeCloseTo(49.82, 1);
    expect((minLng + maxLng) / 2).toBeCloseTo(18.26, 1);
  });

  it("scales with days but caps at 600 km", () => {
    const short = bboxAroundPoint(49.82, 18.26, 2);
    const epic = bboxAroundPoint(49.82, 18.26, 14);
    const [, sMinLat, , sMaxLat] = short.split(",").map(Number.parseFloat);
    const [, eMinLat, , eMaxLat] = epic.split(",").map(Number.parseFloat);
    expect(eMaxLat - eMinLat).toBeGreaterThan(sMaxLat - sMinLat);
    // Cap: 600 km → roughly 5.4° of latitude. Anything bigger means the
    // safety cap isn't working.
    expect(eMaxLat - eMinLat).toBeLessThan(11); // 2 * 5.4
  });

  it("handles missing / zero day count without producing NaN", () => {
    const bbox = bboxAroundPoint(0, 0, 0);
    expect(bbox.split(",").every((n) => Number.isFinite(Number(n)))).toBe(true);
  });
});

describe("flattenTripRoute", () => {
  const dayWith = (
    day_number: number,
    geom: LatLng[],
    distance_km = 100,
  ): TripDay => ({
    id: `d-${day_number}`,
    day_number,
    distance_km,
    avg_quality: 0,
    elevation_gain: 0,
    estimated_time_min: 0,
    route_geometry: geom,
    waypoints: [],
  });

  it("concatenates day geometries in day_number order", () => {
    const result = flattenTripRoute([
      dayWith(2, [
        { lat: 47.1, lng: 11.1 },
        { lat: 47.2, lng: 11.2 },
      ]),
      dayWith(1, [
        { lat: 46.9, lng: 10.9 },
        { lat: 47.0, lng: 11.0 },
      ]),
    ]);
    expect(result).toEqual([
      { lat: 46.9, lng: 10.9 },
      { lat: 47.0, lng: 11.0 },
      { lat: 47.1, lng: 11.1 },
      { lat: 47.2, lng: 11.2 },
    ]);
  });

  it("skips days with fewer than two points (degenerate geometry)", () => {
    const result = flattenTripRoute([
      dayWith(1, []),
      dayWith(2, [{ lat: 47, lng: 11 }]),
      dayWith(3, [
        { lat: 47.5, lng: 11.5 },
        { lat: 47.6, lng: 11.6 },
      ]),
    ]);
    expect(result).toEqual([
      { lat: 47.5, lng: 11.5 },
      { lat: 47.6, lng: 11.6 },
    ]);
  });

  it("returns an empty array when no day has usable geometry", () => {
    expect(flattenTripRoute([dayWith(1, []), dayWith(2, [])])).toEqual([]);
  });
});
