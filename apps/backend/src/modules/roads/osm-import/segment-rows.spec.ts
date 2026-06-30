import {
  type OsmWay,
  buildSegmentRows,
  waySegmentRows,
} from './segment-rows.js';
import type { LatLng } from './segmentation.js';

const m = 1 / 111_320; // metres per degree latitude
/** A straight south→north way of `lengthM` starting at (50, 14). */
function straightWay(lengthM: number): LatLng[] {
  return [
    { lat: 50, lng: 14 },
    { lat: 50 + lengthM * m, lng: 14 },
  ];
}

describe('waySegmentRows', () => {
  it('returns no rows for a non-drivable way', () => {
    expect(
      waySegmentRows({
        id: 1,
        tags: { highway: 'footway' },
        coords: straightWay(300),
      }),
    ).toEqual([]);
  });

  it('returns no rows for degenerate geometry (< 2 coords)', () => {
    expect(
      waySegmentRows({
        id: 1,
        tags: { highway: 'residential' },
        coords: [{ lat: 50, lng: 14 }],
      }),
    ).toEqual([]);
  });

  it('emits one row per ~100 m segment with sequential 0-based segment_index', () => {
    const rows = waySegmentRows({
      id: 42,
      tags: {
        highway: 'secondary',
        name: 'Hlavní',
        ref: 'II/430',
        surface: 'asphalt',
      },
      coords: straightWay(300), // ~3 segments
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.segment_index)).toEqual(
      rows.map((_, i) => i), // 0,1,2,…
    );
    for (const r of rows) {
      expect(r.osm_way_id).toBe('42');
      expect(r.road_name).toBe('Hlavní');
      expect(r.road_number).toBe('II/430');
      expect(r.surface_type).toBe('asphalt');
      expect(r.length_m).toBeGreaterThan(0);
      expect(r.curviness_score).toBeGreaterThanOrEqual(0);
      expect(r.geom.type).toBe('LineString');
      // GeoJSON coordinates are [lng, lat].
      expect(r.geom.coordinates[0]).toEqual([14, expect.any(Number)]);
    }
  });

  it('stringifies a numeric way id (bigint column)', () => {
    const rows = waySegmentRows({
      id: 1_234_567_890,
      tags: { highway: 'residential' },
      coords: straightWay(150),
    });
    expect(rows[0].osm_way_id).toBe('1234567890');
  });
});

describe('buildSegmentRows', () => {
  async function collect(
    ways: OsmWay[],
  ): Promise<Awaited<ReturnType<typeof waySegmentRows>>> {
    const out: ReturnType<typeof waySegmentRows> = [];
    for await (const row of buildSegmentRows(ways)) out.push(row);
    return out;
  }

  it('flattens drivable ways and resets segment_index per way', async () => {
    const rows = await collect([
      { id: 1, tags: { highway: 'residential' }, coords: straightWay(250) },
      { id: 2, tags: { highway: 'footway' }, coords: straightWay(250) }, // skipped
      { id: 3, tags: { highway: 'tertiary' }, coords: straightWay(250) },
    ]);
    const byWay = new Map<string, number[]>();
    for (const r of rows) {
      byWay.set(r.osm_way_id, [
        ...(byWay.get(r.osm_way_id) ?? []),
        r.segment_index,
      ]);
    }
    expect([...byWay.keys()].sort()).toEqual(['1', '3']); // footway excluded
    for (const indices of byWay.values()) {
      expect(indices).toEqual(indices.map((_, i) => i)); // each resets to 0,1,…
      expect(indices.length).toBeGreaterThanOrEqual(2);
    }
  });
});
