import { planReassignment, type ExistingSegment } from './split-merge.js';
import type { LatLng } from './segmentation.js';

// ~0.0009° latitude ≈ 100 m. Build straight segments north along lng 0.
function seg(latStart: number, latEnd: number): LatLng[] {
  return [
    { lat: latStart, lng: 0 },
    { lat: latEnd, lng: 0 },
  ];
}
const M = 0.0009; // ~100 m in degrees latitude

describe('planReassignment (OSM split/merge)', () => {
  it('carries every id over when the segmentation is unchanged', () => {
    const existing: ExistingSegment[] = [
      { id: 'a', coords: seg(0, M) },
      { id: 'b', coords: seg(M, 2 * M) },
    ];
    const incoming = [seg(0, M), seg(M, 2 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.inserts).toEqual([]);
    expect(plan.stale).toEqual([]);
    expect(plan.carryOver).toHaveLength(2);
    expect(
      plan.carryOver.map((c) => [c.existingId, c.incomingIndex]).sort(),
    ).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('1→2 split: history follows one half, the other is a fresh insert', () => {
    // Existing 200 m way, OSM re-split into two 100 m segments.
    const existing: ExistingSegment[] = [{ id: 'x', coords: seg(0, 2 * M) }];
    const incoming = [seg(0, M), seg(M, 2 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toHaveLength(1);
    expect(plan.carryOver[0]!.existingId).toBe('x');
    expect(plan.inserts).toHaveLength(1); // the other half is new
    expect(plan.stale).toEqual([]); // the existing row was reused, not orphaned
  });

  it('uneven split: history follows the longer child, not the first/short stub', () => {
    // Existing 100 m row split into a 10 m stub (index 0) + 90 m main (index 1).
    // Both are fully contained (fraction 1), so ranking by fraction alone would
    // let the stub — first by index — steal the id. Overlap length picks the 90 m.
    const existing: ExistingSegment[] = [{ id: 'x', coords: seg(0, M) }];
    const incoming = [seg(0, 0.1 * M), seg(0.1 * M, M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toHaveLength(1);
    expect(plan.carryOver[0]!.existingId).toBe('x');
    expect(plan.carryOver[0]!.incomingIndex).toBe(1); // the 90 m main stretch
    expect(plan.inserts).toEqual([0]); // the 10 m stub is a fresh row
    expect(plan.stale).toEqual([]);
  });

  it('genuine short split: parent id follows the longer sub-floor child', () => {
    // A ~15 m connector split into 8 m (index 0) + 7 m (index 1) children. Both
    // are below 2·tolerance and neither is near-1:1 with the parent, but each is a
    // genuine contained overlap, so the parent's id must follow the longer child
    // rather than being marked stale with both children inserted fresh.
    const existing: ExistingSegment[] = [{ id: 'p', coords: seg(0, 0.15 * M) }];
    const incoming = [seg(0, 0.08 * M), seg(0.08 * M, 0.15 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toHaveLength(1);
    expect(plan.carryOver[0]!.existingId).toBe('p');
    expect(plan.carryOver[0]!.incomingIndex).toBe(0); // the 8 m child
    expect(plan.inserts).toEqual([1]); // the 7 m child is a fresh row
    expect(plan.stale).toEqual([]);
  });

  it('prefers a shorter exact match over a longer parallel one', () => {
    // Incoming 100 m way. Existing B lies exactly on its first 60 m; stale
    // existing A is a full-length carriageway 3 m to the side. A has the longer
    // overlap (~100 m vs ~60 m), so ranking by length alone would carry A's id
    // onto the incoming and drop B. Exactness must win: B keeps the road, A stales.
    const incomingLine: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: M, lng: 0 },
    ];
    const parallelA: LatLng[] = [
      { lat: 0, lng: 0.03 * M }, // ~3 m to the side, full length
      { lat: M, lng: 0.03 * M },
    ];
    const exactB: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0.6 * M, lng: 0 }, // exact, first 60 m only
    ];
    const existing: ExistingSegment[] = [
      { id: 'A', coords: parallelA },
      { id: 'B', coords: exactB },
    ];

    const plan = planReassignment(existing, [incomingLine]);

    expect(plan.carryOver).toEqual([
      { existingId: 'B', incomingIndex: 0, score: 1 },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.stale).toEqual(['A']);
  });

  it('2→1 merge: one id inherits the merged road, the other goes stale', () => {
    // Two existing 100 m segments merged into one 200 m way.
    const existing: ExistingSegment[] = [
      { id: 'a1', coords: seg(0, M) },
      { id: 'a2', coords: seg(M, 2 * M) },
    ];
    const incoming = [seg(0, 2 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toHaveLength(1);
    expect(['a1', 'a2']).toContain(plan.carryOver[0]!.existingId);
    expect(plan.inserts).toEqual([]);
    expect(plan.stale).toHaveLength(1); // the other existing row is orphaned
  });

  it('keeps the id of an unchanged sub-10 m segment (perfect match bypasses the floor)', () => {
    // A ~8 m connector/driveway re-imported unchanged. Its overlap length is
    // below the endpoint-leak floor, but a near-perfect containment is genuine at
    // any length, so it must still carry its id rather than go stale + reinsert.
    const existing: ExistingSegment[] = [
      { id: 'short', coords: seg(0, 0.08 * M) },
    ];
    const incoming = [seg(0, 0.08 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([
      { existingId: 'short', incomingIndex: 0, score: 1 },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('does not match two short segments that only touch at an endpoint', () => {
    // A ~10 m existing row and a ~10 m incoming row that are adjacent (share one
    // tip). Half of each is within the 5 m tolerance of the other's endpoint —
    // a false majority — but the shared length is only ~tolerance, below the
    // tolerance-aware floor, so identity must NOT carry onto the neighbour.
    const existing: ExistingSegment[] = [{ id: 's', coords: seg(0, 0.1 * M) }];
    const incoming = [seg(0.1 * M, 0.2 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['s']);
  });

  it('does not carry a short stub onto a long incoming that only touches its end', () => {
    // A ~9 m stale existing stub ending exactly where a normal ~100 m incoming
    // segment starts. `rev` clears the majority (a few stub samples fall within
    // tolerance of the shared tip), and scaling that small `fwd` by the long
    // incoming's length would inflate the covered length past the floor — but the
    // REAL shared length is ~0, so the min-of-both-directions floor must reject it
    // rather than leak the stub's UUID/history onto the adjacent new road.
    const existing: ExistingSegment[] = [
      { id: 'stub', coords: seg(0, 0.09 * M) },
    ];
    const incoming = [seg(0.09 * M, 0.09 * M + M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['stub']);
  });

  it('does not carry a sub-tolerance stub whose every sample touches a long incoming tip', () => {
    // A ~3 m stale stub (shorter than the 5 m tolerance) ending where a ~100 m
    // incoming segment starts. EVERY stub sample is within tolerance of the
    // incoming's tip, so rev === 1 and score === 1 — but the two share ~no real
    // length. The bypass keys on mutual coverage (fwd ≈ 0 here), so the length
    // floor still applies and the stub is stale, not carried onto the new road.
    const existing: ExistingSegment[] = [
      { id: 'micro', coords: seg(0, 0.03 * M) },
    ];
    const incoming = [seg(0.03 * M, 0.03 * M + M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['micro']);
  });

  it('keeps the id of an unchanged sub-floor segment with a sharp bend', () => {
    // A ~9 m service connector as an L: a 4.5 m east leg then a 4.5 m north leg.
    // Its end-to-end chord is only ~6.4 m, so a chord-based overlap would fall
    // below 0.9×9 and wrongly drop it; the arc-following real overlap measures the
    // full 9 m, so an idempotent re-import carries the id over.
    const d = 0.045 * M; // ~4.5 m per leg
    const bent = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: d },
      { lat: d, lng: d },
    ];
    const existing: ExistingSegment[] = [{ id: 'bend', coords: bent }];

    const plan = planReassignment(existing, [bent]);

    expect(plan.carryOver).toEqual([
      { existingId: 'bend', incomingIndex: 0, score: 1 },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('prefers the exact geometry match over index order for parallel neighbours', () => {
    // Two parallel carriageways ~3 m apart (within the 5 m tolerance), presented
    // to the DB in the opposite order from the incoming snapshot. Every cross-pair
    // scores a full overlap, so index order alone would hand A's id to B; the
    // separation tie-breaker keeps each id on its own exact geometry.
    const gap = 0.03 * M; // ~3 m lateral separation
    const north: LatLng[] = [
      { lat: gap, lng: 0 },
      { lat: gap, lng: M },
    ];
    const south: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: M },
    ];
    const existing: ExistingSegment[] = [
      { id: 'north', coords: north },
      { id: 'south', coords: south },
    ];
    // Incoming order is reversed relative to the existing rows.
    const incoming = [south, north];

    const plan = planReassignment(existing, incoming);

    expect(plan.stale).toEqual([]);
    expect(plan.inserts).toEqual([]);
    // north (existing) must keep its geometry: incoming index 1 is `north`.
    expect(
      plan.carryOver.map((c) => [c.existingId, c.incomingIndex]).sort(),
    ).toEqual([
      ['north', 1],
      ['south', 0],
    ]);
  });

  it('does not carry between two collinear sub-tolerance segments that only abut', () => {
    // A ~3 m existing connector (0–3 m) and a ~3 m incoming connector (3–6 m),
    // collinear and sharing only the junction. Both are shorter than the 5 m
    // tolerance, so every sample is within tolerance both ways (mutual ≈ 1) AND
    // the corresponding endpoints are ~3 m apart (endpoint proximity passes) —
    // yet the real collinear overlap is zero, so the bypass must NOT fire and the
    // stub is stale rather than carried onto the abutting road.
    const existing: ExistingSegment[] = [
      { id: 'abut', coords: seg(0, 0.03 * M) },
    ];
    const incoming = [seg(0.03 * M, 0.06 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['abut']);
  });

  it('does not carry between two short segments that only cross at a point', () => {
    // An ~8 m E–W existing segment and an ~8 m N–S incoming segment crossing at
    // their midpoints. Both are shorter than 2·tolerance, so every sample of each
    // is within tolerance of the other line — fwd === rev === 1, mutual === 1 —
    // yet they share ~no road length. The endpoint-agreement gate on the bypass
    // rejects it (their tips are ~√2·tolerance apart), so it stays stale.
    const d = 0.04 * M; // ~4 m half-length
    const existing: ExistingSegment[] = [
      {
        id: 'cross',
        coords: [
          { lat: 0, lng: -d },
          { lat: 0, lng: d },
        ],
      },
    ];
    const incoming = [
      [
        { lat: -d, lng: 0 },
        { lat: d, lng: 0 },
      ],
    ];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['cross']);
  });

  it('disjoint geometry: no carry-over — all inserts, all existing stale', () => {
    const existing: ExistingSegment[] = [{ id: 'far', coords: seg(0, M) }];
    // ~1° north — kilometres away, no overlap.
    const incoming = [seg(1, 1 + M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['far']);
  });

  it('does not carry identity on a sub-majority partial overlap', () => {
    // Two 100 m segments sharing only ~40 m — a mostly-different/extended
    // stretch. Neither direction reaches a strict majority, so no carry-over.
    const existing: ExistingSegment[] = [{ id: 'e', coords: seg(0, M) }];
    const incoming = [seg(0.6 * M, 1.6 * M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['e']);
  });

  it('handles an antimeridian-crossing segment without exploding', () => {
    // ~100 m segment straddling ±180°. A raw lng delta would read it as a
    // ~40,000 km edge and generate millions of samples; the wrapped delta keeps
    // it short so an unchanged re-import still carries the id over.
    const cross: LatLng[] = [
      { lat: 0, lng: 179.9995 },
      { lat: M, lng: -179.9995 },
    ];
    const existing: ExistingSegment[] = [{ id: 'am', coords: cross }];

    const plan = planReassignment(existing, [cross]);

    expect(plan.carryOver).toHaveLength(1);
    expect(plan.carryOver[0]!.existingId).toBe('am');
    expect(plan.stale).toEqual([]);
  });

  it('is deterministic on unchanged data (stable plan across runs)', () => {
    const existing: ExistingSegment[] = [
      { id: 'a', coords: seg(0, M) },
      { id: 'b', coords: seg(M, 2 * M) },
    ];
    const incoming = [seg(0, M), seg(M, 2 * M)];

    const first = planReassignment(existing, incoming);
    const second = planReassignment(existing, incoming);
    expect(first).toEqual(second);
  });
});
