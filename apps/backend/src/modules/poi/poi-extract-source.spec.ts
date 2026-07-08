import { Readable } from 'node:stream';
import { parsePoiExtract } from './poi-extract-source.js';
import type {
  AccommodationPoi,
  ImportedPoi,
} from './poi-provider.interface.js';

type PoiResult = { poi: ImportedPoi } | { accommodation: AccommodationPoi };

function streamOf(xml: string): Readable {
  return Readable.from([xml]);
}

async function collect(xml: string): Promise<PoiResult[]> {
  const out: PoiResult[] = [];
  for await (const r of parsePoiExtract(streamOf(xml))) out.push(r);
  return out;
}

/** Flatten a result to a comparable summary regardless of its variant. */
function summarize(r: PoiResult): {
  type: 'poi' | 'accommodation';
  kind: string;
  external_id: string;
  lat: number;
  lng: number;
} {
  const row = 'poi' in r ? r.poi : r.accommodation;
  return {
    type: 'poi' in r ? 'poi' : 'accommodation',
    kind: row.kind,
    external_id: row.external_id,
    lat: row.lat,
    lng: row.lng,
  };
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="49.5" lon="18.4">
    <tag k="amenity" v="fuel"/>
    <tag k="name" v="OMV"/>
  </node>
  <node id="2" lat="49.6" lon="18.5"/>
  <node id="3" lat="49.7" lon="18.6">
    <tag k="tourism" v="hotel"/>
    <tag k="stars" v="4"/>
  </node>
</osm>`;

describe('parsePoiExtract', () => {
  it('yields POIs and accommodations in document order, ignoring untagged nodes', async () => {
    const results = await collect(SAMPLE);

    expect(results.map(summarize)).toEqual([
      {
        type: 'poi',
        kind: 'fuel_station',
        external_id: 'osm:node:1',
        lat: 49.5,
        lng: 18.4,
      },
      {
        type: 'accommodation',
        kind: 'hotel',
        external_id: 'osm:node:3',
        lat: 49.7,
        lng: 18.6,
      },
    ]);
  });

  it('carries the full mapped row (tags, hours, stars)', async () => {
    const [first, second] = await collect(SAMPLE);
    if (
      !first ||
      !('poi' in first) ||
      !second ||
      !('accommodation' in second)
    ) {
      throw new Error('expected a POI then an accommodation');
    }
    expect(first.poi.name).toBe('OMV');
    expect(first.poi.tags).toMatchObject({ amenity: 'fuel' });
    expect(second.accommodation.stars).toBe(4);
  });

  it('ignores a document of purely untagged (geometry) nodes', async () => {
    const results = await collect(`<osm>
      <node id="1" lat="1" lon="1"/>
      <node id="2" lat="2" lon="2"/>
    </osm>`);
    expect(results).toEqual([]);
  });

  it('reduces a tagged way to the centroid of its resolved nodes', async () => {
    const results = await collect(`<osm>
      <node id="1" lat="0" lon="0"/>
      <node id="2" lat="0" lon="2"/>
      <node id="3" lat="2" lon="2"/>
      <node id="4" lat="2" lon="0"/>
      <way id="100">
        <nd ref="1"/>
        <nd ref="2"/>
        <nd ref="3"/>
        <nd ref="4"/>
        <tag k="amenity" v="restaurant"/>
        <tag k="name" v="Panorama"/>
      </way>
    </osm>`);

    expect(results.map(summarize)).toEqual([
      {
        type: 'poi',
        kind: 'restaurant',
        external_id: 'osm:way:100',
        // Mean of the four square corners.
        lat: 1,
        lng: 1,
      },
    ]);
  });

  it('skips a tagged way whose nodes are missing or fewer than two', async () => {
    const results = await collect(`<osm>
      <node id="1" lat="0" lon="0"/>
      <way id="100">
        <nd ref="1"/>
        <nd ref="2"/>
        <tag k="amenity" v="cafe"/>
      </way>
      <way id="101">
        <nd ref="1"/>
        <tag k="amenity" v="cafe"/>
      </way>
    </osm>`);
    // Way 100 references an absent node 2; way 101 resolves only one point.
    expect(results).toEqual([]);
  });

  it('reduces a multipolygon relation to the centroid of its member ways', async () => {
    // A hotel mapped as an area: an untagged member way (the building outline)
    // whose four nodes form a box, with the POI tags on the relation. The
    // relation must yield one accommodation at the box centroid; the untagged
    // member way must not yield a POI of its own.
    const results = await collect(`<osm>
      <node id="1" lat="0" lon="0"/>
      <node id="2" lat="0" lon="2"/>
      <node id="3" lat="2" lon="2"/>
      <node id="4" lat="2" lon="0"/>
      <way id="100">
        <nd ref="1"/>
        <nd ref="2"/>
        <nd ref="3"/>
        <nd ref="4"/>
      </way>
      <relation id="500">
        <member type="way" ref="100" role="outer"/>
        <tag k="tourism" v="hotel"/>
        <tag k="name" v="Grand"/>
        <tag k="stars" v="5"/>
      </relation>
    </osm>`);

    expect(results.map(summarize)).toEqual([
      {
        type: 'accommodation',
        kind: 'hotel',
        external_id: 'osm:relation:500',
        lat: 1,
        lng: 1,
      },
    ]);
    const [only] = results;
    if (!only || !('accommodation' in only)) {
      throw new Error('expected an accommodation');
    }
    expect(only.accommodation.name).toBe('Grand');
    expect(only.accommodation.stars).toBe(5);
  });

  it('averages direct node members with member-way nodes (best-effort resolve)', async () => {
    // A relation whose members are a direct node plus a member way; a second
    // member way is missing entirely and simply drops out of the average.
    const results = await collect(`<osm>
      <node id="1" lat="0" lon="0"/>
      <node id="2" lat="0" lon="4"/>
      <node id="3" lat="4" lon="4"/>
      <node id="4" lat="4" lon="0"/>
      <node id="9" lat="10" lon="10"/>
      <way id="100">
        <nd ref="1"/>
        <nd ref="2"/>
        <nd ref="3"/>
        <nd ref="4"/>
      </way>
      <relation id="500">
        <member type="way" ref="100" role="outer"/>
        <member type="way" ref="404" role="outer"/>
        <member type="node" ref="9" role="label"/>
        <tag k="tourism" v="camp_site"/>
      </relation>
    </osm>`);

    // Coords: way 100's four corners (0,0)(0,4)(4,4)(4,0) + node 9 (10,10);
    // way 404 is absent and ignored. Mean lat = (0+0+4+4+10)/5 = 3.6,
    // mean lng = (0+4+4+0+10)/5 = 3.6.
    expect(results.map(summarize)).toEqual([
      {
        type: 'accommodation',
        kind: 'camp_site',
        external_id: 'osm:relation:500',
        lat: 3.6,
        lng: 3.6,
      },
    ]);
  });

  it('skips a relation whose members resolve to no coordinates', async () => {
    const results = await collect(`<osm>
      <relation id="500">
        <member type="way" ref="999" role="outer"/>
        <member type="node" ref="888" role="label"/>
        <tag k="tourism" v="hotel"/>
      </relation>
    </osm>`);
    // Neither the member way nor the member node exists in the extract.
    expect(results).toEqual([]);
  });

  it('interleaves node, way and relation POIs in document order', async () => {
    const results = await collect(`<osm>
      <node id="1" lat="49.5" lon="18.4">
        <tag k="amenity" v="fuel"/>
      </node>
      <node id="10" lat="0" lon="0"/>
      <node id="11" lat="0" lon="2"/>
      <node id="12" lat="2" lon="2"/>
      <node id="13" lat="2" lon="0"/>
      <way id="100">
        <nd ref="10"/>
        <nd ref="11"/>
        <nd ref="12"/>
        <nd ref="13"/>
        <tag k="amenity" v="restaurant"/>
      </way>
      <relation id="500">
        <member type="way" ref="100" role="outer"/>
        <tag k="tourism" v="camp_site"/>
      </relation>
    </osm>`);

    // A tagged member way is both a standalone POI (its own centroid) and part
    // of the relation's centroid — confirming way refs are buffered for tagged
    // ways too, and that emission order follows the document.
    expect(results.map((r) => summarize(r).external_id)).toEqual([
      'osm:node:1',
      'osm:way:100',
      'osm:relation:500',
    ]);
    expect(results.map((r) => summarize(r).kind)).toEqual([
      'fuel_station',
      'restaurant',
      'camp_site',
    ]);
  });

  it('rejects malformed XML', async () => {
    await expect(collect('<osm><node id="1" <<>')).rejects.toBeDefined();
  });

  it('fails fast on a parse error without first draining buffered rows', async () => {
    // The whole single-chunk document (two valid POI nodes + a malformed tail)
    // is parsed before the first pull, so both rows and the error are buffered.
    // The first `.next()` must reject rather than yield the buffered POIs.
    const iterator = parsePoiExtract(
      streamOf(
        '<osm>' +
          '<node id="1" lat="1" lon="1"><tag k="amenity" v="fuel"/></node>' +
          '<node id="2" lat="2" lon="2"><tag k="amenity" v="cafe"/></node>' +
          '<oops',
      ),
    );

    await expect(iterator.next()).rejects.toBeDefined();
  });

  it('destroys the source when the consumer abandons iteration early', async () => {
    const input = streamOf(SAMPLE);
    const iterator = parsePoiExtract(input);

    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Simulate an early exit (e.g. a downstream upsert throwing mid-stream).
    await iterator.return(undefined);

    expect(input.destroyed).toBe(true);
  });
});
