import { Datex2ParserService } from './datex2-parser.service.js';

/**
 * Synthetic DATEX II v2.3-shaped snapshot. NOT a real NDIC payload — it
 * exercises the parser's structure (a coordinate-linear closure and an
 * Alert-C-only record needing decoding). Replace/augment with a real
 * fixture once NDIC credentials exist, then tune classifyRecord /
 * extractGeometry against it.
 */
const SNAPSHOT = `<?xml version="1.0" encoding="UTF-8"?>
<d2:d2LogicalModel xmlns:d2="http://datex2.eu/schema/2/2_0">
  <d2:payloadPublication>
    <d2:situation id="SIT-1">
      <d2:situationRecord id="REC-1" xsi:type="RoadOrCarriagewayOrLaneManagement">
        <d2:validity>
          <d2:validityStatus>active</d2:validityStatus>
          <d2:validityTimeSpecification>
            <d2:overallStartTime>2026-06-29T08:00:00Z</d2:overallStartTime>
            <d2:overallEndTime>2026-06-30T18:00:00Z</d2:overallEndTime>
          </d2:validityTimeSpecification>
        </d2:validity>
        <d2:generalPublicComment>
          <d2:comment><d2:values><d2:value>Full closure on D1 near Brno</d2:value></d2:values></d2:comment>
        </d2:generalPublicComment>
        <d2:roadOrCarriagewayOrLaneManagementType>carriagewayClosed</d2:roadOrCarriagewayOrLaneManagementType>
        <d2:groupOfLocations>
          <d2:gmlLineString>
            <d2:posList>49.20 16.60 49.25 16.70</d2:posList>
          </d2:gmlLineString>
        </d2:groupOfLocations>
      </d2:situationRecord>
    </d2:situation>
    <d2:situation id="SIT-2">
      <d2:situationRecord id="REC-2" xsi:type="MaintenanceWorks">
        <d2:generalPublicComment>
          <d2:comment><d2:values><d2:value>Roadworks, single lane</d2:value></d2:values></d2:comment>
        </d2:generalPublicComment>
        <d2:groupOfLocations>
          <d2:alertCLinear>
            <d2:alertCLocationName>D1 km 190-195</d2:alertCLocationName>
          </d2:alertCLinear>
        </d2:groupOfLocations>
      </d2:situationRecord>
    </d2:situation>
  </d2:payloadPublication>
</d2:d2LogicalModel>`;

describe('Datex2ParserService', () => {
  const parser = new Datex2ParserService();

  it('returns one normalized situation per record', () => {
    const out = parser.parse(SNAPSHOT);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.externalId)).toEqual(['REC-1', 'REC-2']);
  });

  it('parses a coordinate closure into a lon/lat LineString and window', () => {
    const [closure] = parser.parse(SNAPSHOT);
    expect(closure!.reason).toBe('closure');
    expect(closure!.severity).toBe('full');
    expect(closure!.needsLocationDecoding).toBe(false);
    // GML posList is "lat lon" → GeoJSON is [lon, lat].
    expect(closure!.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.25],
      ],
    });
    expect(closure!.startsAt?.toISOString()).toBe('2026-06-29T08:00:00.000Z');
    expect(closure!.endsAt?.toISOString()).toBe('2026-06-30T18:00:00.000Z');
    expect(closure!.title).toBe('Full closure on D1 near Brno');
  });

  it('flags an Alert-C-only record for decoding with no geometry', () => {
    const [, works] = parser.parse(SNAPSHOT);
    expect(works!.reason).toBe('roadworks');
    expect(works!.geometry).toBeNull();
    expect(works!.needsLocationDecoding).toBe(true);
    expect(works!.rawLocationRef).not.toBeNull();
  });

  it('throws (does not return []) when the envelope is unrecognizable', () => {
    // A 200 that is auth/proxy HTML or a wrong profile must NOT look like
    // a verified-empty snapshot — otherwise reconcile would deactivate
    // every official closure.
    expect(() =>
      parser.parse('<html><body>Login required</body></html>'),
    ).toThrow(/Unrecognized NAP snapshot/);
  });

  it('steps a 3D posList by its srsDimension (height does not bleed in)', () => {
    const xml = `<?xml version="1.0"?>
      <d2:d2LogicalModel xmlns:d2="http://datex2.eu/schema/2/2_0">
        <d2:payloadPublication>
          <d2:situation id="S">
            <d2:situationRecord id="R" xsi:type="RoadOrCarriagewayOrLaneManagement">
              <d2:roadOrCarriagewayOrLaneManagementType>carriagewayClosed</d2:roadOrCarriagewayOrLaneManagementType>
              <d2:groupOfLocations>
                <d2:gmlLineString>
                  <d2:posList srsDimension="3">49.20 16.60 300 49.25 16.70 310</d2:posList>
                </d2:gmlLineString>
              </d2:groupOfLocations>
            </d2:situationRecord>
          </d2:situation>
        </d2:payloadPublication>
      </d2:d2LogicalModel>`;
    const [rec] = parser.parse(xml);
    expect(rec!.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.25],
      ],
    });
  });

  it('classifies a lane closure as partial, not full (lane cue wins over "closed")', () => {
    const xml = `<?xml version="1.0"?>
      <d2:d2LogicalModel xmlns:d2="http://datex2.eu/schema/2/2_0">
        <d2:payloadPublication>
          <d2:situation id="S">
            <d2:situationRecord id="R" xsi:type="MaintenanceWorks">
              <d2:generalPublicComment>
                <d2:comment><d2:values><d2:value>Right lane closed for resurfacing</d2:value></d2:values></d2:comment>
              </d2:generalPublicComment>
              <d2:groupOfLocations>
                <d2:gmlLineString><d2:posList>49.20 16.60 49.25 16.70</d2:posList></d2:gmlLineString>
              </d2:groupOfLocations>
            </d2:situationRecord>
          </d2:situation>
        </d2:payloadPublication>
      </d2:d2LogicalModel>`;
    const [rec] = parser.parse(xml);
    expect(rec!.severity).toBe('partial');
  });

  it('builds a line from linear start+end points (not a zero-length stub)', () => {
    const xml = `<?xml version="1.0"?>
      <d2:d2LogicalModel xmlns:d2="http://datex2.eu/schema/2/2_0">
        <d2:payloadPublication>
          <d2:situation id="S">
            <d2:situationRecord id="R" xsi:type="MaintenanceWorks">
              <d2:groupOfLocations>
                <d2:linearByCoordinatesExtension>
                  <d2:linearCoordinatesStartPoint>
                    <d2:pointCoordinates><d2:latitude>49.20</d2:latitude><d2:longitude>16.60</d2:longitude></d2:pointCoordinates>
                  </d2:linearCoordinatesStartPoint>
                  <d2:linearCoordinatesEndPoint>
                    <d2:pointCoordinates><d2:latitude>49.25</d2:latitude><d2:longitude>16.70</d2:longitude></d2:pointCoordinates>
                  </d2:linearCoordinatesEndPoint>
                </d2:linearByCoordinatesExtension>
              </d2:groupOfLocations>
            </d2:situationRecord>
          </d2:situation>
        </d2:payloadPublication>
      </d2:d2LogicalModel>`;
    const [rec] = parser.parse(xml);
    expect(rec!.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.25],
      ],
    });
  });

  it('returns [] for a genuine publication with zero situations', () => {
    const empty = `<?xml version="1.0"?>
      <d2:d2LogicalModel xmlns:d2="http://datex2.eu/schema/2/2_0">
        <d2:payloadPublication/>
      </d2:d2LogicalModel>`;
    expect(parser.parse(empty)).toEqual([]);
  });
});
