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

/**
 * Stands in for the ad-hoc `Queue` that `JobsScheduler#retiredQueueFor`
 * constructs for a retired queue name. `removeJobScheduler`/`close` are the
 * only two calls the retired-scheduler cleanup makes against it.
 */
interface FakeRetiredQueue {
  removeJobScheduler: jest.Mock;
  close: jest.Mock;
}

function fakeRetiredQueue(): FakeRetiredQueue {
  return {
    removeJobScheduler: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

/** Cast target for spying on the `protected retiredQueueFor` seam below. */
interface SchedulerWithRetiredQueueFor {
  retiredQueueFor: (name: string) => FakeRetiredQueue;
}

async function buildScheduler(workersEnabled: boolean): Promise<{
  scheduler: JobsScheduler;
  queues: Record<string, FakeQueue>;
  retiredQueue: FakeRetiredQueue;
  retiredQueueFor: jest.SpyInstance;
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
  const scheduler = moduleRef.get(JobsScheduler);
  // Stub the ad-hoc-Queue seam for every test, not just the one that asserts
  // on it directly: `removeRetiredSchedulers` runs unconditionally whenever
  // workers are enabled, and the real implementation would otherwise try to
  // open a live BullMQ `Queue` off these fake queues' non-existent
  // `.opts.connection` (`FakeQueue` above carries no `opts` at all).
  const retiredQueue = fakeRetiredQueue();
  const retiredQueueFor = jest
    .spyOn(
      scheduler as unknown as SchedulerWithRetiredQueueFor,
      'retiredQueueFor',
    )
    .mockReturnValue(retiredQueue);
  return {
    scheduler,
    queues,
    retiredQueue,
    retiredQueueFor,
  };
}

describe('JobsScheduler', () => {
  it('registers the four recurring schedules listed in issue #276 (hazard hourly, badge nightly, digest hourly dispatcher, account-deletion daily) plus the funzone weekly recompute', async () => {
    const { scheduler, queues } = await buildScheduler(true);
    await scheduler.onApplicationBootstrap();
    expect(
      queues[QUEUE_NAMES.HAZARDS_CLEANUP]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'hazards.cleanup.run',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.BADGES_RECHECK]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'badges.recheck.dispatch',
      { pattern: RECURRING_PATTERNS.DAILY_0230 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.DIGEST_WEEKLY]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'digest.weekly.dispatch',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    // Dispatch outranks the compose jobs it shares the queue with, so a large
    // fan-out can't delay it past the catch-up horizon.
    const digestArgs = queues[QUEUE_NAMES.DIGEST_WEEKLY]!.upsertJobScheduler
      .mock.calls[0] as [string, unknown, { opts?: { priority?: number } }];
    expect(digestArgs[2].opts?.priority).toBe(DIGEST_DISPATCH_PRIORITY);
    expect(
      queues[QUEUE_NAMES.ACCOUNT_DELETION_SWEEP]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'account-deletion-sweep.run',
      { pattern: RECURRING_PATTERNS.DAILY_0330 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.FUNZONE_RECOMPUTE]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'funzone-recompute.run',
      { pattern: RECURRING_PATTERNS.WEEKLY_MON_0400 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.MODEL_EVAL_RECONCILE]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'model-eval-reconcile.run',
      { pattern: RECURRING_PATTERNS.HOURLY },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.MODEL_EVAL_AGREEMENT]!.upsertJobScheduler,
    ).toHaveBeenCalledWith(
      'model-eval-agreement.run',
      { pattern: RECURRING_PATTERNS.WEEKLY_MON_0500 },
      expect.any(Object),
    );
    expect(
      queues[QUEUE_NAMES.ROAD_IMPORT]!.upsertJobScheduler,
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
      expect(queues[name]!.upsertJobScheduler).not.toHaveBeenCalled();
    }
  });

  it('one queue failing to register does not block the others (Redis hiccup at boot is not fatal)', async () => {
    const { scheduler, queues } = await buildScheduler(true);
    queues[QUEUE_NAMES.HAZARDS_CLEANUP]!.upsertJobScheduler.mockRejectedValue(
      new Error('Redis unreachable'),
    );
    await expect(scheduler.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(
      queues[QUEUE_NAMES.BADGES_RECHECK]!.upsertJobScheduler,
    ).toHaveBeenCalled();
    expect(
      queues[QUEUE_NAMES.DIGEST_WEEKLY]!.upsertJobScheduler,
    ).toHaveBeenCalled();
  });

  it('removes the retired osm.import.run scheduler left behind by the osm.import -> road.import queue rename', async () => {
    const { scheduler, retiredQueue, retiredQueueFor } =
      await buildScheduler(true);

    await scheduler.onApplicationBootstrap();

    // The old queue is no longer injected (dropped along with
    // QUEUE_NAMES.OSM_IMPORT), so the cleanup must bind an ad-hoc Queue to
    // the bare retired name rather than reach for an `@InjectQueue`d one.
    expect(retiredQueueFor).toHaveBeenCalledWith('osm.import');
    // `${queue}.${job}` was the old scheduler key; `run` was the job name.
    expect(retiredQueue.removeJobScheduler).toHaveBeenCalledWith(
      'osm.import.run',
    );
    // The ad-hoc connection must not outlive this one cleanup call.
    expect(retiredQueue.close).toHaveBeenCalledTimes(1);
  });
});
