import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { JobsProducer } from './jobs.producer.js';
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

  beforeEach(async () => {
    accountDeletionFinalize = makeQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE);
    badgesRecheck = makeQueue(QUEUE_NAMES.BADGES_RECHECK);
    digestWeekly = makeQueue(QUEUE_NAMES.DIGEST_WEEKLY);
    qualityConflation = makeQueue(QUEUE_NAMES.QUALITY_CONFLATION);

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
