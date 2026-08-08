import {
  TRIAL_ELIGIBLE_PREDICATE,
  TRIAL_MARKER_COLUMN,
  trialMarkerStamp,
} from './trial-consumption.js';

describe('trial consumption vocabulary (#1132)', () => {
  it('stamps MONOTONICALLY — COALESCE, never a bare NOW()', () => {
    // The property the whole module exists for. The marker records when the
    // rider's single trial was consumed, and every writer can fire more than
    // once: redeliveries, later `updated` events of a subscription that once had
    // a trial, the fallback stamp. A bare `NOW()` would walk the date forward on
    // each one, so any eligibility window keyed off it never closes and the
    // record of when the trial was actually used is destroyed.
    const sql = trialMarkerStamp()();
    expect(sql).toBe('COALESCE(billing_trial_used_at, NOW())');
    expect(sql).toContain('COALESCE');
    expect(sql).not.toMatch(/^\s*NOW\(\)\s*$/);
  });

  it('returns a FACTORY, which is the shape TypeORM `.set()` needs', () => {
    // A plain string would be persisted literally rather than evaluated as SQL.
    expect(typeof trialMarkerStamp()).toBe('function');
  });

  it('guards eligibility on the SAME column it stamps', () => {
    // Two halves of one rule, and they drifted apart before: the guard decides
    // whether a trial may be GRANTED, the stamp records that it WAS. A guard
    // naming a different column than the stamp grants a second trial or refuses
    // a first, and nothing in either half would look wrong on its own.
    expect(TRIAL_ELIGIBLE_PREDICATE).toContain(TRIAL_MARKER_COLUMN);
    expect(trialMarkerStamp()()).toContain(TRIAL_MARKER_COLUMN);
  });

  it('expresses eligibility as IS NULL — unset means unused', () => {
    expect(TRIAL_ELIGIBLE_PREDICATE).toBe('billing_trial_used_at IS NULL');
  });
});
