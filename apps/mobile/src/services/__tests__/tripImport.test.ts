// The picker ships ESM that jest can't transform out of the box, and
// react-native-fs hits the native module on import. Stub both at the
// module boundary — these tests exercise the pure-JS conversion path
// (`parseImportedRoute`, `routeToImportRequest`), not the picker
// integration itself.
jest.mock("@react-native-documents/picker", () => ({
  pick: jest.fn(),
  errorCodes: { OPERATION_CANCELED: "DOCUMENT_PICKER_CANCELED" },
  isErrorWithCode: () => false,
  types: { allFiles: "*/*" },
}));
jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: {
    TemporaryDirectoryPath: "/tmp",
    readFile: jest.fn().mockResolvedValue(""),
    stat: jest.fn().mockResolvedValue({ size: 0 }),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

import { parseImportedRoute } from "@tarmoto/shared";
import { pick } from "@react-native-documents/picker";
import RNFS from "react-native-fs";
import {
  pickAndParseRoute,
  routeToImportRequest,
  type TripImportOutcome,
} from "../tripImport";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

const mockedPick = pick as jest.Mock;
const mockedReadFile = RNFS.readFile as jest.Mock;
const mockedStat = RNFS.stat as jest.Mock;
const mockedKillSwitch = isFeatureKillSwitchActive as jest.Mock;

describe("parseImportedRoute (mobile entry)", () => {
  it("parses a typical Garmin GPX track", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Stelvio loop</name></metadata>
  <trk><name>Stelvio loop</name><trkseg>
    <trkpt lat="46.470000" lon="10.370000"/>
    <trkpt lat="46.500000" lon="10.410000"/>
    <trkpt lat="46.540000" lon="10.470000"/>
    <trkpt lat="46.610000" lon="10.570000"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(xml, "stelvio.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.sourceFormat).toBe("gpx");
    expect(result.route.name).toBe("Stelvio loop");
    expect(result.route.points).toHaveLength(4);
    expect(result.route.totalDistanceKm).toBeGreaterThan(10);
  });

  it("falls back to <rtept> when <trkpt> is absent", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="46.47" lon="10.37"><name>Bormio</name></wpt>
  <wpt lat="46.61" lon="10.57"><name>Prato</name></wpt>
  <rte>
    <rtept lat="46.47" lon="10.37"/>
    <rtept lat="46.54" lon="10.47"/>
    <rtept lat="46.61" lon="10.57"/>
  </rte>
</gpx>`;
    const result = parseImportedRoute(xml, "loop.gpx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.points).toHaveLength(3);
    expect(result.route.waypoints).toHaveLength(2);
  });

  it("parses a KML LineString with the standard namespace", () => {
    const xml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>Alps</name>
    <Placemark><LineString><coordinates>
      10.37,46.47,0 10.41,46.50,0 10.47,46.54,0 10.57,46.61,0
    </coordinates></LineString></Placemark>
    <Placemark><name>Top</name><Point><coordinates>10.47,46.54,0</coordinates></Point></Placemark>
  </Document>
</kml>`;
    const result = parseImportedRoute(xml, "alps.kml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.sourceFormat).toBe("kml");
    expect(result.route.name).toBe("Alps");
    expect(result.route.points).toEqual([
      [10.37, 46.47],
      [10.41, 46.5],
      [10.47, 46.54],
      [10.57, 46.61],
    ]);
    expect(result.route.waypoints).toEqual([
      { name: "Top", lat: 46.54, lng: 10.47 },
    ]);
  });

  it("rejects empty input", () => {
    const result = parseImportedRoute("   ", "empty.gpx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("empty_file");
  });

  it("rejects unrecognised file types", () => {
    expect(parseImportedRoute("plain text", "notes.txt").ok).toBe(false);
  });

  it("rejects malformed XML", () => {
    const result = parseImportedRoute("<gpx><trk><trkseg></gpx>", "broken.gpx");
    expect(result.ok).toBe(false);
  });

  it("rejects a GPX with no track or route points", () => {
    const result = parseImportedRoute(
      '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Empty</name></metadata></gpx>',
      "empty.gpx",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("gpx_without_route");
  });

  it("skips trkpt elements with out-of-range coordinates", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="91" lon="10"/>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(xml, "fixtures.gpx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.points).toHaveLength(2);
  });

  it("parses Garmin/Komoot GPX files with `gpx:` namespace prefixes", () => {
    // Real-world Garmin Connect / Komoot exports prefix every structural
    // tag with `gpx:` because they declare GPX 1.1 with a non-default
    // namespace. The parser must accept the prefixed form or the file
    // imports as "no track or route points".
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
    expect(result.route.sourceFormat).toBe("gpx");
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
    expect(result.route.sourceFormat).toBe("kml");
    expect(result.route.name).toBe("Alps");
    expect(result.route.points).toHaveLength(3);
  });

  it("decodes XML entities in <name>", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Salt &amp; Pepper</name></metadata>
  <trk><trkseg>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(xml, "salt.gpx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.name).toBe("Salt & Pepper");
  });

  it("ignores XML comments around tags", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <!-- Exported by Calimoto on 2026-04-01 -->
  <trk><trkseg>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(xml, "comments.gpx");
    expect(result.ok).toBe(true);
  });

  it("uses the filename stem when no metadata name is present", () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="46.47" lon="10.37"/>
    <trkpt lat="46.50" lon="10.41"/>
  </trkseg></trk>
</gpx>`;
    const result = parseImportedRoute(xml, "my_epic-ride.gpx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.name).toBe("my epic ride");
  });
});

describe("routeToImportRequest", () => {
  const ROUTE = {
    name: "Stelvio loop",
    sourceFormat: "gpx" as const,
    totalDistanceKm: 25,
    points: [
      [10.37, 46.47] as [number, number],
      [10.47, 46.54] as [number, number],
      [10.57, 46.61] as [number, number],
    ],
    waypoints: [{ lat: 46.54, lng: 10.47, name: "Umbrail" }],
  };

  it("maps points to {lat,lng} pairs in input order", () => {
    const req = routeToImportRequest(ROUTE, "Custom title");
    expect(req.title).toBe("Custom title");
    expect(req.source_format).toBe("gpx");
    expect(req.geometry).toEqual([
      { lat: 46.47, lng: 10.37 },
      { lat: 46.54, lng: 10.47 },
      { lat: 46.61, lng: 10.57 },
    ]);
    expect(req.waypoints).toEqual([
      { lat: 46.54, lng: 10.47, name: "Umbrail" },
    ]);
  });

  it("falls back to the route's own name when title is blank", () => {
    const req = routeToImportRequest(ROUTE, "  ");
    expect(req.title).toBe("Stelvio loop");
  });

  it("normalises empty region to undefined", () => {
    const req = routeToImportRequest(ROUTE, "Trip", "  ");
    expect(req.region).toBeUndefined();
  });

  it("omits the waypoints array when the route had none", () => {
    const req = routeToImportRequest({ ...ROUTE, waypoints: [] }, "Trip");
    expect(req.waypoints).toBeUndefined();
  });
});

describe("pickAndParseRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedKillSwitch.mockReturnValue(true);
    // RNFS exposes size as a string in production. Mirroring that shape
    // here keeps the size-guard test honest — see the dedicated
    // "rejects an oversized file" case below.
    mockedStat.mockResolvedValue({ size: "1024" });
  });

  it("rejects a file whose stat.size (string) exceeds the 10 MB cap", async () => {
    // Regression guard: an earlier check used `typeof stat.size === "number"`
    // which is always false because RNFS returns a string here. That made
    // the cap effectively no-op and the readFile path was the only barrier
    // against OOMing on an oversized file.
    mockedPick.mockResolvedValue([
      {
        uri: "file:///big.gpx",
        name: "big.gpx",
        type: "application/gpx+xml",
      },
    ]);
    mockedStat.mockResolvedValueOnce({ size: String(20 * 1024 * 1024) });

    const outcome = await pickAndParseRoute();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.cancelled).toBe(false);
    if (outcome.cancelled) return;
    expect(outcome.error).toMatch(/larger than 10 MB/i);
    // readFile should never run — the stat-time guard caught it.
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it("identifies KML payloads via content sniffing when the picker omits the filename", async () => {
    // Some Android providers return URI + MIME but no display name.
    // An earlier version defaulted the filename to `imported.gpx`
    // which forced the parser down the GPX path and failed on KML.
    mockedPick.mockResolvedValue([
      {
        uri: "content://docs/kml-with-no-name",
        name: null,
        type: "application/vnd.google-earth.kml+xml",
      },
    ]);
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>Alps</name>
    <Placemark><LineString><coordinates>
      10.37,46.47,0 10.41,46.50,0 10.57,46.61,0
    </coordinates></LineString></Placemark>
  </Document>
</kml>`;
    mockedReadFile.mockResolvedValue(kml);

    const outcome = await pickAndParseRoute();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.route.sourceFormat).toBe("kml");
    expect(outcome.route.name).toBe("Alps");
    expect(outcome.route.points).toHaveLength(3);
  });

  it("aborts (silently) before parsing if gpx_import is killed during the pick/read", async () => {
    // The parser-vuln surface is the parse itself, so a kill that lands while
    // the picker/stat/read was awaiting must abort BEFORE parseImportedRoute.
    mockedPick.mockResolvedValue([
      { uri: "file:///r.gpx", name: "r.gpx", type: "application/gpx+xml" },
    ]);
    mockedReadFile.mockResolvedValue(
      `<?xml version="1.0"?><gpx><trk><trkseg>` +
        `<trkpt lat="46.4" lon="10.3"/><trkpt lat="46.5" lon="10.4"/>` +
        `</trkseg></trk></gpx>`,
    );
    // Switch is on through pick/read, then flips off just before the parse.
    mockedKillSwitch.mockReturnValue(false);

    const outcome = await pickAndParseRoute();

    // Silent cancel — no error surfaced to the rider.
    expect(outcome).toEqual({ ok: false, cancelled: true });
  });
});

describe("TripImportOutcome", () => {
  // Type-only smoke test — guarantees the tagged-union narrowing the
  // call sites rely on stays well-formed across refactors.
  it("narrows on `cancelled`", () => {
    const cancelled: TripImportOutcome = { ok: false, cancelled: true };
    const errored: TripImportOutcome = {
      ok: false,
      cancelled: false,
      error: "boom",
    };
    expect(cancelled.ok).toBe(false);
    if (errored.ok) throw new Error("should be a failure");
    if (errored.cancelled) throw new Error("should not be cancelled");
    expect(errored.error).toBe("boom");
  });
});
