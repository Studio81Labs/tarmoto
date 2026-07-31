import {
  ALL_QUEUE_NAMES,
  JOB_NAMES,
  QUEUE_NAMES,
  RECURRING_PATTERNS,
} from './jobs.constants.js';

describe('jobs.constants', () => {
  it('exposes every required queue name from issue #276 acceptance criteria', () => {
    // The issue lists six queues by name; we add one more
    // (account-deletion-finalize) as a necessary support queue.
    // Drift here means a producer or processor will try to enqueue
    // into a queue that the rest of the system never registered.
    expect(ALL_QUEUE_NAMES).toEqual(
      expect.arrayContaining([
        'hazards.cleanup',
        'badges.recheck',
        'digest.weekly',
        'data-export',
        'account-deletion-sweep',
        'funzone-recompute',
      ]),
    );
    expect(ALL_QUEUE_NAMES).toContain('account-deletion-finalize');
  });

  it('has uniquely-named queues — duplicate names would silently merge in BullMQ', () => {
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length);
    // Issue #276 shipped ten queues; #496 added two model-eval queues.
    // Drift here means a producer or processor will try to enqueue
    // into a queue that the rest of the system never registered.
    // #781 added the OSM import queue; #779 the quality conflation; #867
    // removed the push-notification stub. Phase 3 moved poi.import wholly into
    // apps/ingest, dropping it from the backend registry (15 → 14). The IAP P0
    // store-billing reconciliation retry queue brings it back to 15.
    expect(ALL_QUEUE_NAMES).toHaveLength(15);
  });

  it('uses the same string for every QUEUE_NAMES key as the value in ALL_QUEUE_NAMES (no drift)', () => {
    for (const value of Object.values(QUEUE_NAMES)) {
      expect(ALL_QUEUE_NAMES).toContain(value);
    }
  });

  it('JOB_NAMES uses kebab/lowercase strings — they show up in dashboards and structured logs', () => {
    for (const name of Object.values(JOB_NAMES)) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('cron patterns parse as 5-field crontabs', () => {
    for (const pattern of Object.values(RECURRING_PATTERNS)) {
      expect(pattern.split(' ')).toHaveLength(5);
    }
  });
});
