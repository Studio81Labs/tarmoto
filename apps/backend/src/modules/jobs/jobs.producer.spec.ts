/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
  let dataExport: QueueMock;
  let accountDeletionFinalize: QueueMock;
  let pushNotification: QueueMock;
  let badgesRecheck: QueueMock;
  let digestWeekly: QueueMock;

  beforeEach(async () => {
    dataExport = makeQueue(QUEUE_NAMES.DATA_EXPORT);
    accountDeletionFinalize = makeQueue(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE);
    pushNotification = makeQueue(QUEUE_NAMES.PUSH_NOTIFICATION);
    badgesRecheck = makeQueue(QUEUE_NAMES.BADGES_RECHECK);
    digestWeekly = makeQueue(QUEUE_NAMES.DIGEST_WEEKLY);

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobsProducer,
        {
          provide: getQueueToken(QUEUE_NAMES.DATA_EXPORT),
          useValue: dataExport,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.ACCOUNT_DELETION_FINALIZE),
          useValue: accountDeletionFinalize,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.PUSH_NOTIFICATION),
          useValue: pushNotification,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.BADGES_RECHECK),
          useValue: badgesRecheck,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.DIGEST_WEEKLY),
          useValue: digestWeekly,
        },
      ],
    }).compile();

    producer = moduleRef.get(JobsProducer);
  });

  it('enqueues data-export with a deterministic jobId on request_id', async () => {
    await producer.enqueueDataExport({
      request_id: 'req-1',
      user_id: 'u1',
    });
    expect(dataExport.add).toHaveBeenCalledWith(
      JOB_NAMES.DATA_EXPORT_PROCESS,
      { request_id: 'req-1', user_id: 'u1' },
      expect.objectContaining({
        jobId: 'data-export:req-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
      }),
    );
  });

  it('enqueues account-deletion-finalize with a per-user idempotency key', async () => {
    await producer.enqueueAccountDeletionFinalize({ user_id: 'u-42' });
    expect(accountDeletionFinalize.add).toHaveBeenCalledWith(
      JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER,
      { user_id: 'u-42' },
      expect.objectContaining({
        jobId: 'account-deletion-finalize:u-42',
      }),
    );
  });

  it('does NOT set a jobId on push notifications — multi-event, multi-message', async () => {
    await producer.enqueuePushNotification({
      user_id: 'u1',
      device_token: 'tok-abcdef',
      title: 'Hazard ahead',
      body: 'Pothole reported on your route',
    });
    expect(pushNotification.add).toHaveBeenCalledWith(
      JOB_NAMES.PUSH_NOTIFICATION_SEND,
      expect.objectContaining({ user_id: 'u1' }),
      expect.not.objectContaining({ jobId: expect.anything() }),
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
});
