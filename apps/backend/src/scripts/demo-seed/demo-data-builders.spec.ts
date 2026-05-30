import { ROAD_QUALITY, SURFACE_TYPES } from '@tarmoto/shared';
import {
  DEMO_ROAD_MARKER,
  buildDemoRoadSpecs,
  buildLineString,
  mulberry32,
  seedFromString,
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
