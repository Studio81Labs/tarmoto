import { ROAD_QUALITY, SURFACE_TYPES } from '@tarmoto/shared';
import {
  buildDemoRoadSpecs,
  buildLineString,
  DEMO_PASS_ROWS,
  DEMO_ROAD_MARKER,
  mulberry32,
  offsetLine,
  seedFromString,
  sliceLineByFraction,
} from './demo-data-builders.js';

describe('demo-data-builders', () => {
  describe('mulberry32', () => {
    it('produces deterministic values in [0, 1) for a given seed', () => {
      const a = mulberry32(42);
      const b = mulberry32(42);
      const xs = [a(), a(), a()];
      const ys = [b(), b(), b()];
      expect(xs).toEqual(ys);
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }
    });

    it('diverges for different seeds', () => {
      expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    });
  });

  describe('seedFromString', () => {
    it('is deterministic and seed-distinct per email', () => {
      expect(seedFromString('newbie@tarmoto.app')).toBe(
        seedFromString('newbie@tarmoto.app'),
      );
      expect(seedFromString('newbie@tarmoto.app')).not.toBe(
        seedFromString('road.hunter@tarmoto.app'),
      );
    });
  });

  describe('buildLineString', () => {
    it('builds a GeoJSON LineString of the requested length near the start', () => {
      const line = buildLineString(mulberry32(7), { lat: 49.2, lng: 16.6 }, 6);
      expect(line.type).toBe('LineString');
      expect(line.coordinates).toHaveLength(6);
      for (const [lng, lat] of line.coordinates) {
        // [lng, lat] ordering (GeoJSON) and within a sane wander of start.
        expect(Math.abs(lat - 49.2)).toBeLessThan(1);
        expect(Math.abs(lng - 16.6)).toBeLessThan(1);
      }
    });

    it('requires at least two points', () => {
      expect(() =>
        buildLineString(mulberry32(1), { lat: 0, lng: 0 }, 1),
      ).toThrow(/at least two points/);
    });

    it('is deterministic for the same seed', () => {
      const a = buildLineString(mulberry32(9), { lat: 49, lng: 16 }, 5);
      const b = buildLineString(mulberry32(9), { lat: 49, lng: 16 }, 5);
      expect(a.coordinates).toEqual(b.coordinates);
    });
  });

  describe('buildDemoRoadSpecs', () => {
    it('builds the requested count of uniquely-marked roads', () => {
      const roads = buildDemoRoadSpecs(12);
      expect(roads).toHaveLength(12);
      const numbers = roads.map((r) => r.road_number);
      expect(new Set(numbers).size).toBe(12);
      for (const r of roads) {
        expect(r.road_number.startsWith(DEMO_ROAD_MARKER)).toBe(true);
        expect(r.geom.type).toBe('LineString');
        expect(r.geom.coordinates.length).toBeGreaterThanOrEqual(2);
        expect(r.length_m).toBeGreaterThan(0);
        expect(r.quality_score).toBeGreaterThanOrEqual(ROAD_QUALITY.VERY_POOR);
        expect(r.quality_score).toBeLessThanOrEqual(ROAD_QUALITY.EXCELLENT);
        expect(SURFACE_TYPES).toContain(r.surface_type);
      }
    });

    it('is deterministic across runs', () => {
      expect(buildDemoRoadSpecs(5)).toEqual(buildDemoRoadSpecs(5));
    });
  });
});

describe('sliceLineByFraction', () => {
  const line = {
    type: 'LineString' as const,
    coordinates: [
      [15.0, 49.0],
      [15.1, 49.1],
      [15.2, 49.2],
      [15.3, 49.3],
      [15.4, 49.4],
    ],
  };

  it('carves the requested vertex range', () => {
    const slice = sliceLineByFraction(line, 0.25, 0.75);
    expect(slice.coordinates[0]).toEqual([15.1, 49.1]);
    expect(slice.coordinates.at(-1)).toEqual([15.3, 49.3]);
  });

  it('always returns at least two vertices, even for degenerate ranges', () => {
    const slice = sliceLineByFraction(line, 0.99, 0.99);
    expect(slice.coordinates.length).toBeGreaterThanOrEqual(2);
    const full = sliceLineByFraction(line, 0, 1);
    expect(full.coordinates).toEqual(line.coordinates);
  });
});

describe('offsetLine', () => {
  it('shifts every vertex by the given deltas', () => {
    const line = {
      type: 'LineString' as const,
      coordinates: [
        [15.0, 49.0],
        [15.1, 49.1],
      ],
    };
    expect(offsetLine(line, 0.01, -0.02).coordinates).toEqual([
      [15.01, 48.98],
      [15.11, 49.08],
    ]);
  });
});

describe('DEMO_PASS_ROWS', () => {
  it('mirrors the AddMountainPasses migration catalog', () => {
    expect(DEMO_PASS_ROWS).toHaveLength(11);
    const names = DEMO_PASS_ROWS.map((row) => row.name);
    expect(new Set(names).size).toBe(11);
    expect(names).toContain('Červenohorské sedlo');
    for (const row of DEMO_PASS_ROWS) {
      expect(row.typical_open_month).toBeGreaterThanOrEqual(1);
      expect(row.typical_close_month).toBeLessThanOrEqual(12);
      expect(Math.abs(row.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(row.lng)).toBeLessThanOrEqual(180);
    }
  });
});
