import {
  COVERAGE_BUFFER_KM,
  padBbox,
  radiusCoverageSamples,
  routeCoverageSamples,
} from './poi-geo.js';

const LAT_KM_PER_DEGREE = 111.132;
const lngDeg = (lat: number, km: number): number =>
  km / (LAT_KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));

describe('radiusCoverageSamples (#925)', () => {
  it('returns the centre plus four cardinal AND four diagonal rim points', () => {
    const samples = radiusCoverageSamples(49, 16, 25);
    expect(samples).toHaveLength(9);
    const dLat = 25 / LAT_KM_PER_DEGREE;
    const dLng = lngDeg(49, 25);
    expect(samples[0]).toEqual({ lat: 49, lng: 16 }); // centre
    expect(samples[1]?.lat).toBeCloseTo(49 + dLat, 6); // N rim
    expect(samples[2]?.lat).toBeCloseTo(49 - dLat, 6); // S rim
    expect(samples[3]?.lng).toBeCloseTo(16 + dLng, 6); // E rim
    expect(samples[4]?.lng).toBeCloseTo(16 - dLng, 6); // W rim
    // Diagonals sit a full radius out (offset radius/√2 per axis).
    expect(samples[5]?.lat).toBeCloseTo(49 + dLat / Math.SQRT2, 6); // NE
    expect(samples[5]?.lng).toBeCloseTo(16 + dLng / Math.SQRT2, 6);
    expect(samples[8]?.lat).toBeCloseTo(49 - dLat / Math.SQRT2, 6); // SW
    expect(samples[8]?.lng).toBeCloseTo(16 - dLng / Math.SQRT2, 6);
  });

  it('caps the angular rim gap so a ~45° import edge cannot slip a wedge past coverage (#925 review)', () => {
    // Every rim point (incl. diagonals) is a full radius from the centre, and the
    // 45° spacing keeps adjacent-rim chords under the coverage buffer — so a
    // request whose centre is covered but whose disc clears the import edge
    // exposes an uncovered rim sample and forces the Overpass merge.
    const samples = radiusCoverageSamples(0, 0, 111.132);
    // At the equator km/° longitude equals km/° latitude, so a plain scale works.
    const distKm = (s: { lat: number; lng: number }): number =>
      Math.hypot(s.lat * LAT_KM_PER_DEGREE, s.lng * LAT_KM_PER_DEGREE);
    // All eight rim points are ~one radius (111 km) from the centre.
    for (const rim of samples.slice(1)) {
      expect(distKm(rim)).toBeCloseTo(111.132, 0);
    }
  });
});

describe('routeCoverageSamples (#925 P2)', () => {
  // An east–west route at 49°N: each segment's perpendicular is due north/south,
  // so the corridor rails offset the centreline in latitude.
  const route = [
    { lat: 49, lng: 16 },
    { lat: 49, lng: 17 },
  ];

  it('emits the centreline plus both perpendicular rails per sample', () => {
    const samples = routeCoverageSamples(route, 20);
    expect(samples.length % 3).toBe(0); // centre + 2 rails each
    const lats = samples.map((s) => s.lat);
    // Rails sit ~20 km north and south of the 49° line.
    expect(Math.max(...lats)).toBeGreaterThan(49.1);
    expect(Math.min(...lats)).toBeLessThan(48.9);
    expect(lats).toContain(49); // centreline samples
  });

  it('offsets each rail by ~bufferKm perpendicular to the segment', () => {
    const samples = routeCoverageSamples(route, 20);
    const north = Math.max(...samples.map((s) => s.lat));
    expect(north - 49).toBeCloseTo(20 / LAT_KM_PER_DEGREE, 3); // 20 km north
  });

  it('samples only the centreline when bufferKm is 0 (a degenerate corridor)', () => {
    const samples = routeCoverageSamples(route, 0);
    expect(samples.every((s) => s.lat === 49)).toBe(true);
    expect(samples).toContainEqual({ lat: 49, lng: 16 }); // start
    expect(samples).toContainEqual({ lat: 49, lng: 17 }); // final vertex
  });

  it('returns the single point for a one-point route and [] for an empty one', () => {
    expect(routeCoverageSamples([{ lat: 49, lng: 16 }], 20)).toEqual([
      { lat: 49, lng: 16 },
    ]);
    expect(routeCoverageSamples([], 20)).toEqual([]);
  });

  it('bounds the sample count by route length, not vertex count (no per-segment blowup #925)', () => {
    // ~36 km route as 400 densely-spaced vertices. The old per-segment sampler
    // emitted one point PER segment (~400×3), overflowing the downstream SQL
    // bind-param limit; the cumulative-distance walk emits only ~length/stride.
    const dense = Array.from({ length: 400 }, (_, i) => ({
      lat: 49,
      lng: 16 + (i * 0.5) / 399,
    }));
    const samples = routeCoverageSamples(dense, 2);
    expect(samples.length).toBeLessThan(30);
    // Still spans the whole route (start ~16, final vertex ~16.5).
    const lngs = samples.map((s) => s.lng);
    expect(Math.min(...lngs)).toBeCloseTo(16, 1);
    expect(Math.max(...lngs)).toBeCloseTo(16.5, 1);
  });

  it('widens the stride on a very long route so the list stays bounded WITH rails intact (#925 review)', () => {
    // ~6,700 km equatorial route. At a fixed 20 km stride this would emit >1,000
    // samples, forcing the store's lane-blind downsample to keep only every 3rd —
    // i.e. drop every rail. The adaptive stride keeps it bounded while preserving
    // the centre/+rail/-rail triplets.
    const longRoute = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 60 },
    ];
    const samples = routeCoverageSamples(longRoute, 2);
    expect(samples.length).toBeLessThan(512);
    expect(samples.length % 3).toBe(0); // whole triplets, no truncation
    // Rails survived: samples exist off the 0° centreline.
    expect(samples.some((s) => Math.abs(s.lat) > 1e-3)).toBe(true);
  });
});

describe('COVERAGE_BUFFER_KM (#925)', () => {
  it('is a sane single-value buffer', () => {
    expect(COVERAGE_BUFFER_KM).toBeGreaterThan(0);
    expect(COVERAGE_BUFFER_KM).toBeLessThan(100);
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
