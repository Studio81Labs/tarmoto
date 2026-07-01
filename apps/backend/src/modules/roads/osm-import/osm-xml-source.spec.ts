import { Readable } from 'node:stream';
import { parseOsmXml } from './osm-xml-source.js';
import { assembleWays, type OsmPrimitive } from './osm-assemble.js';
import type { OsmWay } from './segment-rows.js';

function streamOf(xml: string): Readable {
  return Readable.from([xml]);
}

async function collect(xml: string): Promise<OsmPrimitive[]> {
  const out: OsmPrimitive[] = [];
  for await (const p of parseOsmXml(streamOf(xml))) out.push(p);
  return out;
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="50.0" lon="14.0"/>
  <node id="2" lat="50.1" lon="14.1">
    <tag k="barrier" v="gate"/>
  </node>
  <node id="3" lat="50.2" lon="14.2"/>
  <way id="100">
    <nd ref="1"/>
    <nd ref="2"/>
    <nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="surface" v="asphalt"/>
    <tag k="name" v="Hlavní"/>
  </way>
</osm>`;

describe('parseOsmXml', () => {
  it('emits nodes (with coordinates) and ways (with refs + tags)', async () => {
    const primitives = await collect(SAMPLE);

    expect(primitives).toEqual([
      { type: 'node', id: '1', lat: 50.0, lon: 14.0 },
      { type: 'node', id: '2', lat: 50.1, lon: 14.1 },
      { type: 'node', id: '3', lat: 50.2, lon: 14.2 },
      {
        type: 'way',
        id: '100',
        tags: { highway: 'residential', surface: 'asphalt', name: 'Hlavní' },
        refs: ['1', '2', '3'],
      },
    ]);
  });

  it('ignores node tags (only way tags flow downstream)', async () => {
    const [, node2] = await collect(SAMPLE);
    expect(node2).toEqual({ type: 'node', id: '2', lat: 50.1, lon: 14.1 });
  });

  it('handles multiple ways and preserves document order', async () => {
    const primitives = await collect(`<osm>
      <node id="1" lat="1" lon="1"/>
      <node id="2" lat="2" lon="2"/>
      <way id="10"><nd ref="1"/><nd ref="2"/></way>
      <way id="11"><nd ref="2"/><nd ref="1"/></way>
    </osm>`);

    expect(primitives.map((p) => `${p.type}:${p.id}`)).toEqual([
      'node:1',
      'node:2',
      'way:10',
      'way:11',
    ]);
  });

  it('rejects malformed XML', async () => {
    await expect(collect('<osm><node id="1" <<>')).rejects.toBeDefined();
  });

  it('fails fast on a parse error without first draining buffered primitives', async () => {
    // The whole single-chunk document (two valid nodes + malformed tail) is
    // parsed before the first pull, so both nodes and the error are buffered.
    // The first `.next()` must reject rather than yield the buffered nodes.
    const iterator = parseOsmXml(
      streamOf(
        '<osm><node id="1" lat="1" lon="1"/><node id="2" lat="2" lon="2"/><oops',
      ),
    );

    await expect(iterator.next()).rejects.toBeDefined();
  });

  it('skips a node missing id/coordinates and a way missing id', async () => {
    const primitives = await collect(`<osm>
      <node lat="1" lon="1"/>
      <node id="5" lat="2"/>
      <node id="6" lat="3" lon="3"/>
      <way><nd ref="6"/></way>
      <way id="20"><nd ref="6"/></way>
    </osm>`);

    // Only the fully-specified node and the id-bearing way survive.
    expect(primitives).toEqual([
      { type: 'node', id: '6', lat: 3, lon: 3 },
      { type: 'way', id: '20', tags: {}, refs: ['6'] },
    ]);
  });

  it('feeds assembleWays end-to-end (XML → resolved OsmWay)', async () => {
    const ways: OsmWay[] = [];
    for await (const way of assembleWays(parseOsmXml(streamOf(SAMPLE)))) {
      ways.push(way);
    }

    expect(ways).toHaveLength(1);
    expect(ways[0]).toEqual({
      id: '100',
      tags: { highway: 'residential', surface: 'asphalt', name: 'Hlavní' },
      coords: [
        { lat: 50.0, lng: 14.0 },
        { lat: 50.1, lng: 14.1 },
        { lat: 50.2, lng: 14.2 },
      ],
    });
  });

  it('destroys the source when the consumer abandons iteration early', async () => {
    const input = streamOf(SAMPLE);
    const iterator = parseOsmXml(input);

    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Simulate an early exit (e.g. a downstream upsert throwing mid-stream).
    await iterator.return(undefined);

    expect(input.destroyed).toBe(true);
  });
});
