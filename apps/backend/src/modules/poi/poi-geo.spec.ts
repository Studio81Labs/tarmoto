import { pointRadiusBbox, routeBufferBbox, bboxContains } from './poi-geo.js';

const LAT_KM_PER_DEGREE = 111.132;
const lngDeg = (lat: number, km: number): number =>
  km / (LAT_KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));

describe('pointRadiusBbox', () => {
  it('encloses the radius circle, wider in longitude toward the equator', () => {
    const bbox = pointRadiusBbox(0, 10, 11.1132);
    expect(bbox.maxLat - 0).toBeCloseTo(0.1, 3); // ~1° lat ≈ 111 km
    expect(bbox.maxLng - 10).toBeCloseTo(lngDeg(0, 11.1132), 4);
    expect(bbox.minLng).toBeLessThan(10);
    expect(bbox.minLat).toBeLessThan(0);
  });
});

describe('routeBufferBbox (#925)', () => {
  it('pads longitude at the route poleward-most latitude, not the midpoint', () => {
    // A route from the equator to 60°N. km/° longitude is smaller at 60° than at
    // the 30° midpoint, so the buffer needs MORE degrees there — padding must use
    // the 60° end or a high-latitude corridor strip would be wrongly "covered".
    const bbox = routeBufferBbox(
      [
        { lat: 0, lng: 10 },
        { lat: 60, lng: 10 },
      ],
      10,
    );
    expect(bbox.maxLng - 10).toBeCloseTo(lngDeg(60, 10), 4); // worst-case latitude
    expect(bbox.maxLng - 10).toBeGreaterThan(lngDeg(30, 10)); // wider than midpoint
    // Latitude padding is symmetric ~ bufferKm / 111 km/°.
    expect(bbox.maxLat - 60).toBeCloseTo(10 / LAT_KM_PER_DEGREE, 4);
  });

  it('uses the same worst-case latitude for a southern-hemisphere route', () => {
    const bbox = routeBufferBbox(
      [
        { lat: 0, lng: 10 },
        { lat: -55, lng: 10 },
      ],
      10,
    );
    expect(bbox.maxLng - 10).toBeCloseTo(lngDeg(-55, 10), 4);
  });
});

describe('bboxContains', () => {
  const outer = { minLng: 0, minLat: 0, maxLng: 10, maxLat: 10 };

  it('is true only when inner sits fully inside outer', () => {
    expect(
      bboxContains(outer, { minLng: 1, minLat: 1, maxLng: 9, maxLat: 9 }),
    ).toBe(true);
    // Pokes over the east edge.
    expect(
      bboxContains(outer, { minLng: 1, minLat: 1, maxLng: 11, maxLat: 9 }),
    ).toBe(false);
    // Pokes under the south edge.
    expect(
      bboxContains(outer, { minLng: 1, minLat: -1, maxLng: 9, maxLat: 9 }),
    ).toBe(false);
  });
});
