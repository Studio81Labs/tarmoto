import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { JobsProducer, POI_IMPORT_STAGGER_MS } from './jobs.producer.js';
import { JOB_NAMES, QUEUE_NAMES } from './jobs.constants.js';
import { DIGEST_COMPOSE_PRIORITY } from './jobs.config.js';

interface QueueMock {
  add: jest.Mock;
  name: string;
}

function makeQueue(name: string): QueueMock {
  return { add: jest.fn().mockResolvedValue({ id: 'job-1' }), name };
}

describe('JobsProducer', () => {
  let producer: JobsProducer;
  let accountDeletionFinalize: QueueMock;
  let badgesRecheck: QueueMock;
  let digestWeekly: QueueMock;
  let qualityConflation: QueueMock;
  let poiImport: QueueMock;

  beforeEach(async () => {
    accountDeletionFinalize = makeQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE);
    badgesRecheck = makeQueue(QUEUE_NAMES.BADGES_RECHECK);
    digestWeekly = makeQueue(QUEUE_NAMES.DIGEST_WEEKLY);
    qualityConflation = makeQueue(QUEUE_NAMES.QUALITY_CONFLATION);
    poiImport = makeQueue(QUEUE_NAMES.POI_IMPORT);

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobsProducer,
        {
          provide: getQueueToken(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE),
          useValue: accountDeletionFinalize,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.BADGES_RECHECK),
          useValue: badgesRecheck,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.DIGEST_WEEKLY),
          useValue: digestWeekly,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.QUALITY_CONFLATION),
          useValue: qualityConflation,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.POI_IMPORT),
          useValue: poiImport,
        },
      ],
    }).compile();

    producer = moduleRef.get(JobsProducer);
  });

  it('enqueues account-deletion-finalize with a per-user idempotency key', async () => {
    await producer.enqueueAccountDeletionFinalize({ user_id: 'u-42' });
    expect(accountDeletionFinalize.add).toHaveBeenCalledWith(
      JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER,
      { user_id: 'u-42' },
      expect.objectContaining({
        jobId: 'account-deletion-finalize:u-42',
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
      }),
    );
  });

  it('uses jobId user_id+window for digest jobs to dedupe across hourly dispatches', async () => {
    await producer.enqueueDigestWeeklyCompose({
      user_id: 'u1',
      for_local_window: '2026-W18',
    });
    expect(digestWeekly.add).toHaveBeenCalledWith(
      JOB_NAMES.DIGEST_WEEKLY_COMPOSE,
      { user_id: 'u1', for_local_window: '2026-W18' },
      expect.objectContaining({
        jobId: 'digest-weekly:u1:2026-W18',
        // Lower priority than the dispatch job on the shared queue so a large
        // compose fan-out can't starve the hourly dispatcher.
        priority: DIGEST_COMPOSE_PRIORITY,
      }),
    );
  });

  it('uses a distinct digest-resend jobId so a resend never dedups against the failed weekly job', async () => {
    await producer.enqueueDigestResend({
      user_id: 'u1',
      for_local_window: 'resend-1751702400000',
      window_start: '2026-06-28T08:00:00.000Z',
      window_end: '2026-07-05T08:00:00.000Z',
    });
    expect(digestWeekly.add).toHaveBeenCalledWith(
      JOB_NAMES.DIGEST_WEEKLY_COMPOSE,
      expect.objectContaining({ user_id: 'u1' }),
      expect.objectContaining({
        jobId: 'digest-resend:u1:resend-1751702400000',
        priority: DIGEST_COMPOSE_PRIORITY,
      }),
    );
  });

  it('uses jobId user_id for badge recheck so duplicate dispatches collapse', async () => {
    await producer.enqueueBadgesRecheckUser({ user_id: 'u1' });
    expect(badgesRecheck.add).toHaveBeenCalledWith(
      JOB_NAMES.BADGES_RECHECK_USER,
      { user_id: 'u1' },
      expect.objectContaining({ jobId: 'badges-recheck:u1' }),
    );
  });

  it('enqueues a staggered per-region POI import with a dispatch-scoped jobId (delay = index * stagger, attempts 3)', async () => {
    // A real scheduler job.id contains colons (`repeat:<hash>:<ts>`).
    await producer.enqueuePoiImportRegion('fsq', 'CZ', 2, 'repeat:sched:123');
    expect(poiImport.add).toHaveBeenCalledWith(
      JOB_NAMES.POI_IMPORT_REGION,
      { source: 'fsq', code: 'CZ' },
      expect.objectContaining({
        // jobId scoped to the dispatch occurrence + source + colon-free (BullMQ
        // reserves `:`): a dispatch retry re-enqueues idempotently, next week is
        // fresh, and the same country from two sources stays two distinct jobs.
        jobId: 'import-region_repeat_sched_123_fsq_CZ',
        delay: 2 * POI_IMPORT_STAGGER_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }),
    );
    const opts = (
      poiImport.add.mock.calls[0] as [string, unknown, { jobId?: string }]
    )[2];
    expect(opts.jobId).not.toContain(':');
  });

  it('does not stagger the first region (index 0 → no delay)', async () => {
    await producer.enqueuePoiImportRegion('osm', 'CZ', 0, 'wk-1');
    const opts = (
      poiImport.add.mock.calls[0] as [string, unknown, { delay: number }]
    )[2];
    expect(opts.delay).toBe(0);
  });

  it('enqueues a quality-conflation run with no jobId (fresh per import)', async () => {
    await producer.enqueueQualityConflation();
    expect(qualityConflation.add).toHaveBeenCalledWith(
      JOB_NAMES.QUALITY_CONFLATION_RUN,
      {},
      expect.objectContaining({ attempts: 5 }),
    );
    // No jobId → each successful import enqueues a distinct run.
    expect(
      (
        qualityConflation.add.mock.calls[0] as [
          string,
          unknown,
          { jobId?: string },
        ]
      )[2].jobId,
    ).toBeUndefined();
  });
});
