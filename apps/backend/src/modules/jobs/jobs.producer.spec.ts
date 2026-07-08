import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { JobsProducer, POI_IMPORT_STAGGER_MS } from './jobs.producer.js';
import { JOB_NAMES, QUEUE_NAMES } from './jobs.constants.js';

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
    await producer.enqueuePoiImportRegion('CZ', 2, 'wk-1');
    expect(poiImport.add).toHaveBeenCalledWith(
      JOB_NAMES.POI_IMPORT_REGION,
      { code: 'CZ' },
      expect.objectContaining({
        // jobId scoped to the dispatch occurrence (wk-1): a dispatch retry
        // re-enqueues idempotently, but next week is a fresh occurrence.
        jobId: `${JOB_NAMES.POI_IMPORT_REGION}:wk-1:CZ`,
        delay: 2 * POI_IMPORT_STAGGER_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }),
    );
  });

  it('does not stagger the first region (index 0 → no delay)', async () => {
    await producer.enqueuePoiImportRegion('CZ', 0, 'wk-1');
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
