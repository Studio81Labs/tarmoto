import { assembleWays, type OsmPrimitive } from './osm-assemble.js';
import type { OsmWay } from './segment-rows.js';

async function collect(primitives: OsmPrimitive[]): Promise<OsmWay[]> {
  const out: OsmWay[] = [];
  for await (const way of assembleWays(primitives)) out.push(way);
  return out;
}

describe('assembleWays', () => {
  it('resolves a way’s node refs into ordered coordinates', async () => {
    const ways = await collect([
      { type: 'node', id: 1, lat: 50.0, lon: 14.0 },
      { type: 'node', id: 2, lat: 50.1, lon: 14.1 },
      { type: 'node', id: 3, lat: 50.2, lon: 14.2 },
      {
        type: 'way',
        id: 100,
        tags: { highway: 'residential' },
        refs: [1, 2, 3],
      },
    ]);

    expect(ways).toHaveLength(1);
    expect(ways[0]).toEqual({
      id: 100,
      tags: { highway: 'residential' },
      coords: [
        { lat: 50.0, lng: 14.0 },
        { lat: 50.1, lng: 14.1 },
        { lat: 50.2, lng: 14.2 },
      ],
    });
  });

  it('resolves refs in ref order, not node-declaration order', async () => {
    const [way] = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      { type: 'node', id: 2, lat: 2, lon: 2 },
      { type: 'way', id: 10, tags: {}, refs: [2, 1] },
    ]);

    expect(way!.coords).toEqual([
      { lat: 2, lng: 2 },
      { lat: 1, lng: 1 },
    ]);
  });

  it('skips a way with a missing node ref (e.g. clipped at a boundary)', async () => {
    const ways = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      // node 2 is absent
      { type: 'way', id: 10, tags: { highway: 'primary' }, refs: [1, 2] },
    ]);

    expect(ways).toHaveLength(0);
  });

  it('skips a way that resolves to fewer than two points', async () => {
    const ways = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      { type: 'way', id: 10, tags: {}, refs: [1] },
    ]);

    expect(ways).toHaveLength(0);
  });

  it('passes tags through untouched', async () => {
    const [way] = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      { type: 'node', id: 2, lat: 2, lon: 2 },
      {
        type: 'way',
        id: 10,
        tags: { highway: 'track', surface: 'gravel', name: 'Forest Rd' },
        refs: [1, 2],
      },
    ]);

    expect(way!.tags).toEqual({
      highway: 'track',
      surface: 'gravel',
      name: 'Forest Rd',
    });
  });

  it('ignores nodes no way references', async () => {
    const ways = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      { type: 'node', id: 2, lat: 2, lon: 2 },
      { type: 'node', id: 99, lat: 9, lon: 9 }, // unreferenced
      { type: 'way', id: 10, tags: {}, refs: [1, 2] },
    ]);

    expect(ways).toHaveLength(1);
    expect(ways[0]!.coords).toHaveLength(2);
  });

  it('assembles multiple ways sharing nodes', async () => {
    const ways = await collect([
      { type: 'node', id: 1, lat: 1, lon: 1 },
      { type: 'node', id: 2, lat: 2, lon: 2 },
      { type: 'node', id: 3, lat: 3, lon: 3 },
      { type: 'way', id: 10, tags: {}, refs: [1, 2] },
      { type: 'way', id: 11, tags: {}, refs: [2, 3] },
    ]);

    expect(ways.map((w) => w.id)).toEqual([10, 11]);
  });

  it('consumes an async primitive source', async () => {
    async function* source(): AsyncGenerator<OsmPrimitive> {
      await Promise.resolve();
      yield { type: 'node', id: 1, lat: 1, lon: 1 };
      yield { type: 'node', id: 2, lat: 2, lon: 2 };
      yield { type: 'way', id: 10, tags: {}, refs: [1, 2] };
    }

    const out: OsmWay[] = [];
    for await (const way of assembleWays(source())) out.push(way);

    expect(out).toHaveLength(1);
  });
});
