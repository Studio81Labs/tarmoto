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
    queues[QUEUE_NAMES.DATA_EXPORT].getFailed.mockResolvedValue([
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

  it('reports lastFailure: null when no failures are retained', async () => {
    const snapshot = await service.snapshot(true);
    for (const entry of snapshot.queues) {
      expect(entry.lastFailure).toBeNull();
    }
  });

  it('surfaces a degraded queue with synthetic failure entry instead of 500ing the snapshot', async () => {
    queues[QUEUE_NAMES.HAZARDS_CLEANUP].getJobCounts.mockRejectedValue(
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
