/**
 * Coverage for the trip-to-GPX adapter (`tripToGpxInput`) and the
 * shared renderer (`tripToGpx`). The render tests pin the file
 * structure that downstream importers (Garmin, Komoot, RideWithGPS)
 * rely on so a well-meaning refactor can't silently corrupt every
 * exported file.
 */
import { tripToGpx, tripGpxFileName } from "@tarmoto/shared";
import { tripToGpxInput } from "../TripScreens.helpers";
import type { Trip } from "@/types";

const TRIP_NOW = new Date("2026-04-30T12:00:00Z");

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "trip-1",
    title: "Stelvio loop",
    region: "Dolomites",
    num_days: 2,
    daily_km_min: 150,
    daily_km_max: 350,
    min_quality: 3,
    road_preference: "curvy",
    status: "planned",
    member_count: 1,
    members: [],
    created_at: "2026-04-29T10:00:00Z",
    days: [
      {
        id: "d-2",
        day_number: 2,
        title: "Day 2",
        distance_km: 80,
        avg_quality: 3.2,
        elevation_gain: 1200,
        elevation_loss: 1200,
        curviness_score: 70,
        scenic_score: 65,
        estimated_time_min: 95,
        // Out-of-order on purpose — `tripToGpxInput` must sort.
        route_geometry: [
          { lat: 46.61, lng: 10.57 },
          { lat: 46.7, lng: 10.65 },
        ],
        waypoints: [
          {
            id: "w-2-1",
            sequence: 1,
            lat: 46.7,
            lng: 10.65,
            name: "Cortina",
            waypoint_type: "end",
          },
          {
            id: "w-2-0",
            sequence: 0,
            lat: 46.61,
            lng: 10.57,
            name: "Prato",
            waypoint_type: "start",
          },
        ],
      },
      {
        id: "d-1",
        day_number: 1,
        title: undefined,
        distance_km: 120,
        avg_quality: 3.5,
        elevation_gain: 1500,
        elevation_loss: 1500,
        curviness_score: 80,
        scenic_score: 70,
        estimated_time_min: 130,
        route_geometry: [
          { lat: 46.47, lng: 10.37 },
          { lat: 46.5, lng: 10.41 },
          { lat: 46.61, lng: 10.57 },
        ],
        waypoints: [
          {
            id: "w-1-0",
            sequence: 0,
            lat: 46.47,
            lng: 10.37,
            name: "Bormio",
            waypoint_type: "start",
          },
          {
            id: "w-1-1",
            sequence: 1,
            lat: 46.61,
            lng: 10.57,
            name: "Prato",
            waypoint_type: "end",
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as Trip;
}

describe("tripToGpxInput", () => {
  it("orders days by day_number even when the API returns them shuffled", () => {
    const input = tripToGpxInput(makeTrip());
    expect(input.days.map((d) => d.dayNumber)).toEqual([1, 2]);
  });

  it("orders each day's waypoints by sequence", () => {
    const input = tripToGpxInput(makeTrip());
    expect(input.days[1]?.waypoints.map((w) => w.name)).toEqual([
      "Prato",
      "Cortina",
    ]);
  });

  it("emits geometry as [lng, lat] tuples for the GPX writer", () => {
    const input = tripToGpxInput(makeTrip());
    expect(input.days[0]?.routeGeometry?.[0]).toEqual([10.37, 46.47]);
  });

  it("propagates the trip name and region as description", () => {
    const input = tripToGpxInput(makeTrip());
    expect(input.name).toBe("Stelvio loop");
    expect(input.description).toBe("Dolomites");
  });
});

describe("tripToGpx", () => {
  it("renders a valid GPX 1.1 document with metadata, tracks and routes", () => {
    const xml = tripToGpx(tripToGpxInput(makeTrip()), TRIP_NOW);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<gpx version="1.1"');
    expect(xml).toContain("<name>Stelvio loop</name>");
    expect(xml).toContain("<time>2026-04-30T12:00:00.000Z</time>");
    // Day 1 has no title — the renderer should fall back to "Day 1".
    expect(xml).toContain("<name>Day 1</name>");
    // Day 2 has a title — the renderer should append it.
    expect(xml).toContain("<name>Day 2 — Day 2</name>");
    // Each day with geometry produces a `<trk>` block.
    expect(xml.match(/<trk>/g)?.length).toBe(2);
    // Coordinates are rendered with 6 decimals.
    expect(xml).toContain('<trkpt lat="46.470000" lon="10.370000"');
  });

  it("escapes XML entities in trip and waypoint names", () => {
    const trip = makeTrip({ title: "Fish & Chips" });
    const xml = tripToGpx(tripToGpxInput(trip), TRIP_NOW);
    expect(xml).toContain("<name>Fish &amp; Chips</name>");
    expect(xml).not.toMatch(/<name>Fish & Chips<\/name>/);
  });

  it("omits the `<trk>` block when a day has no geometry", () => {
    const trip = makeTrip();
    const day2 = trip.days[1];
    if (!day2) throw new Error("expected a second trip day");
    trip.days[1] = {
      ...day2,
      route_geometry: [],
      waypoints: [],
    };
    const xml = tripToGpx(tripToGpxInput(trip), TRIP_NOW);
    // Only one trk block (for day 1) since day 2 is empty.
    expect(xml.match(/<trk>/g)?.length).toBe(1);
  });

  it("emits route waypoints with the source waypoint type", () => {
    const xml = tripToGpx(tripToGpxInput(makeTrip()), TRIP_NOW);
    expect(xml).toContain("<type>start</type>");
    expect(xml).toContain("<type>end</type>");
  });
});

describe("tripGpxFileName", () => {
  it("slugifies the trip title and prefixes with `tarmoto-`", () => {
    expect(tripGpxFileName("Stelvio Loop 2026")).toBe(
      "tarmoto-stelvio-loop-2026.gpx",
    );
  });

  it("falls back to `tarmoto-trip.gpx` for unslugifiable titles", () => {
    expect(tripGpxFileName("???")).toBe("tarmoto-trip.gpx");
  });
});
