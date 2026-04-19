import { describe, expect, it } from "vitest";
import {
  importedRouteToTrip,
  parseImportedRoute,
  pointsDistanceKm,
} from "../gpx-kml-import";

const GPX_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin BaseCamp" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Stelvio loop</name>
  </metadata>
  <trk>
    <name>Stelvio loop</name>
    <trkseg>
      <trkpt lat="46.470000" lon="10.370000"/>
      <trkpt lat="46.480000" lon="10.390000"/>
      <trkpt lat="46.500000" lon="10.410000"/>
      <trkpt lat="46.520000" lon="10.430000"/>
      <trkpt lat="46.540000" lon="10.450000"/>
      <trkpt lat="46.560000" lon="10.470000"/>
      <trkpt lat="46.580000" lon="10.490000"/>
      <trkpt lat="46.610000" lon="10.570000"/>
    </trkseg>
  </trk>
</gpx>`;

const GPX_ROUTE_WITH_WPTS = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Calimoto" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="46.470000" lon="10.370000"><name>Bormio</name></wpt>
  <wpt lat="46.610000" lon="10.570000"><name>Prato</name></wpt>
  <rte>
    <name>Bormio to Prato</name>
    <rtept lat="46.470000" lon="10.370000"><name>Bormio</name></rtept>
    <rtept lat="46.540000" lon="10.470000"><name>Umbrail</name></rtept>
    <rtept lat="46.610000" lon="10.570000"><name>Prato</name></rtept>
  </rte>
</gpx>`;

const KML_LINESTRING = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Alps ride</name>
    <Placemark>
      <name>Track</name>
      <LineString>
        <coordinates>
          10.370,46.470,0
          10.410,46.500,0
          10.470,46.540,0
          10.570,46.610,0
        </coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>Start</name>
      <Point><coordinates>10.370,46.470,0</coordinates></Point>
    </Placemark>
  </Document>
</kml>`;

describe("parseImportedRoute", () => {
  it("parses a GPX track with multiple trkpt elements", () => {
    const result = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.sourceFormat).toBe("gpx");
    expect(result.route.name).toBe("Stelvio loop");
    expect(result.route.points.length).toBe(8);
    expect(result.route.points[0]).toEqual([10.37, 46.47]);
    expect(result.route.totalDistanceKm).toBeGreaterThan(10);
  });

  it("falls back to route points when no track is present", () => {
    const result = parseImportedRoute(GPX_ROUTE_WITH_WPTS, "loop.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.points).toHaveLength(3);
    expect(result.route.waypoints).toHaveLength(2);
    expect(result.route.waypoints[0]).toMatchObject({
      name: "Bormio",
      lat: 46.47,
      lng: 10.37,
    });
  });

  it("parses a KML LineString and collects Point Placemarks as waypoints", () => {
    const result = parseImportedRoute(KML_LINESTRING, "alps.kml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.sourceFormat).toBe("kml");
    expect(result.route.name).toBe("Alps ride");
    expect(result.route.points).toEqual([
      [10.37, 46.47],
      [10.41, 46.5],
      [10.47, 46.54],
      [10.57, 46.61],
    ]);
    expect(result.route.waypoints).toEqual([
      { name: "Start", lat: 46.47, lng: 10.37 },
    ]);
  });

  it("detects format from content when the extension is missing", () => {
    const result = parseImportedRoute(GPX_TRACK, "untitled");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.sourceFormat).toBe("gpx");
  });

  it("rejects empty input", () => {
    const result = parseImportedRoute("   ", "empty.gpx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it("rejects unsupported formats", () => {
    const result = parseImportedRoute("hello world", "notes.txt");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed XML", () => {
    const result = parseImportedRoute("<gpx><trk><trkseg></gpx>", "bad.gpx");
    expect(result.ok).toBe(false);
  });

  it("rejects GPX files with no track or route points", () => {
    const result = parseImportedRoute(
      '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Empty</name></metadata></gpx>',
      "empty.gpx",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no track or route/i);
  });

  it("skips trkpt elements with invalid coordinates", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="91" lon="10"/>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(gpx, "fixtures.gpx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.points).toHaveLength(2);
  });

  it("uses the filename stem as a fallback name", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(gpx, "my_epic-ride.gpx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.name).toBe("my epic ride");
  });
});

describe("pointsDistanceKm", () => {
  it("computes haversine distance across a polyline", () => {
    const km = pointsDistanceKm([
      [10.37, 46.47],
      [10.57, 46.61],
    ]);
    expect(km).toBeGreaterThan(20);
    expect(km).toBeLessThan(25);
  });

  it("returns zero for a single point", () => {
    expect(pointsDistanceKm([[10, 46]])).toBe(0);
  });
});

describe("importedRouteToTrip", () => {
  it("converts an imported route into a single-day Trip with segments", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const trip = importedRouteToTrip(parsed.route);

    expect(trip.status).toBe("draft");
    expect(trip.name).toBe("Stelvio loop");
    expect(trip.days).toHaveLength(1);

    const day = trip.days[0];
    expect(day.dayNumber).toBe(1);
    expect(day.distanceKm).toBeGreaterThan(10);
    expect(day.routeGeometry?.type).toBe("LineString");
    expect(day.routeGeometry?.coordinates).toHaveLength(8);

    // Start and end waypoints always present.
    expect(day.waypoints[0].type).toBe("start");
    expect(day.waypoints[day.waypoints.length - 1].type).toBe("end");

    const segments = day.segments ?? [];
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.length).toBeLessThanOrEqual(20);
    for (const seg of segments) {
      expect(seg.qualityScore).toBeGreaterThanOrEqual(2);
      expect(seg.qualityScore).toBeLessThanOrEqual(5);
      expect(seg.surfaceType).toBe("asphalt");
      expect(seg.dayNumber).toBe(1);
    }
  });

  it("produces the same segment quality scores for the same input", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const a = importedRouteToTrip(parsed.route);
    const b = importedRouteToTrip(parsed.route);
    const scoresA = (a.days[0].segments ?? []).map((s) => s.qualityScore);
    const scoresB = (b.days[0].segments ?? []).map((s) => s.qualityScore);
    expect(scoresA).toEqual(scoresB);
  });

  it("filters vias that coincide with the start/end coordinates", () => {
    const parsed = parseImportedRoute(GPX_ROUTE_WITH_WPTS, "loop.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const trip = importedRouteToTrip(parsed.route);
    const wps = trip.days[0].waypoints;
    // Bormio and Prato are co-located with start/end — should be deduped.
    expect(wps.filter((w) => w.name === "Bormio")).toHaveLength(1);
    expect(wps.filter((w) => w.name === "Prato")).toHaveLength(1);
    expect(wps.find((w) => w.type === "start")?.name).toBe("Bormio");
    expect(wps.find((w) => w.type === "end")?.name).toBe("Prato");
  });

  it("estimates duration at roughly 55 km/h average with a 30-minute floor", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const trip = importedRouteToTrip(parsed.route);
    const day = trip.days[0];
    const projected = Math.round((day.distanceKm / 55) * 60);
    expect(day.durationMinutes).toBe(Math.max(30, projected));
  });
});
