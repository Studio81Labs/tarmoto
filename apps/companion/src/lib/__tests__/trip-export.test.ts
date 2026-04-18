import { describe, expect, it } from "vitest";
import type { Trip } from "@/lib/types";
import { DEMO_TRIP } from "@/lib/demo-trip";
import {
  buildMobileDeepLink,
  buildTripShareUrl,
  buildTurnList,
  tripFileName,
  tripToGpx,
} from "../trip-export";

function minimalTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "t-1",
    name: "Test trip",
    status: "draft",
    days: [
      {
        dayNumber: 1,
        distanceKm: 100,
        durationMinutes: 120,
        elevationGain: 500,
        avgQuality: 4,
        waypoints: [
          {
            id: "w-1",
            name: "Start town",
            location: { lng: 10.5, lat: 46.4 },
            type: "start",
          },
          {
            id: "w-2",
            name: "End town",
            location: { lng: 10.7, lat: 46.6 },
            type: "end",
          },
        ],
      },
    ],
    parameters: {
      days: 1,
      dailyKmTarget: 100,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    collaborators: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("tripToGpx", () => {
  it("emits a valid GPX 1.1 document with metadata and route points", () => {
    const gpx = tripToGpx(minimalTrip(), new Date("2026-04-18T12:00:00Z"));

    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('version="1.1"');
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx).toContain("<name>Test trip</name>");
    expect(gpx).toContain("<time>2026-04-18T12:00:00.000Z</time>");
    expect(gpx).toContain('<rtept lat="46.400000" lon="10.500000">');
    expect(gpx).toContain("<name>Start town</name>");
    expect(gpx).toContain("<name>End town</name>");
    expect(gpx).toContain("<name>Day 1</name>");
  });

  it("includes one rte per day and falls back to type label when name is absent", () => {
    const trip = minimalTrip({
      days: [
        {
          dayNumber: 1,
          title: "Stelvio",
          distanceKm: 50,
          durationMinutes: 90,
          elevationGain: 800,
          avgQuality: 4,
          waypoints: [
            {
              id: "w-a",
              location: { lng: 10.1, lat: 46.1 },
              type: "fuel",
            },
          ],
        },
        {
          dayNumber: 2,
          distanceKm: 80,
          durationMinutes: 150,
          elevationGain: 1200,
          avgQuality: 3.5,
          waypoints: [
            {
              id: "w-b",
              name: "Aprica",
              location: { lng: 10.16, lat: 46.16 },
              type: "end",
            },
          ],
        },
      ],
    });
    const gpx = tripToGpx(trip);

    expect(gpx.match(/<rte>/g)?.length).toBe(2);
    expect(gpx).toContain("<name>Day 1 — Stelvio</name>");
    expect(gpx).toContain("<name>Fuel stop</name>");
    expect(gpx).toContain("<type>fuel</type>");
    expect(gpx).toContain("<name>Day 2</name>");
  });

  it("emits a <trk> with trackpoints when a day has route geometry", () => {
    const trip = minimalTrip({
      days: [
        {
          dayNumber: 1,
          distanceKm: 10,
          durationMinutes: 30,
          elevationGain: 100,
          avgQuality: 4,
          waypoints: [],
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.0, 46.0],
              [10.1, 46.05],
              [10.2, 46.1],
            ],
          },
        },
      ],
    });
    const gpx = tripToGpx(trip);

    expect(gpx).toContain("<trk>");
    expect(gpx).toContain("<trkseg>");
    expect(gpx.match(/<trkpt /g)?.length).toBe(3);
    expect(gpx).toContain('<trkpt lat="46.000000" lon="10.000000"');
    // No waypoints means no <rte> was emitted.
    expect(gpx).not.toContain("<rte>");
  });

  it("escapes XML-sensitive characters in trip and waypoint names", () => {
    const trip = minimalTrip({
      name: "R&D <loop>",
      days: [
        {
          dayNumber: 1,
          distanceKm: 10,
          durationMinutes: 30,
          elevationGain: 0,
          avgQuality: 4,
          waypoints: [
            {
              id: "w",
              name: 'Bar & "Cafe"',
              location: { lng: 1, lat: 2 },
              type: "start",
            },
          ],
        },
      ],
    });
    const gpx = tripToGpx(trip);

    expect(gpx).toContain("<name>R&amp;D &lt;loop&gt;</name>");
    expect(gpx).toContain('<name>Bar &amp; "Cafe"</name>');
  });

  it("serializes the demo trip without throwing", () => {
    const gpx = tripToGpx(DEMO_TRIP);
    expect(gpx).toContain("<name>Alps loop — demo</name>");
    // Two days, both with at least two waypoints.
    expect(gpx.match(/<rte>/g)?.length).toBe(2);
  });
});

describe("tripFileName", () => {
  it("slugifies the trip name and appends the given extension", () => {
    const trip = minimalTrip({ name: "Alps Loop — Demo 2026!" });
    expect(tripFileName(trip, "gpx")).toBe("tarmoto-alps-loop-demo-2026.gpx");
    expect(tripFileName(trip, ".gpx")).toBe("tarmoto-alps-loop-demo-2026.gpx");
  });

  it("falls back to the trip id when the name has no slug-safe characters", () => {
    const trip = minimalTrip({ id: "abc-123", name: "✨✨✨" });
    expect(tripFileName(trip, "gpx")).toBe("tarmoto-abc-123.gpx");
  });

  it("slugifies the id fallback so filesystem-unsafe chars don't leak in", () => {
    const trip = minimalTrip({ id: "a b/c", name: "✨✨" });
    expect(tripFileName(trip, "gpx")).toBe("tarmoto-a-b-c.gpx");
  });
});

describe("buildTripShareUrl", () => {
  it("builds a canonical trips URL against the given origin", () => {
    const trip = minimalTrip({ id: "t-42" });
    expect(buildTripShareUrl(trip, "https://app.tarmoto.cc")).toBe(
      "https://app.tarmoto.cc/trips/t-42",
    );
  });

  it("trims a trailing slash on the origin", () => {
    const trip = minimalTrip({ id: "t-42" });
    expect(buildTripShareUrl(trip, "https://app.tarmoto.cc/")).toBe(
      "https://app.tarmoto.cc/trips/t-42",
    );
  });

  it("url-encodes trip ids that contain reserved characters", () => {
    const trip = minimalTrip({ id: "a b/c" });
    expect(buildTripShareUrl(trip, "https://x.test")).toBe(
      "https://x.test/trips/a%20b%2Fc",
    );
  });
});

describe("buildMobileDeepLink", () => {
  it("uses the tarmoto scheme so the mobile app handles the intent", () => {
    const trip = minimalTrip({ id: "t-99" });
    expect(buildMobileDeepLink(trip)).toBe("tarmoto://trips/t-99");
  });
});

describe("buildTurnList", () => {
  it("produces one item per day with labelled waypoints", () => {
    const list = buildTurnList(DEMO_TRIP);
    expect(list).toHaveLength(2);
    expect(list[0].dayNumber).toBe(1);
    expect(list[0].waypoints[0]).toMatchObject({
      label: "Bormio",
      typeLabel: "Start",
      lat: 46.47,
      lng: 10.37,
    });
    expect(list[0].waypoints[1].typeLabel).toBe("End");
  });
});
