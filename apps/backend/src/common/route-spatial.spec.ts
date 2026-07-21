import { buildRouteSpatialSql } from './route-spatial.js';

describe('buildRouteSpatialSql', () => {
  it('builds a MultiLineString without connecting separate route chunks', () => {
    const result = buildRouteSpatialSql(
      [
        [
          { lat: 49.2, lng: 16.6 },
          { lat: 49.7, lng: 18.3 },
        ],
        [
          { lat: 46.5, lng: 10.4 },
          { lat: 46.6, lng: 10.5 },
        ],
      ],
      100,
      'c.geom',
    );

    expect(result.geometrySql).toContain('ST_Collect');
    expect(result.geometrySql.match(/ST_MakeLine/g)).toHaveLength(2);
    expect(result.params).toMatchObject({
      routeLng0_0: 16.6,
      routeLat0_0: 49.2,
      routeLng1_1: 10.5,
      routeLat1_1: 46.6,
    });
  });

  it('widens the longitude prefilter conservatively at high latitudes', () => {
    const result = buildRouteSpatialSql(
      [
        [
          { lat: 70, lng: 20 },
          { lat: 70.1, lng: 20.1 },
        ],
      ],
      100,
      'p.location',
    );

    expect(result.prefilterSql).toContain('ST_Expand');
    expect(result.params.bufferLngDeg).toBeGreaterThan(0.0025);
    expect(result.params.bufferLngDeg).toBeGreaterThan(
      result.params.bufferLatDeg!,
    );
  });

  it('uses the full longitude range when the buffer reaches a pole', () => {
    const result = buildRouteSpatialSql(
      [
        [
          { lat: 89.9995, lng: 20 },
          { lat: 89.9996, lng: 21 },
        ],
      ],
      100,
      'p.location',
    );

    expect(result.params.bufferLngDeg).toBe(180);
  });
});
