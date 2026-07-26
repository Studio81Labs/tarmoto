import { describe, expect, it, vi } from "vitest";
import {
  importErrorMessage,
  importedRouteToTrip as importedRouteToTripWithTranslate,
  parseImportedRoute,
  pointsDistanceKm,
} from "../gpx-kml-import";
import { createFormatters } from "@tarmoto/shared";
import { t as englishTranslate, type Translate } from "@/i18n";

const defaultFormat = createFormatters({ locale: "en", units: "metric" });
const importedRouteToTrip = (
  route: Parameters<typeof importedRouteToTripWithTranslate>[0],
  format = defaultFormat,
  translate: Translate = englishTranslate,
) => importedRouteToTripWithTranslate(route, format, translate);

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
    if (!result.ok) expect(result.error).toBe("empty_file");
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
    if (!result.ok) expect(result.error).toBe("gpx_without_route");
  });

  it("translates parser error codes at the display boundary", () => {
    expect(importErrorMessage("invalid_xml", (key) => `XX ${key}`)).toBe(
      "XX File is not valid XML.",
    );
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

  it("parses Garmin/Komoot GPX files with `gpx:` namespace prefixes", () => {
    // Real-world Garmin Connect / Komoot exports prefix every structural
    // tag with `gpx:` because they declare GPX 1.1 with a non-default
    // namespace. The shared parser must accept the prefixed form so the
    // companion-side import surface keeps working unchanged.
    const xml = `<?xml version="1.0"?>
<gpx:gpx version="1.1" xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:metadata><gpx:name>Stelvio loop</gpx:name></gpx:metadata>
  <gpx:trk>
    <gpx:name>Stelvio loop</gpx:name>
    <gpx:trkseg>
      <gpx:trkpt lat="46.47" lon="10.37"/>
      <gpx:trkpt lat="46.50" lon="10.41"/>
      <gpx:trkpt lat="46.61" lon="10.57"/>
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`;
    const result = parseImportedRoute(xml, "namespaced.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.name).toBe("Stelvio loop");
    expect(result.route.points).toHaveLength(3);
  });

  it("parses KML files with `kml:` namespace prefixes", () => {
    const xml = `<?xml version="1.0"?>
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2">
  <kml:Document>
    <kml:name>Alps</kml:name>
    <kml:Placemark>
      <kml:LineString><kml:coordinates>
        10.37,46.47,0 10.41,46.50,0 10.57,46.61,0
      </kml:coordinates></kml:LineString>
    </kml:Placemark>
  </kml:Document>
</kml:kml>`;
    const result = parseImportedRoute(xml, "namespaced.kml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.name).toBe("Alps");
    expect(result.route.points).toHaveLength(3);
  });

  it("accepts files with self-closing structural tags (e.g. empty <rte/>)", () => {
    // GPX exports from BaseCamp / Calimoto sometimes include an empty
    // self-closing `<rte/>` alongside the populated `<trk>`. Earlier
    // revisions treated the lone `<rte` as an unmatched open and
    // rejected the file as "not valid XML".
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <rte/>
  <trk>
    <name>Loop</name>
    <trkseg>
      <trkpt lat="46.47" lon="10.37"/>
      <trkpt lat="46.50" lon="10.41"/>
    </trkseg>
  </trk>
</gpx>`;
    const result = parseImportedRoute(xml, "with-empty-rte.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.name).toBe("Loop");
    expect(result.route.points).toHaveLength(2);
  });

  it("picks the track-level <name>, not a nested point name", () => {
    // Earlier "first match anywhere in subtree" `childText` would have
    // returned "Trailhead" (the first <name> in the <trk> body). The
    // direct-child walker must skip the <trkpt> subtree and pick up the
    // track-level name that follows it.
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
      <trkpt lat="46.47" lon="10.37"><name>Trailhead</name></trkpt>
      <trkpt lat="46.50" lon="10.41"><name>Junction</name></trkpt>
    </trkseg>
    <name>Real track name</name>
  </trk>
</gpx>`;
    const result = parseImportedRoute(xml, "nested-names.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.name).toBe("Real track name");
  });

  it("doesn't lose the track <name> when a self-closing child precedes it", () => {
    // Garmin Connect emits `<extensions/>` and Strava emits `<link
    // href="..."/>` inside `<trk>`. Earlier revisions of the direct-
    // child walker had a greedy attrs regex that swallowed the trailing
    // `/`, so these self-closes were misclassified as regular open
    // tags; the depth-skip path then walked off the end of `<trk>`
    // looking for the missing close, dropped the rest of the body,
    // and the track's `<name>` was never found.
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <extensions/>
    <link href="https://example.com/route"/>
    <name>Real track name</name>
    <trkseg>
      <trkpt lat="46.47" lon="10.37"/>
      <trkpt lat="46.50" lon="10.41"/>
    </trkseg>
  </trk>
</gpx>`;
    const result = parseImportedRoute(xml, "with-self-closing-children.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.name).toBe("Real track name");
    expect(result.route.points).toHaveLength(2);
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
    if (!day) throw new Error("expected a day");
    expect(day.dayNumber).toBe(1);
    expect(day.distanceKm).toBeGreaterThan(10);
    expect(day.routeGeometry?.type).toBe("LineString");
    expect(day.routeGeometry?.coordinates).toHaveLength(8);

    // Start and end waypoints always present.
    const firstWp = day.waypoints[0];
    const lastWp = day.waypoints[day.waypoints.length - 1];
    if (!firstWp || !lastWp) throw new Error("expected start/end waypoints");
    expect(firstWp.type).toBe("start");
    expect(lastWp.type).toBe("end");

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

  it("catalogs and converts the generated import description", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const format = createFormatters({ locale: "en-US", units: "imperial" });
    const t = vi.fn(
      (key: string, values?: Record<string, string | number>) =>
        `XX ${String(values?.format)} / ${String(values?.distance)} [${key}]`,
    );

    const trip = importedRouteToTrip(parsed.route, format, t);

    expect(trip.description).toMatch(
      /^XX GPX \/ \d+(?:\.\d)? mi \[Imported from \{format\} · \{distance\}\]$/,
    );
  });

  it("produces the same segment quality scores for the same input", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const a = importedRouteToTrip(parsed.route);
    const b = importedRouteToTrip(parsed.route);
    const dayA = a.days[0];
    const dayB = b.days[0];
    if (!dayA || !dayB) throw new Error("expected a day");
    const scoresA = (dayA.segments ?? []).map((s) => s.qualityScore);
    const scoresB = (dayB.segments ?? []).map((s) => s.qualityScore);
    expect(scoresA).toEqual(scoresB);
  });

  it("filters vias that coincide with the start/end coordinates", () => {
    const parsed = parseImportedRoute(GPX_ROUTE_WITH_WPTS, "loop.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const trip = importedRouteToTrip(parsed.route);
    const day = trip.days[0];
    if (!day) throw new Error("expected a day");
    const wps = day.waypoints;
    // Bormio and Prato are co-located with start/end — should be deduped.
    expect(wps.filter((w) => w.name === "Bormio")).toHaveLength(1);
    expect(wps.filter((w) => w.name === "Prato")).toHaveLength(1);
    expect(wps.find((w) => w.type === "start")?.name).toBe("Bormio");
    expect(wps.find((w) => w.type === "end")?.name).toBe("Prato");
  });

  it("marks imported names as source-owned even when they match legacy roles", () => {
    const parsed = parseImportedRoute(KML_LINESTRING, "alps.kml");
    if (!parsed.ok) throw new Error("parse failed");

    const start = importedRouteToTrip(parsed.route).days[0]?.waypoints.find(
      (waypoint) => waypoint.type === "start",
    );

    expect(start).toMatchObject({
      name: "Start",
      nameIsSource: true,
      type: "start",
    });
  });

  it("does not adopt mid-route waypoint names for start/end", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="46.52" lon="10.43"><name>Scenic viewpoint</name></wpt>
  <trk><trkseg>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
    <trkpt lat="46.52" lon="10.43"/>
    <trkpt lat="46.55" lon="10.47"/>
    <trkpt lat="46.60" lon="10.55"/>
  </trkseg></trk>
</gpx>`;
    const parsed = parseImportedRoute(gpx, "loop.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const trip = importedRouteToTrip(parsed.route);
    const day = trip.days[0];
    if (!day) throw new Error("expected a day");
    const wps = day.waypoints;
    // Mid-route waypoint must not be promoted to start/end…
    expect(wps.find((w) => w.type === "start")?.name).toBeUndefined();
    expect(wps.find((w) => w.type === "end")?.name).toBeUndefined();
    // …and should survive as a via with its actual name.
    const vias = wps.filter((w) => w.type === "via");
    expect(vias).toHaveLength(1);
    expect(vias[0]?.name).toBe("Scenic viewpoint");
  });

  it("estimates duration at roughly 55 km/h average with a 30-minute floor", () => {
    const parsed = parseImportedRoute(GPX_TRACK, "stelvio.gpx");
    if (!parsed.ok) throw new Error("parse failed");
    const trip = importedRouteToTrip(parsed.route);
    const day = trip.days[0];
    if (!day) throw new Error("expected a day");
    const projected = Math.round((day.distanceKm / 55) * 60);
    expect(day.durationMinutes).toBe(Math.max(30, projected));
  });
});
