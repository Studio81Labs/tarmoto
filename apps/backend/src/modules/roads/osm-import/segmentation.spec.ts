import {
  type LatLng,
  curvinessScore,
  polylineLengthMeters,
  segmentWay,
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
      expect(segs[i]![0]).toEqual(segs[i - 1]![segs[i - 1]!.length - 1]);
    }
  });

  it('keeps a short line as a single segment', () => {
    const segs = splitIntoSegments(straightLine(2, 40), 100); // 40 m total
    expect(segs).toHaveLength(1);
    expect(polylineLengthMeters(segs[0]!)).toBeLessThan(45);
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
    expect(polylineLengthMeters(segs[segs.length - 1]!)).toBeGreaterThan(120);
  });

  it('preserves total length across the split (≈ within 1%)', () => {
    const line = straightLine(7, 47);
    const total = polylineLengthMeters(line);
    const split = splitIntoSegments(line, 100);
    const sum = split.reduce((n, s) => n + polylineLengthMeters(s), 0);
    expect(Math.abs(sum - total)).toBeLessThan(total * 0.01);
  });

  it('splits a way crossing the antimeridian without going the long way', () => {
    // ~200 m edge straddling the date line (179.999° → -179.999°).
    const a: LatLng = { lat: 0, lng: 179.999 };
    const b: LatLng = { lat: 0, lng: -179.999 };
    const total = polylineLengthMeters([a, b]);
    expect(total).toBeLessThan(500); // short edge, NOT half the globe
    const segs = splitIntoSegments([a, b], 100);
    // Every interpolated point stays near ±180°, never near 0°.
    for (const seg of segs) {
      for (const p of seg) {
        expect(Math.abs(p.lng)).toBeGreaterThan(179);
      }
    }
    const sum = segs.reduce((n, s) => n + polylineLengthMeters(s), 0);
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

  it('ignores duplicate consecutive nodes (no phantom turns)', () => {
    // A straight east-west line with a duplicated middle vertex must still
    // score 0 — bearingDeg on identical points is undefined and would
    // otherwise inject phantom 90° turns.
    const m = 1 / 111_320;
    const straightEW: LatLng[] = [
      { lat: 50, lng: 14 },
      { lat: 50, lng: 14 + 100 * m },
      { lat: 50, lng: 14 + 100 * m }, // exact duplicate
      { lat: 50, lng: 14 + 200 * m },
    ];
    expect(curvinessScore(straightEW)).toBe(0);
  });
});

describe('segmentWay', () => {
  // A long twisty way that splits into several ~100 m segments.
  const twisty: LatLng[] = Array.from({ length: 60 }, (_, i) => ({
    lat: 50 + i * 0.0004,
    lng: 14 + 0.0004 * Math.sin(i * 0.9),
  }));

  it('returns coords + length_m + curviness_score per segment', () => {
    const segs = segmentWay(twisty, 100);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.coords.length).toBeGreaterThanOrEqual(2);
      expect(s.length_m).toBeGreaterThan(0);
      expect(s.curviness_score).toBeGreaterThanOrEqual(0);
      expect(s.curviness_score).toBeLessThanOrEqual(5);
    }
  });

  it("never scores a segment below its isolated curviness (boundary bends aren't dropped)", () => {
    // Context can only ADD the turns at a segment's shared endpoints, never
    // remove them — so per-segment curviness >= the standalone score that
    // drops boundary context. This is the fix for bends landing on a split.
    for (const s of segmentWay(twisty, 100)) {
      expect(s.curviness_score).toBeGreaterThanOrEqual(
        curvinessScore(s.coords),
      );
    }
  });

  it('attributes a boundary corner to both adjacent segments', () => {
    // A sharp ~90° corner; with a target near the leg length the corner lands
    // on a boundary. Both ~100 m stretches around it must read as curvy, not
    // straight.
    const m = 1 / 111_320;
    const corner: LatLng[] = [
      { lat: 50, lng: 14 },
      { lat: 50 + 100 * m, lng: 14 }, // 100 m north
      { lat: 50 + 100 * m, lng: 14 + 140 * m }, // then ~east (corner here)
    ];
    const segs = segmentWay(corner, 100);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    // The corner contributes curviness somewhere — not all segments straight.
    expect(segs.some((s) => s.curviness_score > 0)).toBe(true);
  });

  it('attributes a corner that lands EXACTLY on a segment boundary', () => {
    // target == the exact A→B length, so the split lands on the corner vertex B
    // and B is duplicated at the boundary. The first (2-point) segment must
    // still pick up the turn via a DISTINCT context point, not score 0.
    const m = 1 / 111_320;
    const A = { lat: 50, lng: 14 };
    const B = { lat: 50 + 100 * m, lng: 14 };
    const C = { lat: 50 + 100 * m, lng: 14 + 140 * m };
    const target = polylineLengthMeters([A, B]);
    const segs = segmentWay([A, B, C], target);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.coords).toHaveLength(2); // the boundary-ending segment
    expect(segs[0]!.curviness_score).toBeGreaterThan(0); // corner not dropped
  });

  it('puts a corner in the segment that contains it, not the straight approach', () => {
    // A→B is 101 m with a 100 m target: the split lands ~1 m before the corner
    // vertex B, so B is interior to the SECOND segment. The straight approach
    // must read straight; the corner-containing segment must read curvy.
    const m = 1 / 111_320;
    const A = { lat: 50, lng: 14 };
    const B = { lat: 50 + 101 * m, lng: 14 };
    const C = { lat: 50 + 101 * m, lng: 14 + 140 * m };
    const segs = segmentWay([A, B, C], 100);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.curviness_score).toBe(0); // straight approach
    expect(segs[1]!.curviness_score).toBeGreaterThan(0); // contains the corner
  });

  it("does not leak a neighbour's interior bend into a straight segment", () => {
    // A→B→S→D: the bend is at B (interior to the first segment); B→S→D runs
    // straight east. The straight segment must NOT inherit B's bend.
    const m = 1 / 111_320;
    const segs = segmentWay(
      [
        { lat: 50, lng: 14 },
        { lat: 50 + 50 * m, lng: 14 + 50 * m }, // B (corner)
        { lat: 50 + 50 * m, lng: 14 + 150 * m }, // S
        { lat: 50 + 50 * m, lng: 14 + 250 * m }, // D (straight from B)
      ],
      100,
    );
    expect(segs.length).toBeGreaterThanOrEqual(2);
    // The corner is in the first segment; the trailing straight stretch is 0.
    expect(segs[0]!.curviness_score).toBeGreaterThan(0);
    expect(segs[segs.length - 1]!.curviness_score).toBe(0);
  });
});
