import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { JobsScheduler } from './jobs.scheduler.js';
import {
  ALL_QUEUE_NAMES,
  QUEUE_NAMES,
  RECURRING_PATTERNS,
} from './jobs.constants.js';
import { DIGEST_DISPATCH_PRIORITY } from './jobs.config.js';
import { JOBS_CONFIG_TOKEN, type JobsConfig } from './jobs.tokens.js';

interface FakeQueue {
  name: string;
  upsertJobScheduler: jest.Mock;
  removeJobScheduler: jest.Mock;
}

function fakeQueue(name: string): FakeQueue {
  return {
    name,
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    removeJobScheduler: jest.fn().mockResolvedValue(false),
  };
}

async function buildScheduler(workersEnabled: boolean): Promise<{
  scheduler: JobsScheduler;
  queues: Record<string, FakeQueue>;
}> {
  const queues = Object.fromEntries(
    ALL_QUEUE_NAMES.map((name) => [name, fakeQueue(name)]),
  ) as Record<string, FakeQueue>;
  const config: JobsConfig = {
    connection: { host: 'localhost', port: 6379 },
    workersEnabled,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      JobsScheduler,
      ...ALL_QUEUE_NAMES.map((name) => ({
        provide: getQueueToken(name),
        useValue: queues[name],
      })),
      { provide: JOBS_CONFIG_TOKEN, useValue: config },
    ],
  }).compile();
  return {
    scheduler: moduleRef.get(JobsScheduler),
    queues,
  };
}

describe('JobsScheduler', () => {
  it('registers the four recurring schedules listed in issue #276 (hazard hourly, badge nightly, digest hourly dispatcher, account-deletion daily) plus the funzone weekly recompute', async () => {
    const { scheduler, queues } = await buildScheduler(true);
    await scheduler.onApplicationBootstrap();
    expect(
      queues[QUEUE_NAMES.HAZARDS_CLEANUP].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'hazards.cleanup.run',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.BADGES_RECHECK].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'badges.recheck.dispatch',
      { pattern: RECURRING_PATTERNS.DAILY_0230 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.DIGEST_WEEKLY].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'digest.weekly.dispatch',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    // Dispatch outranks the compose jobs it shares the queue with, so a large
    // fan-out can't delay it past the catch-up horizon.
    const digestArgs = queues[QUEUE_NAMES.DIGEST_WEEKLY].upsertJobScheduler.mock
      .calls[0] as [string, unknown, { opts?: { priority?: number } }];
    expect(digestArgs[2].opts?.priority).toBe(DIGEST_DISPATCH_PRIORITY);
    expect(
      queues[QUEUE_NAMES.ACCOUNT_DELETION_SWEEP].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'account-deletion-sweep.run',
      { pattern: RECURRING_PATTERNS.DAILY_0330 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.FUNZONE_RECOMPUTE].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'funzone-recompute.run',
      { pattern: RECURRING_PATTERNS.WEEKLY_MON_0400 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.MODEL_EVAL_RECONCILE].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'model-eval-reconcile.run',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.MODEL_EVAL_AGREEMENT].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'model-eval-agreement.run',
      { pattern: RECURRING_PATTERNS.WEEKLY_MON_0500 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.ROAD_IMPORT].upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'road.import.run',
      { pattern: RECURRING_PATTERNS.WEEKLY_SUN_0100 },
      expect.any(Object),
    );
  });

  it('skips schedule registration entirely when workers are disabled (split deployment API container)', async () => {
    const { scheduler, queues } = await buildScheduler(false);
    await scheduler.onApplicationBootstrap();
    for (const name of ALL_QUEUE_NAMES) {
      expect(queues[name].upsertJobScheduler).not.toHaveBeenCalled();
    }
  });

  it('one queue failing to register does not block the others (Redis hiccup at boot is not fatal)', async () => {
    const { scheduler, queues } = await buildScheduler(true);
    queues[QUEUE_NAMES.HAZARDS_CLEANUP].upsertJobScheduler.mockRejectedValue(
      new Error('Redis unreachable'),
    );
    await expect(scheduler.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(
      queues[QUEUE_NAMES.BADGES_RECHECK].upsertJobScheduler,
    ).toHaveBeenCalled();
    expect(
      queues[QUEUE_NAMES.DIGEST_WEEKLY].upsertJobScheduler,
    ).toHaveBeenCalled();
  });
});
