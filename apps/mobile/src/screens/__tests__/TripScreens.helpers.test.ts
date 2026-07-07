import {
  averageQuality,
  bboxAroundPoint,
  computeFuelRangeLegs,
  flattenTripRoute,
  formatDurationMin,
  formatKm,
  formatStatus,
  formatWaypointType,
  isLastDay,
  isSuggestedOvernightWaypoint,
  navigationWaypointsForRoadNames,
  pickDayEndAnchor,
  pickSuggestedAccommodation,
  poiOpenCandidates,
  routeGeometrySignature,
  summarizeFuelRange,
  summarizeWaypoints,
  sumDistance,
  withSuggestedOvernightStop,
} from "../TripScreens.helpers";
import type { Accommodation, LatLng, Trip, TripDay, Waypoint } from "@/types";

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
  name: null,
  road_segment_id: null,
  notes: null,
  duration_min: null,
  ...overrides,
});

const day = (distance_km: number, avg_quality: number): TripDay => ({
  id: `d-${distance_km}-${avg_quality}`,
  day_number: 1,
  distance_km,
  avg_quality,
  elevation_gain: 0,
  elevation_loss: 0,
  curviness_score: 0,
  scenic_score: 0,
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

  it("infers a non-final day's overnight from its end when no hotel is present", () => {
    // A manual save normalizes a generated leg's stay to a routed `end`.
    const waypoints = [wp("a", "start", 0), wp("z", "end", 1)];
    // Non-final day → the end IS the overnight boundary.
    expect(
      summarizeWaypoints(waypoints, false).overnightStops.map((w) => w.id),
    ).toEqual(["z"]);
    // Final day → the end is the trip finish, not an overnight.
    expect(summarizeWaypoints(waypoints, true).overnightStops).toEqual([]);
    // An explicit hotel still wins over the end inference.
    const withHotel = [
      wp("a", "start", 0),
      wp("h", "hotel", 1),
      wp("z", "end", 2),
    ];
    expect(
      summarizeWaypoints(withHotel, false).overnightStops.map((w) => w.id),
    ).toEqual(["h"]);
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
    if (
      minLng === undefined ||
      minLat === undefined ||
      maxLng === undefined ||
      maxLat === undefined
    ) {
      throw new Error("expected four bbox parts");
    }
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
    if (
      sMinLat === undefined ||
      sMaxLat === undefined ||
      eMinLat === undefined ||
      eMaxLat === undefined
    ) {
      throw new Error("expected latitude bbox parts");
    }
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
    elevation_loss: 0,
    curviness_score: 0,
    scenic_score: 0,
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

describe("routeGeometrySignature", () => {
  it("stays stable for waypoint-only trip changes", () => {
    const base = tripWithDays([
      dayFrom(
        vertexStrip([49, 49.5, 50]),
        [wp("start", "start", 0), wp("end", "end", 1)],
        { id: "day-1", day_number: 1 },
      ),
    ]);
    const withSuggestedStay = tripWithDays([
      dayFrom(
        vertexStrip([49, 49.5, 50]),
        [
          wp("start", "start", 0),
          wp("suggested-overnight:day-1:stay-1", "hotel", 1),
          wp("end", "end", 2),
        ],
        { id: "day-1", day_number: 1 },
      ),
    ]);

    expect(routeGeometrySignature(base.days)).toBe(
      routeGeometrySignature(withSuggestedStay.days),
    );
  });
});

// ── US-10 fuel-range analysis ──
//
// Fixtures below use a north-facing meridian so haversine distance stays
// on the 1° ≈ 111.2 km rail — that lets the expectations hit round-ish
// numbers without mocking the distance function. Tolerances stay wide
// enough to absorb Earth-radius rounding.

const MERIDIAN_LNG = 0;
const KM_PER_DEGREE_LAT = 111.195;

function dayFrom(
  vertices: LatLng[],
  waypoints: Waypoint[],
  overrides: Partial<TripDay> = {},
): TripDay {
  return {
    id: "day-fixture",
    day_number: 1,
    distance_km: 0,
    avg_quality: 0,
    elevation_gain: 0,
    elevation_loss: 0,
    curviness_score: 0,
    scenic_score: 0,
    estimated_time_min: 0,
    route_geometry: vertices,
    waypoints,
    ...overrides,
  };
}

function makeAccommodation(
  external_id: string,
  overrides: Partial<Accommodation> = {},
): Accommodation {
  return {
    external_id,
    name: "Hotel fixture",
    kind: "hotel",
    lat: 49,
    lng: 18,
    distance_km: 1,
    website: null,
    phone: null,
    stars: 3,
    opening_hours: null,
    address_street: null,
    address_city: null,
    address_postcode: null,
    address_country: null,
    osm_url: null,
    maps_url: "https://www.google.com/maps/search/?api=1&query=x",
    ...overrides,
  };
}

function tripWithDays(days: TripDay[]): Trip {
  return {
    id: "trip-1",
    title: "Trip fixture",
    region: "Moravia",
    num_days: days.length,
    status: "planned",
    member_count: 1,
    created_at: "2026-04-23T08:00:00.000Z",
    daily_km_min: 150,
    daily_km_max: 300,
    min_quality: 3,
    road_preference: "curvy",
    days,
    members: [],
  };
}

function vertexStrip(lats: number[]): LatLng[] {
  return lats.map((lat) => ({ lat, lng: MERIDIAN_LNG }));
}

describe("computeFuelRangeLegs", () => {
  it("returns an empty array when geometry is missing or degenerate", () => {
    expect(computeFuelRangeLegs(dayFrom([], []), 250)).toEqual([]);
    expect(
      computeFuelRangeLegs(dayFrom([{ lat: 49, lng: 0 }], []), 250),
    ).toEqual([]);
  });

  it("flags the single Start→End leg when there are no fuel stops", () => {
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51]), []);
    const legs = computeFuelRangeLegs(day, 150);
    expect(legs).toHaveLength(1);
    // 2° of latitude ≈ 222 km — exceeds a 150 km range.
    expect(legs[0]?.distanceKm).toBeGreaterThan(220);
    expect(legs[0]?.distanceKm).toBeLessThan(225);
    expect(legs[0]?.exceedsRange).toBe(true);
    expect(legs[0]?.fromName).toBe("Start");
    expect(legs[0]?.toName).toBe("End");
  });

  it("splits the route at each fuel waypoint and honours within-range legs", () => {
    // Route spans 3° ≈ 333.6 km. Fuel waypoint sits at lat 50.5 — roughly
    // the midpoint.
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), [
      {
        id: "start",
        sequence: 0,
        lat: 49,
        lng: 0,
        waypoint_type: "start",
        name: "Home",
      },
      {
        id: "fuel",
        sequence: 1,
        lat: 50.5,
        lng: 0,
        waypoint_type: "fuel",
        name: "BP Brno",
      },
      {
        id: "end",
        sequence: 2,
        lat: 52,
        lng: 0,
        waypoint_type: "end",
        name: "Hotel",
      },
    ]);
    const legs = computeFuelRangeLegs(day, 200);
    expect(legs).toHaveLength(2);
    expect(legs[0]?.fromName).toBe("Home");
    expect(legs[0]?.toName).toBe("BP Brno");
    expect(legs[1]?.fromName).toBe("BP Brno");
    expect(legs[1]?.toName).toBe("Hotel");
    // ~166 km each — both under 200 km.
    expect(legs.every((l) => !l.exceedsRange)).toBe(true);
    expect(legs[0]?.distanceKm).toBeCloseTo(1.5 * KM_PER_DEGREE_LAT, 0);
  });

  it("marks a leg as exceeding when its distance is above the fuel range", () => {
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), [
      {
        id: "fuel",
        sequence: 1,
        lat: 50.5,
        lng: 0,
        waypoint_type: "fuel",
      },
    ]);
    const legs = computeFuelRangeLegs(day, 100);
    // Both ~166 km halves exceed a 100 km tank.
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.exceedsRange)).toBe(true);
  });

  it("re-orders fuel stops along the route even if their sequence disagrees", () => {
    // Two fuel stops listed in reverse geographic order — the helper
    // should still yield monotonic legs.
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), [
      { id: "f2", sequence: 1, lat: 51.5, lng: 0, waypoint_type: "fuel" },
      { id: "f1", sequence: 2, lat: 49.5, lng: 0, waypoint_type: "fuel" },
    ]);
    const legs = computeFuelRangeLegs(day, 500);
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.distanceKm >= 0)).toBe(true);
    const total = legs.reduce((sum, l) => sum + l.distanceKm, 0);
    expect(total).toBeCloseTo(3 * KM_PER_DEGREE_LAT, 0);
  });

  it("snaps off-route fuel waypoints to the nearest vertex", () => {
    // Fuel waypoint ≈ 50 km *east* of the route (1° lng ≈ 71.5 km at
    // lat 50.5). Nearest vertex is lat 50.5 — the split point should
    // still sit at the route's midpoint.
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), [
      { id: "fuel", sequence: 1, lat: 50.5, lng: 0.7, waypoint_type: "fuel" },
    ]);
    const legs = computeFuelRangeLegs(day, 1000);
    expect(legs[0]?.distanceKm).toBeCloseTo(1.5 * KM_PER_DEGREE_LAT, 0);
  });

  it("never flags legs as exceeding when fuelRangeKm is zero or negative", () => {
    const day = dayFrom(vertexStrip([49, 50, 51, 52]), []);
    expect(computeFuelRangeLegs(day, 0)[0]?.exceedsRange).toBe(false);
    expect(computeFuelRangeLegs(day, -200)[0]?.exceedsRange).toBe(false);
  });
});

describe("pickSuggestedAccommodation", () => {
  it("prefers a close, named stay over a farther higher-star option when no reroute is needed", () => {
    const choice = pickSuggestedAccommodation([
      makeAccommodation("far-luxury", {
        name: "Grand Alpine",
        distance_km: 4.8,
        stars: 5,
      }),
      makeAccommodation("close-guesthouse", {
        name: "Pension U Mostu",
        kind: "guest_house",
        distance_km: 0.6,
        stars: 3,
      }),
    ]);

    expect(choice?.external_id).toBe("close-guesthouse");
  });

  it("breaks near-distance ties by favouring stars and a named stay", () => {
    const choice = pickSuggestedAccommodation([
      makeAccommodation("unnamed", {
        name: null,
        distance_km: 1.1,
        stars: 4,
      }),
      makeAccommodation("named", {
        name: "Hotel Beskyd",
        distance_km: 1.2,
        stars: 4,
      }),
      makeAccommodation("better-stars", {
        name: "Penzion Pod Lesem",
        distance_km: 1.2,
        stars: 5,
      }),
    ]);

    expect(choice?.external_id).toBe("better-stars");
  });

  it("returns null when there are no accommodation candidates", () => {
    expect(pickSuggestedAccommodation([])).toBeNull();
  });
});

describe("withSuggestedOvernightStop", () => {
  it("injects the best stay before the end waypoint and normalizes sequences", () => {
    const trip = tripWithDays([
      dayFrom(
        vertexStrip([49, 49.4, 49.8]),
        [wp("start", "start", 0), wp("end", "end", 4, { name: "Day 1 end" })],
        { id: "day-1", day_number: 1 },
      ),
      dayFrom(vertexStrip([49.8, 50.1]), [wp("d2-start", "start", 0)], {
        id: "day-2",
        day_number: 2,
      }),
    ]);

    const next = withSuggestedOvernightStop(trip, 1, [
      makeAccommodation("stay-1", {
        name: "Hotel Solan",
        lat: 49.79,
        lng: 18.02,
        distance_km: 0.8,
      }),
    ]);

    const day1 = next.days[0];
    if (!day1) throw new Error("expected a first trip day");
    expect(day1.waypoints.map((waypoint) => waypoint.waypoint_type)).toEqual([
      "start",
      "hotel",
      "end",
    ]);
    expect(day1.waypoints.map((waypoint) => waypoint.sequence)).toEqual([
      0, 1, 2,
    ]);
    expect(day1.waypoints[1]).toMatchObject({
      name: "Hotel Solan",
      waypoint_type: "hotel",
      lat: 49.79,
      lng: 18.02,
    });
  });

  it("preserves an explicit hotel waypoint that already came from the itinerary", () => {
    const trip = tripWithDays([
      dayFrom(
        vertexStrip([49, 49.4, 49.8]),
        [
          wp("start", "start", 0),
          wp("hotel-explicit", "hotel", 1, { name: "Booked stay" }),
          wp("end", "end", 2),
        ],
        { id: "day-1", day_number: 1 },
      ),
      dayFrom(vertexStrip([49.8, 50.1]), [wp("d2-start", "start", 0)], {
        id: "day-2",
        day_number: 2,
      }),
    ]);

    const next = withSuggestedOvernightStop(trip, 1, [
      makeAccommodation("replacement", {
        name: "Different stay",
        distance_km: 0.4,
      }),
    ]);

    expect(next.days[0]?.waypoints[1]).toMatchObject({
      id: "hotel-explicit",
      name: "Booked stay",
      waypoint_type: "hotel",
    });
  });

  it("skips the final day because the rider is arriving rather than needing another stay", () => {
    const trip = tripWithDays([
      dayFrom(vertexStrip([49, 49.4, 49.8]), [wp("start", "start", 0)], {
        id: "day-1",
        day_number: 1,
      }),
    ]);

    const next = withSuggestedOvernightStop(trip, 1, [
      makeAccommodation("stay-1", { name: "Hotel Solan" }),
    ]);

    expect(next).toBe(trip);
  });
});

describe("navigationWaypointsForRoadNames", () => {
  it("drops client-only suggested overnight stays so navigation keeps planner-aligned waypoints", () => {
    const waypoints = [
      wp("start", "start", 0, { name: "Start" }),
      wp("suggested-overnight:day-1:stay-1", "hotel", 1, {
        name: "Hotel Solan",
      }),
      wp("fuel-1", "fuel", 2, { name: "Fuel" }),
      wp("end", "end", 3, { name: "Finish" }),
    ];

    expect(
      navigationWaypointsForRoadNames(waypoints).map((waypoint) => waypoint.id),
    ).toEqual(["start", "fuel-1", "end"]);
    const secondWaypoint = waypoints[1];
    if (!secondWaypoint) throw new Error("expected a second waypoint");
    expect(isSuggestedOvernightWaypoint(secondWaypoint)).toBe(true);
  });
});

describe("summarizeFuelRange", () => {
  it("surfaces the longest leg and how many legs exceed", () => {
    const day = dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), [
      { id: "fuel", sequence: 1, lat: 49.5, lng: 0, waypoint_type: "fuel" },
    ]);
    const { legs, longestLegKm, exceedingCount } = summarizeFuelRange(day, 100);
    expect(legs).toHaveLength(2);
    // Leg 1 (Start→Fuel) ≈ 55 km, Leg 2 (Fuel→End) ≈ 278 km.
    expect(longestLegKm).toBeGreaterThan(275);
    expect(exceedingCount).toBe(1);
  });

  it("returns zeroed fields when geometry is missing", () => {
    const result = summarizeFuelRange(dayFrom([], []), 200);
    expect(result.legs).toEqual([]);
    expect(result.longestLegKm).toBe(0);
    expect(result.exceedingCount).toBe(0);
  });

  describe("fuel-station annotations (US-36)", () => {
    // 7 vertices spanning 49°–52° along the meridian → ~333 km total.
    // With no fuel waypoints and a 150 km range, the single Start→End
    // leg exceeds — which is exactly when the station hint is useful.
    const longDay = () =>
      dayFrom(vertexStrip([49, 49.5, 50, 50.5, 51, 51.5, 52]), []);

    it("attaches suggested stops to exceeding legs when stations are supplied", () => {
      const day = longDay();
      const result = summarizeFuelRange(day, 150, [
        {
          name: "Shell Brno",
          hint: "Shell",
          distanceAlongRouteKm: 130,
          distanceFromRouteKm: 0.4,
        },
        {
          name: "OMV",
          hint: null,
          distanceAlongRouteKm: 250,
          distanceFromRouteKm: 0.7,
        },
      ]);
      expect(result.legs).toHaveLength(1);
      const leg = result.legs[0];
      if (!leg) throw new Error("expected a fuel range leg");
      expect(leg.exceedsRange).toBe(true);
      expect(leg.suggestedStops).toEqual([
        {
          name: "Shell Brno",
          hint: "Shell",
          // Leg starts at 0 km — station distance-from-start equals
          // its distance-along-route.
          distanceFromLegStartKm: 130,
          distanceFromRouteKm: 0.4,
        },
        {
          name: "OMV",
          hint: null,
          distanceFromLegStartKm: 250,
          distanceFromRouteKm: 0.7,
        },
      ]);
    });

    it("does not attach stops to legs that already sit within range", () => {
      const day = longDay();
      // Fuel waypoint at the midpoint splits the day into two 166 km
      // halves — with a 200 km range, neither leg exceeds. Stations
      // must NOT be attached even if they fall inside a leg because
      // the card already shows "no problem" and adding a refuel hint
      // would be noise.
      day.waypoints.push({
        id: "fuel",
        sequence: 1,
        lat: 50.5,
        lng: MERIDIAN_LNG,
        waypoint_type: "fuel",
      });
      const result = summarizeFuelRange(day, 200, [
        {
          name: "Shell Brno",
          hint: null,
          distanceAlongRouteKm: 80,
          distanceFromRouteKm: 0.5,
        },
      ]);
      expect(result.exceedingCount).toBe(0);
      for (const leg of result.legs) {
        expect(leg.suggestedStops).toBeUndefined();
      }
    });

    it("buckets stations into the right exceeding leg by distance-along-route", () => {
      // Fuel waypoint ~220 km in (lat 50.98 ≈ 1.98° north of 49).
      // Leg 1 (0–220 km) fits in a 250 km tank. Leg 2 (220–333 km)
      // also fits. Drop the range to 100 km so both legs exceed, and
      // check stations get routed to whichever leg they fall in.
      const day = longDay();
      day.waypoints.push({
        id: "fuel",
        sequence: 1,
        lat: 50.98,
        lng: MERIDIAN_LNG,
        waypoint_type: "fuel",
        name: "BP",
      });
      const result = summarizeFuelRange(day, 100, [
        // Inside leg 1 (0..~220 km).
        {
          name: "Station A",
          hint: null,
          distanceAlongRouteKm: 80,
          distanceFromRouteKm: 0.3,
        },
        // Inside leg 2 (~220..333 km).
        {
          name: "Station B",
          hint: null,
          distanceAlongRouteKm: 280,
          distanceFromRouteKm: 0.2,
        },
      ]);
      expect(result.legs).toHaveLength(2);
      const [leg0, leg1] = result.legs;
      if (!leg0 || !leg1) throw new Error("expected two fuel range legs");
      expect(leg0.suggestedStops?.map((s) => s.name)).toEqual(["Station A"]);
      expect(leg1.suggestedStops?.map((s) => s.name)).toEqual(["Station B"]);
      // Leg 2 starts ~220 km in; Station B at 280 km is ~60 km in.
      const leg1FirstStop = leg1.suggestedStops?.[0];
      if (!leg1FirstStop) throw new Error("expected a suggested stop on leg 2");
      expect(leg1FirstStop.distanceFromLegStartKm).toBeGreaterThan(55);
      expect(leg1FirstStop.distanceFromLegStartKm).toBeLessThan(65);
    });

    it("keeps blank-named stations with a fallback label so the warning still lists a refuel option", () => {
      // An unmanned fuel stop on a sparse route often has no name. The
      // backend now returns it (maps_url makes it navigable), so the
      // fuel-range warning must surface it with a fallback label rather
      // than silently dropping it and claiming there is no refuel option.
      const result = summarizeFuelRange(longDay(), 150, [
        {
          name: null,
          hint: "Shell",
          distanceAlongRouteKm: 150,
          distanceFromRouteKm: 0.2,
        },
        {
          name: "   ",
          hint: null,
          distanceAlongRouteKm: 175,
          distanceFromRouteKm: 0.4,
        },
        {
          name: "Named",
          hint: null,
          distanceAlongRouteKm: 200,
          distanceFromRouteKm: 0.3,
        },
      ]);
      expect(result.legs[0]?.suggestedStops?.map((s) => s.name)).toEqual([
        "Fuel stop",
        "Fuel stop",
        "Named",
      ]);
      // The brand hint survives so the row can still read "Fuel stop · Shell".
      expect(result.legs[0]?.suggestedStops?.[0]?.hint).toBe("Shell");
    });

    it("caps suggested stops per leg to stop the warning card from ballooning", () => {
      const manyStations = Array.from({ length: 8 }, (_, i) => ({
        name: `Station ${i}`,
        hint: null,
        distanceAlongRouteKm: 20 + i * 10,
        distanceFromRouteKm: 0.5,
      }));
      const result = summarizeFuelRange(longDay(), 150, manyStations);
      // MAX_SUGGESTED_STOPS_PER_LEG is a private constant inside the
      // helper (3); assert the public contract rather than the value.
      const cappedLeg = result.legs[0];
      if (!cappedLeg?.suggestedStops) {
        throw new Error("expected suggested stops on the first leg");
      }
      expect(cappedLeg.suggestedStops.length).toBeLessThanOrEqual(3);
    });

    it("is a no-op when the station list is empty", () => {
      const day = longDay();
      const result = summarizeFuelRange(day, 150, []);
      for (const leg of result.legs) {
        expect(leg.suggestedStops).toBeUndefined();
      }
    });
  });
});

describe("pickDayEndAnchor", () => {
  it("prefers an explicit end waypoint", () => {
    const d = dayFrom(vertexStrip([49, 50]), [
      {
        id: "start",
        sequence: 1,
        lat: 49.0,
        lng: 10.0,
        waypoint_type: "start",
      },
      { id: "end", sequence: 2, lat: 50.0, lng: 11.0, waypoint_type: "end" },
    ]);
    expect(pickDayEndAnchor(d)).toEqual({ lat: 50.0, lng: 11.0 });
  });

  it("sorts explicit end waypoints by sequence even if they arrive in reverse", () => {
    const d = dayFrom(vertexStrip([49, 50]), [
      { id: "end", sequence: 2, lat: 50.0, lng: 11.0, waypoint_type: "end" },
      {
        id: "start",
        sequence: 1,
        lat: 49.0,
        lng: 10.0,
        waypoint_type: "start",
      },
    ]);
    expect(pickDayEndAnchor(d)).toEqual({ lat: 50.0, lng: 11.0 });
  });

  it("falls back to an explicit non-synthetic hotel when there is no end waypoint", () => {
    const d = dayFrom(vertexStrip([49, 50]), [
      {
        id: "start",
        sequence: 0,
        lat: 49.0,
        lng: 10.0,
        waypoint_type: "start",
      },
      {
        id: "hotel-explicit",
        sequence: 1,
        lat: 49.7,
        lng: 10.7,
        waypoint_type: "hotel",
      },
    ]);
    expect(pickDayEndAnchor(d)).toEqual({ lat: 49.7, lng: 10.7 });
  });

  it("ignores a suggested overnight stay and falls back to route geometry when no explicit day-end anchor exists", () => {
    const d = dayFrom(
      [
        { lat: 49, lng: 0 },
        { lat: 49.5, lng: 0 },
        { lat: 50, lng: 0 },
      ],
      [
        {
          id: "start",
          sequence: 0,
          lat: 49.0,
          lng: 0,
          waypoint_type: "start",
        },
        {
          id: "suggested-overnight:day-1:stay-1",
          sequence: 1,
          lat: 49.6,
          lng: 0.1,
          waypoint_type: "hotel",
        },
      ],
    );
    expect(pickDayEndAnchor(d)).toEqual({ lat: 50, lng: 0 });
  });

  it("falls back to the last geometry vertex when no waypoints exist", () => {
    const d = dayFrom(
      [
        { lat: 49, lng: 0 },
        { lat: 49.5, lng: 0 },
        { lat: 50, lng: 0 },
      ],
      [],
    );
    expect(pickDayEndAnchor(d)).toEqual({ lat: 50, lng: 0 });
  });

  it("returns null when there is nothing to anchor on", () => {
    expect(pickDayEndAnchor(dayFrom([], []))).toBeNull();
  });
});

describe("isLastDay", () => {
  it("identifies the final day by highest day_number", () => {
    const days: TripDay[] = [
      { ...dayFrom([], []), id: "d1", day_number: 1 },
      { ...dayFrom([], []), id: "d3", day_number: 3 },
      { ...dayFrom([], []), id: "d2", day_number: 2 },
    ];
    expect(isLastDay(days, 3)).toBe(true);
    expect(isLastDay(days, 2)).toBe(false);
    expect(isLastDay(days, 1)).toBe(false);
  });

  it("returns false for an empty day list", () => {
    expect(isLastDay([], 1)).toBe(false);
  });

  it("handles a single-day trip", () => {
    const days: TripDay[] = [{ ...dayFrom([], []), day_number: 1 }];
    expect(isLastDay(days, 1)).toBe(true);
  });
});

describe("poiOpenCandidates", () => {
  const base = {
    website: null as string | null,
    phone: null as string | null,
    maps_url: "https://www.google.com/maps/search/?api=1&query=x",
    lat: 49.5,
    lng: 18.4,
  };

  it("orders website, phone, maps_url, then the OSM coordinate link", () => {
    const urls = poiOpenCandidates({
      ...base,
      website: "https://koliba.cz",
      phone: "+420 555 000 111",
      maps_url: "https://www.google.com/maps/search/?api=1&query=Koliba",
    });

    expect(urls).toEqual([
      "https://koliba.cz",
      "tel:+420555000111",
      "https://www.google.com/maps/search/?api=1&query=Koliba",
      "https://www.openstreetmap.org/?mlat=49.5&mlon=18.4#map=17/49.5/18.4",
    ]);
  });

  it("tries maps_url before the OSM pin for a coordinate-only POI", () => {
    // No website, no phone: the Google Maps deep link must come before the
    // bare OSM coordinate pin so contactless rows still open a rich page.
    const urls = poiOpenCandidates(base);

    expect(urls[0]).toBe(base.maps_url);
    expect(urls[1]).toContain("openstreetmap.org");
    expect(urls).toHaveLength(2);
  });

  it("drops a non-http website but keeps the rest of the chain", () => {
    const urls = poiOpenCandidates({ ...base, website: "koliba.cz" });

    expect(urls.some((u) => u.includes("koliba.cz"))).toBe(false);
    expect(urls[0]).toBe(base.maps_url);
  });
});
