import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { QueueHealthService } from './queue-health.service.js';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from './jobs.constants.js';

interface FakeQueue {
  name: string;
  getJobCounts: jest.Mock;
  getFailed: jest.Mock;
}

function fakeQueue(name: string): FakeQueue {
  return {
    name,
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    }),
    getFailed: jest.fn().mockResolvedValue([]),
  };
}

describe('QueueHealthService', () => {
  let service: QueueHealthService;
  let queues: Record<string, FakeQueue>;

  beforeEach(async () => {
    queues = Object.fromEntries(
      ALL_QUEUE_NAMES.map((name) => [name, fakeQueue(name)]),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        QueueHealthService,
        ...ALL_QUEUE_NAMES.map((name) => ({
          provide: getQueueToken(name),
          useValue: queues[name],
        })),
      ],
    }).compile();
    service = moduleRef.get(QueueHealthService);
  });

  it('returns a snapshot with one entry per registered queue', async () => {
    const snapshot = await service.snapshot(true);
    expect(snapshot.queues).toHaveLength(ALL_QUEUE_NAMES.length);
    expect(snapshot.queues.map((q) => q.queue).sort()).toEqual(
      [...ALL_QUEUE_NAMES].sort(),
    );
    expect(snapshot.workers_enabled).toBe(true);
  });

  it('summarizes the most recent failure per queue', async () => {
    queues[QUEUE_NAMES.DATA_EXPORT]!.getFailed.mockResolvedValue([
      {
        id: 'failed-job-1',
        name: 'process',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason: 'Storage write failed: ENOSPC',
      },
    ]);
    const snapshot = await service.snapshot(true);
    const dataExport = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.DATA_EXPORT,
    )!;
    expect(dataExport.lastFailure).toEqual({
      job_id: 'failed-job-1',
      name: 'process',
      failed_at: '2026-04-30T12:00:00.000Z',
      attempts_made: 5,
      failed_reason: 'Storage write failed: ENOSPC',
    });
  });

  it('redacts the entity portion of jobIds so the public endpoint never leaks user UUIDs', async () => {
    // Producers set jobIds like `account-deletion-finalize:<user_uuid>`
    // for idempotency. The raw value must NOT reach the unauthenticated
    // /jobs/health response — for the account-deletion queue it would
    // tell the world which user is being purged under GDPR right now.
    queues[QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE]!.getFailed.mockResolvedValue([
      {
        id: 'account-deletion-finalize:5b8e7c3a-1234-4567-89ab-cdef01234567',
        name: 'finalize-user',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason: 'Stripe 503',
      },
    ]);
    queues[QUEUE_NAMES.DIGEST_WEEKLY]!.getFailed.mockResolvedValue([
      {
        id: 'digest-weekly:5b8e7c3a-1234-4567-89ab-cdef01234567:2026-W18',
        name: 'compose',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason: 'Resend 500',
      },
    ]);
    const snapshot = await service.snapshot(true);
    const accountDeletion = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE,
    )!;
    expect(accountDeletion.lastFailure!.job_id).toBe(
      'account-deletion-finalize:***',
    );
    // Multi-segment jobIds (e.g. digest-weekly:<user>:<window>) also
    // collapse everything after the first colon — the window is also
    // user-correlatable on small populations.
    const digest = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.DIGEST_WEEKLY,
    )!;
    expect(digest.lastFailure!.job_id).toBe('digest-weekly:***');
    // Sanity: no user UUID appears anywhere in the snapshot payload.
    expect(JSON.stringify(snapshot)).not.toMatch(
      /5b8e7c3a-1234-4567-89ab-cdef01234567/,
    );
  });

  it('scrubs PII (UUIDs, Stripe ids, emails, opaque tokens) from failed_reason before publishing', async () => {
    queues[QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE]!.getFailed.mockResolvedValue([
      {
        id: 'account-deletion-finalize:5b8e7c3a-1234-4567-89ab-cdef01234567',
        name: 'finalize-user',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason:
          'Stripe 503: cancel sub_1NaBcDeFgHiJkL for customer cus_xYzAbCdEf failed; rider rider@tarmoto.app (5b8e7c3a-1234-4567-89ab-cdef01234567)',
      },
    ]);
    const snapshot = await service.snapshot(true);
    const entry = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE,
    )!;
    const reason = entry.lastFailure!.failed_reason!;
    // The shape that on-call cares about (Stripe 503, the verb, the
    // word "rider") survives so the alert is still triageable.
    expect(reason).toMatch(/Stripe 503/);
    expect(reason).toMatch(/cancel/);
    // PII is gone:
    expect(reason).not.toMatch(/sub_1NaBcDeFgHiJkL/);
    expect(reason).not.toMatch(/cus_xYzAbCdEf/);
    expect(reason).not.toMatch(/rider@tarmoto\.app/);
    expect(reason).not.toMatch(/5b8e7c3a-1234-4567-89ab-cdef01234567/);
    expect(reason).toMatch(/sub_\*\*\*/);
    expect(reason).toMatch(/cus_\*\*\*/);
    expect(reason).toMatch(/<email>/);
    expect(reason).toMatch(/<uuid>/);
  });

  it('caps failed_reason length so a stack-trace-as-message cannot ferry deep context through the public endpoint', async () => {
    const giant = 'X'.repeat(2000);
    queues[QUEUE_NAMES.DATA_EXPORT]!.getFailed.mockResolvedValue([
      {
        id: 'data-export:abc-123',
        name: 'process',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason: giant,
      },
    ]);
    const snapshot = await service.snapshot(true);
    const entry = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.DATA_EXPORT,
    )!;
    // 240-char body + 1-char ellipsis terminator.
    expect(entry.lastFailure!.failed_reason!.length).toBeLessThanOrEqual(241);
  });

  it('passes BullMQ-auto-generated numeric jobIds through unchanged (no user data to redact)', async () => {
    queues[QUEUE_NAMES.FUNZONE_RECOMPUTE]!.getFailed.mockResolvedValue([
      {
        id: '12345',
        name: 'run',
        finishedOn: new Date('2026-04-30T12:00:00Z').valueOf(),
        attemptsMade: 5,
        failedReason: 'boom',
      },
    ]);
    const snapshot = await service.snapshot(true);
    const entry = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.FUNZONE_RECOMPUTE,
    )!;
    expect(entry.lastFailure!.job_id).toBe('12345');
  });

  it('reports lastFailure: null when no failures are retained', async () => {
    const snapshot = await service.snapshot(true);
    for (const entry of snapshot.queues) {
      expect(entry.lastFailure).toBeNull();
    }
  });

  it('surfaces a degraded queue with synthetic failure entry instead of 500ing the snapshot', async () => {
    queues[QUEUE_NAMES.HAZARDS_CLEANUP]!.getJobCounts.mockRejectedValue(
      new Error('Redis connection refused'),
    );
    const snapshot = await service.snapshot(true);
    const degraded = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.HAZARDS_CLEANUP,
    )!;
    expect(degraded.lastFailure).not.toBeNull();
    expect(degraded.lastFailure!.failed_reason).toMatch(
      /Redis connection refused/,
    );
    // Other queues are still reported.
    const healthy = snapshot.queues.find(
      (q) => q.queue === QUEUE_NAMES.DATA_EXPORT,
    )!;
    expect(healthy.lastFailure).toBeNull();
  });

  it('echoes the workers_enabled flag the caller passes (so the controller can surface deployment shape)', async () => {
    const a = await service.snapshot(true);
    const b = await service.snapshot(false);
    expect(a.workers_enabled).toBe(true);
    expect(b.workers_enabled).toBe(false);
  });
});
