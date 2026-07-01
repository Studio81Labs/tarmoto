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

  it('disjoint geometry: no carry-over — all inserts, all existing stale', () => {
    const existing: ExistingSegment[] = [{ id: 'far', coords: seg(0, M) }];
    // ~1° north — kilometres away, no overlap.
    const incoming = [seg(1, 1 + M)];

    const plan = planReassignment(existing, incoming);

    expect(plan.carryOver).toEqual([]);
    expect(plan.inserts).toEqual([0]);
    expect(plan.stale).toEqual(['far']);
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
