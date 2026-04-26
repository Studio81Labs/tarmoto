import {
  buildDayChain,
  chunkDistance,
  MAX_DAILY_KM,
  MIN_DAILY_KM,
  OPTION_PRESETS,
  pickAnchors,
  planFuelStopIndices,
  resolveBBox,
  resolveSurfaceFilter,
  scoreRoute,
} from './trip-generator.utils.js';

const START = { lat: 47.0, lng: 11.5 }; // somewhere in Tyrol-ish

describe('chunkDistance', () => {
  it('returns numDays equal targets at the (min+max)/2 average', () => {
    const out = chunkDistance(5, 150, 350, 1.0);
    expect(out).toHaveLength(5);
    expect(out.every((v) => v === out[0])).toBe(true);
    expect(out[0]).toBe(250);
  });

  it('applies the preset multiplier', () => {
    const fastest = chunkDistance(3, 200, 300, 0.88);
    expect(fastest[0]).toBeCloseTo(220, 5);
  });

  it('clamps below MIN_DAILY_KM', () => {
    // (5+10)/2 * 0.5 = 3.75, clamped to MIN_DAILY_KM
    const out = chunkDistance(2, 5, 10, 0.5);
    expect(out[0]).toBe(MIN_DAILY_KM);
  });

  it('clamps above MAX_DAILY_KM', () => {
    const out = chunkDistance(2, 600, 1000, 1.5);
    expect(out[0]).toBe(MAX_DAILY_KM);
  });

  it('returns an empty array for zero or negative numDays', () => {
    expect(chunkDistance(0, 150, 350, 1.0)).toEqual([]);
    expect(chunkDistance(-1, 150, 350, 1.0)).toEqual([]);
  });
});

describe('resolveBBox', () => {
  it('parses a well-formed bbox string', () => {
    expect(resolveBBox('11.0,46.0,12.5,47.0', null, START)).toEqual([
      11.0, 46.0, 12.5, 47.0,
    ]);
  });

  it('falls back to the catalog region when bbox is missing', () => {
    const out = resolveBBox(undefined, 'Dolomites', START);
    // From shared catalog
    expect(out).toEqual([10.8, 46.2, 12.5, 46.85]);
  });

  it('falls back to a default square around the start when nothing matches', () => {
    const out = resolveBBox(undefined, 'Atlantis', START);
    expect(out[0]).toBeCloseTo(START.lng - 0.75, 5);
    expect(out[1]).toBeCloseTo(START.lat - 0.75, 5);
    expect(out[2]).toBeCloseTo(START.lng + 0.75, 5);
    expect(out[3]).toBeCloseTo(START.lat + 0.75, 5);
  });

  it('rejects an inside-out bbox string and falls back', () => {
    const out = resolveBBox('12.5,47.0,11.0,46.0', null, START);
    // West > East should be rejected → fall back to default
    expect(out[0]).toBeCloseTo(START.lng - 0.75, 5);
  });
});

describe('pickAnchors', () => {
  const bbox: [number, number, number, number] = [10, 46, 13, 48];

  it('returns the requested count when enough fun zones fit', () => {
    const fz = [
      { lat: 47.2, lng: 11.4 },
      { lat: 46.5, lng: 12.0 },
      { lat: 47.7, lng: 12.6 },
      { lat: 46.3, lng: 11.0 },
    ];
    const anchors = pickAnchors(START, bbox, fz, 3);
    expect(anchors).toHaveLength(3);
  });

  it('falls back to compass-spread anchors when no fun zones overlap (single-zone-region edge case)', () => {
    const anchors = pickAnchors(START, bbox, [], 4);
    expect(anchors).toHaveLength(4);
    // All anchors should be inside the bbox.
    for (const a of anchors) {
      expect(a.lng).toBeGreaterThanOrEqual(bbox[0]);
      expect(a.lng).toBeLessThanOrEqual(bbox[2]);
      expect(a.lat).toBeGreaterThanOrEqual(bbox[1]);
      expect(a.lat).toBeLessThanOrEqual(bbox[3]);
    }
  });

  it('skips fun zones too close to start', () => {
    const fz = [{ lat: START.lat + 0.01, lng: START.lng + 0.01 }];
    const anchors = pickAnchors(START, bbox, fz, 1);
    // The one provided zone is <2 km from start so it must be skipped
    // and the function should fall back to a compass-spread anchor.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).not.toEqual(fz[0]);
  });

  it('returns empty for zero count', () => {
    expect(pickAnchors(START, bbox, [], 0)).toEqual([]);
  });
});

describe('buildDayChain', () => {
  it('1-day trip emits a single leg through the first anchor (or back to start)', () => {
    const chain = buildDayChain(START, [{ lat: 47.5, lng: 11.5 }], 1);
    expect(chain).toHaveLength(1);
    expect(chain[0].from).toEqual(START);
    expect(chain[0].to).toEqual({ lat: 47.5, lng: 11.5 });
  });

  it('1-day trip with no anchors collapses to start→start', () => {
    const chain = buildDayChain(START, [], 1);
    expect(chain).toHaveLength(1);
    expect(chain[0].from).toEqual(START);
    expect(chain[0].to).toEqual(START);
  });

  it('multi-day chains threads anchors and closes with a return-to-start leg', () => {
    const anchors = [
      { lat: 47.2, lng: 11.7 },
      { lat: 46.8, lng: 12.0 },
    ];
    const chain = buildDayChain(START, anchors, 3);
    expect(chain).toHaveLength(3);
    // Day 1 starts at start, Day N ends at start (loop).
    expect(chain[0].from).toEqual(START);
    expect(chain[chain.length - 1].to).toEqual(START);
    // Days are chained: day k.to === day k+1.from
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].from).toEqual(chain[i - 1].to);
    }
  });

  it('returns empty for zero or negative days', () => {
    expect(buildDayChain(START, [], 0)).toEqual([]);
    expect(buildDayChain(START, [], -1)).toEqual([]);
  });
});

describe('scoreRoute (quality weighting)', () => {
  const m = (over: Partial<Parameters<typeof scoreRoute>[1]> = {}) => ({
    avgQuality: 4,
    curvinessScore: 60,
    scenicScore: 40,
    durationMin: 240,
    ...over,
  });

  it('higher quality scores higher under best-fit', () => {
    const preset = OPTION_PRESETS.find((p) => p.id === 'best-fit')!;
    const a = scoreRoute(preset, m({ avgQuality: 3 }));
    const b = scoreRoute(preset, m({ avgQuality: 5 }));
    expect(b).toBeGreaterThan(a);
  });

  it('higher curviness scores higher under scenic', () => {
    const preset = OPTION_PRESETS.find((p) => p.id === 'scenic')!;
    const a = scoreRoute(preset, m({ curvinessScore: 30 }));
    const b = scoreRoute(preset, m({ curvinessScore: 90 }));
    expect(b).toBeGreaterThan(a);
  });

  it('shorter durations score higher under fastest', () => {
    const preset = OPTION_PRESETS.find((p) => p.id === 'fastest')!;
    const slow = scoreRoute(preset, m({ durationMin: 600 }));
    const quick = scoreRoute(preset, m({ durationMin: 90 }));
    expect(quick).toBeGreaterThan(slow);
  });

  it('treats null metrics as zero (no-op weighting)', () => {
    const preset = OPTION_PRESETS.find((p) => p.id === 'best-fit')!;
    const score = scoreRoute(preset, {
      avgQuality: null,
      curvinessScore: null,
      scenicScore: null,
      durationMin: 240,
    });
    // Only the speed component contributes; should still be >0 for a
    // finite durationMin.
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.2);
  });
});

describe('resolveSurfaceFilter', () => {
  it('returns null when no filter is requested (all surfaces allowed)', () => {
    expect(resolveSurfaceFilter(undefined, undefined)).toBeNull();
  });

  it('drops gravel and dirt when avoid_unpaved is set', () => {
    const out = resolveSurfaceFilter(undefined, true);
    expect(out).not.toContain('gravel');
    expect(out).not.toContain('dirt');
    expect(out).toContain('asphalt');
  });

  it('respects an explicit surfaces list', () => {
    expect(resolveSurfaceFilter(['asphalt', 'gravel'], false)).toEqual([
      'asphalt',
      'gravel',
    ]);
  });

  it('removes unpaved from an explicit list when avoid_unpaved is set', () => {
    expect(resolveSurfaceFilter(['asphalt', 'gravel', 'dirt'], true)).toEqual([
      'asphalt',
    ]);
  });
});

describe('planFuelStopIndices (no fuel stops within range edge case)', () => {
  function syntheticRoute(distanceKm: number, vertices = 50) {
    // Straight east-going route at lat 47, long enough so haversine
    // accumulates `distanceKm` across `vertices` evenly-spaced points.
    const lngStep =
      distanceKm / 111 / Math.cos((47 * Math.PI) / 180) / (vertices - 1);
    return Array.from({ length: vertices }, (_, i) => ({
      lat: 47,
      lng: 11 + i * lngStep,
    }));
  }

  it('returns no indices for a day shorter than the fuel range', () => {
    const route = syntheticRoute(150);
    expect(planFuelStopIndices(route, 150)).toEqual([]);
  });

  it('plants ~one fuel stop per FUEL_RANGE_KM beyond the first range', () => {
    const route = syntheticRoute(500, 100);
    const stops = planFuelStopIndices(route, 500);
    // 500 km / 220 km ≈ 2 mid-route stops
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(stops.length).toBeLessThanOrEqual(3);
    // Never the first or last vertex.
    for (const i of stops) {
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThan(route.length - 1);
    }
  });

  it('returns no indices for a degenerate (2-point) route', () => {
    expect(
      planFuelStopIndices(
        [
          { lat: 47, lng: 11 },
          { lat: 47, lng: 11.001 },
        ],
        500,
      ),
    ).toEqual([]);
  });
});
