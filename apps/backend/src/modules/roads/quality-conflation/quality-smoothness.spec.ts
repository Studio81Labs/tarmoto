import { qualityScoreToSmoothness } from './quality-smoothness.js';

describe('qualityScoreToSmoothness', () => {
  it('maps the ADR-0005 integer anchors', () => {
    expect(qualityScoreToSmoothness(5)).toBe('excellent');
    expect(qualityScoreToSmoothness(4)).toBe('good');
    expect(qualityScoreToSmoothness(3)).toBe('intermediate');
    expect(qualityScoreToSmoothness(2)).toBe('bad');
    expect(qualityScoreToSmoothness(1)).toBe('very_bad');
  });

  it('rounds a continuous score to the nearest tier', () => {
    // Below the .5 boundary rounds down, at/above rounds up.
    expect(qualityScoreToSmoothness(1.4)).toBe('very_bad'); // → 1
    expect(qualityScoreToSmoothness(1.5)).toBe('bad'); // → 2
    expect(qualityScoreToSmoothness(2.49)).toBe('bad'); // → 2
    expect(qualityScoreToSmoothness(2.5)).toBe('intermediate'); // → 3
    expect(qualityScoreToSmoothness(4.49)).toBe('good'); // → 4
    expect(qualityScoreToSmoothness(4.5)).toBe('excellent'); // → 5
  });

  it('clamps scores outside the nominal [1,5] range to the nearest tier', () => {
    expect(qualityScoreToSmoothness(0)).toBe('very_bad');
    expect(qualityScoreToSmoothness(-3)).toBe('very_bad');
    expect(qualityScoreToSmoothness(6)).toBe('excellent');
    expect(qualityScoreToSmoothness(100)).toBe('excellent');
  });

  it('yields no tag for a missing or non-finite score (stays MISSING/neutral)', () => {
    expect(qualityScoreToSmoothness(null)).toBeNull();
    expect(qualityScoreToSmoothness(undefined)).toBeNull();
    expect(qualityScoreToSmoothness(Number.NaN)).toBeNull();
    expect(qualityScoreToSmoothness(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
