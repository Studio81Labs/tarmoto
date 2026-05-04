import { rideToGpx, tripDayToGpx } from './gpx.js';

describe('rideToGpx', () => {
  it('produces single-track gpx wrapped with metadata', () => {
    const xml = rideToGpx({
      name: 'Morning loop',
      startedAt: new Date('2026-04-01T08:00:00Z'),
      route: {
        type: 'LineString',
        coordinates: [
          [-122.0, 37.0],
          [-122.1, 37.1],
        ],
      },
    });
    expect(xml).toContain('<gpx');
    expect(xml).toContain('<trk>');
    expect(xml).toContain('<name>Morning loop</name>');
    expect(xml).toContain('lat="37"');
    expect(xml).toContain('lon="-122"');
    expect(xml).toContain('<time>2026-04-01T08:00:00.000Z</time>');
  });

  it('returns null when route is missing', () => {
    expect(
      rideToGpx({
        name: 'no-route',
        startedAt: new Date(),
        route: null,
      }),
    ).toBeNull();
  });

  it('returns null when route has no coordinates', () => {
    expect(
      rideToGpx({
        name: 'empty',
        startedAt: new Date(),
        route: { type: 'LineString', coordinates: [] },
      }),
    ).toBeNull();
  });

  it('escapes special characters in the name', () => {
    const xml = rideToGpx({
      name: 'A & B <evil>',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      route: { type: 'LineString', coordinates: [[0, 0]] },
    });
    expect(xml).toContain('A &amp; B &lt;evil&gt;');
    expect(xml).not.toContain('<evil>');
  });

  it('emits <ele> when GeoJSON coordinates carry an elevation component', () => {
    const xml = rideToGpx({
      name: 'mountain run',
      startedAt: new Date('2026-04-01T08:00:00Z'),
      route: {
        type: 'LineString',
        coordinates: [
          [-122.0, 37.0, 1234.5],
          [-122.1, 37.1, 1240],
        ],
      },
    });
    expect(xml).toContain(
      '<trkpt lat="37" lon="-122"><ele>1234.5</ele></trkpt>',
    );
    expect(xml).toContain(
      '<trkpt lat="37.1" lon="-122.1"><ele>1240</ele></trkpt>',
    );
  });

  it('emits trkpt without <ele> when coordinates are 2D', () => {
    const xml = rideToGpx({
      name: 'flat',
      startedAt: new Date('2026-04-01T08:00:00Z'),
      route: {
        type: 'LineString',
        coordinates: [[-122.0, 37.0]],
      },
    });
    expect(xml).toContain('<trkpt lat="37" lon="-122"></trkpt>');
    expect(xml).not.toContain('<ele>');
  });

  it('skips <ele> when the third element is NaN or Infinity', () => {
    const xml = rideToGpx({
      name: 'bad-elev',
      startedAt: new Date('2026-04-01T08:00:00Z'),
      route: {
        type: 'LineString',
        coordinates: [
          [-122.0, 37.0, NaN],
          [-122.1, 37.1, Infinity],
        ],
      } as never,
    });
    expect(xml).not.toContain('<ele>');
  });
});

describe('tripDayToGpx', () => {
  it('produces a track per day', () => {
    const xml = tripDayToGpx({
      tripTitle: 'CA loop',
      dayNumber: 2,
      route: {
        type: 'LineString',
        coordinates: [
          [-1, 1],
          [-2, 2],
        ],
      },
    });
    expect(xml).toContain('<name>CA loop — Day 2</name>');
  });

  it('returns null for missing route', () => {
    expect(
      tripDayToGpx({ tripTitle: 't', dayNumber: 1, route: null }),
    ).toBeNull();
  });
});
