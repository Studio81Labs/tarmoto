import {
  type LatLng,
  curvinessScore,
  polylineLengthMeters,
  splitIntoSegments,
} from './segmentation.js';

// ~0.0009° latitude ≈ 100 m; build a straight south→north line of N points
// spaced `stepM` metres apart starting at (50, 14).
function straightLine(points: number, stepM = 50): LatLng[] {
  const dLatPerM = 1 / 111_320; // metres per degree latitude
  return Array.from({ length: points }, (_, i) => ({
    lat: 50 + i * stepM * dLatPerM,
    lng: 14,
  }));
}

describe('polylineLengthMeters', () => {
  it('is 0 for < 2 points', () => {
    expect(polylineLengthMeters([])).toBe(0);
    expect(polylineLengthMeters([{ lat: 50, lng: 14 }])).toBe(0);
  });

  it('sums segment lengths (≈ within 1%)', () => {
    const len = polylineLengthMeters(straightLine(5, 50)); // 4 edges × 50 m
    expect(len).toBeGreaterThan(198);
    expect(len).toBeLessThan(202);
  });
});

describe('splitIntoSegments', () => {
  it('returns [] for fewer than 2 points', () => {
    expect(splitIntoSegments([])).toEqual([]);
    expect(splitIntoSegments([{ lat: 50, lng: 14 }])).toEqual([]);
  });

  it('splits a long line into ~targetMeters pieces, each joined to the next', () => {
    // A single 1000 m edge / 100 m target → ~10 segments.
    const segs = splitIntoSegments(
      [
        { lat: 50, lng: 14 },
        { lat: 50 + 1000 / 111_320, lng: 14 },
      ],
      100,
    );
    expect(segs.length).toBeGreaterThanOrEqual(9);
    expect(segs.length).toBeLessThanOrEqual(10);
    // Each non-final segment ≈ 100 m.
    for (const s of segs.slice(0, -1)) {
      const l = polylineLengthMeters(s);
      expect(l).toBeGreaterThan(95);
      expect(l).toBeLessThan(105);
    }
    // Contiguity: each segment ends where the next starts.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i][0]).toEqual(segs[i - 1][segs[i - 1].length - 1]);
    }
  });

  it('keeps a short line as a single segment', () => {
    const segs = splitIntoSegments(straightLine(2, 40), 100); // 40 m total
    expect(segs).toHaveLength(1);
    expect(polylineLengthMeters(segs[0])).toBeLessThan(45);
  });

  it('merges a short tail into the previous segment (no stub)', () => {
    // 230 m total at 100 m target → 100 + 100 + 30; the 30 m tail merges.
    const segs = splitIntoSegments(
      [
        { lat: 50, lng: 14 },
        { lat: 50 + 230 / 111_320, lng: 14 },
      ],
      100,
    );
    expect(segs).toHaveLength(2);
    // Last segment is ~130 m (the merged tail), not a 30 m stub.
    expect(polylineLengthMeters(segs[segs.length - 1])).toBeGreaterThan(120);
  });

  it('preserves total length across the split (≈ within 1%)', () => {
    const line = straightLine(7, 47);
    const total = polylineLengthMeters(line);
    const split = splitIntoSegments(line, 100);
    const sum = split.reduce((n, s) => n + polylineLengthMeters(s), 0);
    expect(Math.abs(sum - total)).toBeLessThan(total * 0.01);
  });
});

describe('curvinessScore', () => {
  it('is 0 for a straight line', () => {
    expect(curvinessScore(straightLine(10, 50))).toBe(0);
  });

  it('is 0 for < 3 points', () => {
    expect(curvinessScore([{ lat: 50, lng: 14 }])).toBe(0);
    expect(
      curvinessScore([
        { lat: 50, lng: 14 },
        { lat: 50.1, lng: 14 },
      ]),
    ).toBe(0);
  });

  it('ranks a twisty road above a gentle bend above a straight road', () => {
    const straight = curvinessScore(straightLine(10, 50));
    // Gentle: a smooth circular arc (bearing changes slowly).
    const gentle = curvinessScore(
      Array.from({ length: 12 }, (_, i) => {
        const a = i * 0.06;
        return {
          lat: 50 + 0.01 * Math.sin(a),
          lng: 14 + 0.01 * (1 - Math.cos(a)),
        };
      }),
    );
    // Twisty: a tight sine wiggle (frequent sharp turns).
    const twisty = curvinessScore(
      Array.from({ length: 16 }, (_, i) => ({
        lat: 50 + i * 0.0004,
        lng: 14 + 0.0004 * Math.sin(i * 1.4),
      })),
    );
    expect(straight).toBeLessThan(gentle);
    expect(gentle).toBeLessThan(twisty);
    expect(twisty).toBeGreaterThan(3); // lands in the "curvy" band (>= 3.0)
  });

  it('clamps to a maximum of 5', () => {
    // Extreme hairpins over a tiny distance → saturates.
    const hairpins = Array.from({ length: 40 }, (_, i) => ({
      lat: 50 + (i % 2) * 0.0002,
      lng: 14 + i * 0.000005,
    }));
    expect(curvinessScore(hairpins)).toBeLessThanOrEqual(5);
  });
});
