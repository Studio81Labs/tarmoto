import { regionPolygon } from './region-polygons.js';

describe('regionPolygon', () => {
  it('returns a non-empty GeoJSON geometry string for a bundled region code', () => {
    const cz = regionPolygon('CZ');
    expect(typeof cz).toBe('string');
    expect(cz.length).toBeGreaterThan(0);
    // Parses to a real polygonal geometry (fed to ST_GeomFromGeoJSON).
    const geom = JSON.parse(cz) as { type: string; coordinates: unknown[] };
    expect(['Polygon', 'MultiPolygon']).toContain(geom.type);
    expect(Array.isArray(geom.coordinates)).toBe(true);
    expect(geom.coordinates.length).toBeGreaterThan(0);
  });

  it('resolves the bundled asset under the ts-jest src tree (no path drift)', () => {
    // A second bundled code proves the loader found the real FeatureCollection,
    // not just a single lucky entry.
    expect(() => regionPolygon('SK')).not.toThrow();
  });

  it('throws a clear error for a code with no bundled boundary', () => {
    expect(() => regionPolygon('ZZ')).toThrow(/no boundary polygon/i);
  });
});
