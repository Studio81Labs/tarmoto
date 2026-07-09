import { pointRadiusBbox, routeBufferBbox, padBbox } from './poi-geo.js';

const LAT_KM_PER_DEGREE = 111.132;
const lngDeg = (lat: number, km: number): number =>
  km / (LAT_KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));

describe('pointRadiusBbox', () => {
  it('encloses the radius circle, wider in longitude toward the equator', () => {
    const bbox = pointRadiusBbox(0, 10, 11.1132);
    expect(bbox.maxLat - 0).toBeCloseTo(0.1, 3); // ~1° lat ≈ 111 km
    expect(bbox.maxLng - 10).toBeCloseTo(lngDeg(0.1, 11.1132), 4);
    expect(bbox.minLng).toBeLessThan(10);
    expect(bbox.minLat).toBeLessThan(0);
  });

  it('pads longitude at the circle poleward edge, not the centre (#925 review)', () => {
    // A 55.6 km radius at 60°N: the circle top (60° + 0.5°) has smaller km/°
    // longitude than the centre, so the padding must use that edge or a thin
    // slice near an E/W import boundary would be wrongly judged covered.
    const bbox = pointRadiusBbox(60, 10, 55.566);
    const dLat = 55.566 / LAT_KM_PER_DEGREE;
    expect(bbox.maxLng - 10).toBeCloseTo(lngDeg(60 + dLat, 55.566), 4);
    expect(bbox.maxLng - 10).toBeGreaterThan(lngDeg(60, 55.566)); // wider than centre
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

describe('padBbox (#925)', () => {
  it('expands every side; ~1° lat pad for 111.132 km, wider lng pad at the equator', () => {
    const padded = padBbox(
      { minLng: 10, minLat: 0, maxLng: 11, maxLat: 0.5 },
      111.132,
    );
    // 111.132 km ≈ 1° latitude.
    expect(padded.minLat).toBeCloseTo(-1, 5);
    expect(padded.maxLat).toBeCloseTo(1.5, 5);
    // At the equator km/° longitude ≈ km/° latitude, so ~1° lng pad too.
    expect(padded.minLng).toBeCloseTo(9, 2);
    expect(padded.maxLng).toBeCloseTo(12, 2);
  });

  it('pads longitude at the poleward-most edge so a high-latitude box is not under-padded', () => {
    // Box spanning 60–61°N: the lng pad must use 61°N (km/° smallest), so the
    // degree pad is wider than the equatorial case above for the same km.
    const km = 55.566; // ≈ 0.5° latitude
    const padded = padBbox(
      { minLng: 10, minLat: 60, maxLng: 11, maxLat: 61 },
      km,
    );
    const dLat = padded.maxLat - 61;
    const dLng = padded.maxLng - 11;
    expect(dLat).toBeCloseTo(0.5, 5);
    // cos(61°) ≈ 0.485, so the lng pad is ≈ 0.5 / 0.485 ≈ 1.03°.
    expect(dLng).toBeGreaterThan(dLat);
    expect(dLng).toBeCloseTo(0.5 / Math.cos((61 * Math.PI) / 180), 2);
  });
});
