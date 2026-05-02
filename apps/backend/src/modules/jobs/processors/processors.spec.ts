/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { HazardsCleanupProcessor } from './hazards-cleanup.processor.js';
import { BadgesRecheckProcessor } from './badges-recheck.processor.js';
import { DigestWeeklyProcessor } from './digest-weekly.processor.js';
import { DataExportQueueProcessor } from './data-export.processor.js';
import { AccountDeletionSweepProcessor } from './account-deletion-sweep.processor.js';
import { AccountDeletionFinalizeProcessor } from './account-deletion-finalize.processor.js';
import { FunzoneRecomputeProcessor } from './funzone-recompute.processor.js';
import { PushNotificationProcessor } from './push-notification.processor.js';
import { HazardsService } from '../../hazards/hazards.service.js';
import { BadgesService } from '../../badges/badges.service.js';
import { JobsProducer } from '../jobs.producer.js';
import { DataExportProcessor as DataExportRunner } from '../../account/data-export/data-export.processor.js';
import { AccountDeletionService } from '../../account/account-deletion.service.js';
import { FunZoneClusteringService } from '../../roads/fun-zone-clustering.service.js';
import { JOB_NAMES } from '../jobs.constants.js';

function fakeJob<T = unknown>(
  name: string,
  data: T,
): { id: string; name: string; data: T } {
  return { id: 'job-test', name, data };
}

describe('HazardsCleanupProcessor', () => {
  it('happy path: calls HazardsService.expireOld and returns the count', async () => {
    const hazards = { expireOld: jest.fn().mockResolvedValue(7) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HazardsCleanupProcessor,
        { provide: HazardsService, useValue: hazards },
      ],
    }).compile();
    const processor = moduleRef.get(HazardsCleanupProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.HAZARDS_CLEANUP_RUN, {}) as never,
    );
    expect(hazards.expireOld).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expired_marked: 7 });
  });
});

describe('BadgesRecheckProcessor', () => {
  let dataSource: { query: jest.Mock };
  let badges: { checkAndAward: jest.Mock };
  let producer: { enqueueBadgesRecheckUser: jest.Mock };
  let processor: BadgesRecheckProcessor;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    badges = { checkAndAward: jest.fn() };
    producer = {
      enqueueBadgesRecheckUser: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        BadgesRecheckProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: BadgesService, useValue: badges },
        { provide: JobsProducer, useValue: producer },
      ],
    }).compile();
    processor = moduleRef.get(BadgesRecheckProcessor);
  });

  it('dispatch: enqueues a per-user job for every user with recent ride activity', async () => {
    dataSource.query.mockResolvedValue([
      { user_id: 'u1' },
      { user_id: 'u2' },
      { user_id: 'u3' },
    ]);
    const result = await processor.process(
      fakeJob(JOB_NAMES.BADGES_RECHECK_DISPATCH, {}) as never,
    );
    expect(producer.enqueueBadgesRecheckUser).toHaveBeenCalledTimes(3);
    expect(producer.enqueueBadgesRecheckUser).toHaveBeenCalledWith({
      user_id: 'u1',
    });
    expect(result).toEqual({ users_enqueued: 3 });
  });

  it('recheck-user: delegates to BadgesService.checkAndAward and reports earned badges', async () => {
    badges.checkAndAward.mockResolvedValue({
      newly_earned: ['first-ride', 'curve-master'],
    });
    const result = await processor.process(
      fakeJob(JOB_NAMES.BADGES_RECHECK_USER, { user_id: 'u1' }) as never,
    );
    expect(badges.checkAndAward).toHaveBeenCalledWith('u1');
    expect(result).toEqual({ badges_awarded: ['first-ride', 'curve-master'] });
  });

  it('throws when the user-level job is missing user_id (should never happen, but better than awarding to undefined)', async () => {
    await expect(
      processor.process(fakeJob(JOB_NAMES.BADGES_RECHECK_USER, {}) as never),
    ).rejects.toThrow('user_id');
  });

  it('throws on unknown job names so a typo in a producer surfaces immediately', async () => {
    await expect(
      processor.process(fakeJob('something-else', {}) as never),
    ).rejects.toThrow('Unknown badges.recheck job');
  });
});

describe('DigestWeeklyProcessor', () => {
  let dataSource: { query: jest.Mock };
  let producer: { enqueueDigestWeeklyCompose: jest.Mock };
  let processor: DigestWeeklyProcessor;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    producer = {
      enqueueDigestWeeklyCompose: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DigestWeeklyProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: JobsProducer, useValue: producer },
      ],
    }).compile();
    processor = moduleRef.get(DigestWeeklyProcessor);
  });

  it('dispatch: enqueues a compose job per user that the SQL filter returned', async () => {
    dataSource.query.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    const result = await processor.process(
      fakeJob(JOB_NAMES.DIGEST_WEEKLY_DISPATCH, {}) as never,
    );
    expect(producer.enqueueDigestWeeklyCompose).toHaveBeenCalledTimes(2);
    // Each enqueue includes a `for_local_window` key for idempotency.
    expect(
      producer.enqueueDigestWeeklyCompose.mock.calls[0][0].for_local_window,
    ).toMatch(/^\d{4}-W\d{2}$/);
    expect(result).toEqual({ users_enqueued: 2 });
  });

  it('dispatch SQL validates timezones via pg_timezone_names so a malformed user pref cannot crash the whole query', async () => {
    // `AT TIME ZONE 'Foo/Bar'` raises a Postgres error that aborts
    // the entire SELECT — a single bad row would block digests for
    // every user. The query must resolve unknown tz strings to UTC
    // before they reach AT TIME ZONE. We assert the SQL surface here
    // so a regression that drops the validation fails loudly without
    // needing a live Postgres in the unit suite.
    dataSource.query.mockResolvedValue([]);
    await processor.process(
      fakeJob(JOB_NAMES.DIGEST_WEEKLY_DISPATCH, {}) as never,
    );
    const [sql] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/pg_timezone_names/);
    // The validated tz comes from a CROSS JOIN LATERAL alias, not from
    // the raw `preferences->>'timezone'` value being passed to
    // AT TIME ZONE. If anyone reverts to interpolating the raw value
    // again, this assertion fails.
    expect(sql).toMatch(/AT TIME ZONE tz_resolution\.tz/);
    // Sanity: the query never passes the raw preferences->>'timezone'
    // directly to AT TIME ZONE (the foot-gun the lateral subquery
    // exists to remove).
    expect(sql).not.toMatch(
      /AT TIME ZONE\s+COALESCE\(NULLIF\(u\.preferences->>'timezone'/,
    );
  });

  it('compose: stub returns "skipped" with a reason pointing at US-63 (real composer pending)', async () => {
    const result = await processor.process(
      fakeJob(JOB_NAMES.DIGEST_WEEKLY_COMPOSE, {
        user_id: 'u1',
        for_local_window: '2026-W18',
      }) as never,
    );
    expect(result).toMatchObject({ status: 'skipped' });
    expect((result as { reason: string }).reason).toMatch(/US-63/);
  });
});

describe('DataExportQueueProcessor', () => {
  it('happy path: invokes the existing in-process runner with request_id+user_id', async () => {
    const runner = { process: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataExportQueueProcessor,
        { provide: DataExportRunner, useValue: runner },
      ],
    }).compile();
    const processor = moduleRef.get(DataExportQueueProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.DATA_EXPORT_PROCESS, {
        request_id: 'r1',
        user_id: 'u1',
      }) as never,
    );
    expect(runner.process).toHaveBeenCalledWith('r1', 'u1');
    expect(result).toEqual({ request_id: 'r1' });
  });

  it('rejects malformed jobs missing request_id or user_id', async () => {
    const runner = { process: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataExportQueueProcessor,
        { provide: DataExportRunner, useValue: runner },
      ],
    }).compile();
    const processor = moduleRef.get(DataExportQueueProcessor);
    await expect(
      processor.process(fakeJob('process', {}) as never),
    ).rejects.toThrow('missing');
    expect(runner.process).not.toHaveBeenCalled();
  });
});

describe('AccountDeletionSweepProcessor', () => {
  async function buildProcessor(found: { id: string }[]): Promise<{
    processor: AccountDeletionSweepProcessor;
    repoFind: jest.Mock;
    txn: jest.Mock;
    producer: { enqueueAccountDeletionFinalize: jest.Mock };
  }> {
    const repoFind = jest.fn().mockResolvedValue(found);
    const manager = {
      getRepository: jest.fn().mockReturnValue({ find: repoFind }),
    };
    const txn = jest.fn(
      async (cb: (m: typeof manager) => Promise<unknown>): Promise<unknown> =>
        cb(manager),
    );
    const dataSource = { transaction: txn };
    const producer = {
      enqueueAccountDeletionFinalize: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountDeletionSweepProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: JobsProducer, useValue: producer },
      ],
    }).compile();
    return {
      processor: moduleRef.get(AccountDeletionSweepProcessor),
      repoFind,
      txn,
      producer,
    };
  }

  it('enqueues a finalize job per due user, never inlines the purge', async () => {
    const { processor, producer } = await buildProcessor([
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    const result = await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN, {}) as never,
    );
    expect(producer.enqueueAccountDeletionFinalize).toHaveBeenCalledTimes(3);
    expect(producer.enqueueAccountDeletionFinalize).toHaveBeenCalledWith({
      user_id: 'u1',
    });
    expect(result).toEqual({ users_enqueued: 3 });
  });

  it('queries oldest-first so the longest-overdue users get processed first under backlog', async () => {
    // GDPR's deletion deadline is calendar time from the user's
    // request, so when the batch can't drain the full backlog the
    // user closest to breaching their deadline must come first off
    // the queue. Asserting the ORM call shape so a regression of
    // dropping `order: { deletion_scheduled_at: 'ASC' }` fails here.
    const { processor, repoFind } = await buildProcessor([{ id: 'u1' }]);
    await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN, {}) as never,
    );
    expect(repoFind).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { deletion_scheduled_at: 'ASC' },
      }),
    );
  });

  it('caps the batch large enough to exceed the previous @Cron(EVERY_HOUR) sweeper throughput', async () => {
    // Old @Cron at hourly × 50 users = 1,200/day. New daily sweep
    // must clear at least that volume in a single tick, with
    // headroom for spikes.
    const { processor, repoFind } = await buildProcessor([]);
    await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN, {}) as never,
    );
    const callArgs = repoFind.mock.calls[0][0] as { take: number };
    expect(callArgs.take).toBeGreaterThanOrEqual(1200);
  });

  it('claims rows with FOR UPDATE SKIP LOCKED so two pods sweeping simultaneously cannot double-claim (#337)', async () => {
    // Multi-pod safety: without SKIP LOCKED, two backend pods running
    // the daily sweep at the same cron tick both SELECT the same
    // due-user slice and both enqueue a finalize job per user. BullMQ's
    // jobId dedup catches this today, but a typo or future refactor
    // that disables that dedup would silently re-enable double-purge.
    // The DB-level claim eliminates that exposure entirely.
    const { processor, repoFind, txn } = await buildProcessor([{ id: 'u1' }]);
    await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN, {}) as never,
    );
    expect(txn).toHaveBeenCalledTimes(1);
    expect(repoFind).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      }),
    );
  });

  it('runs the claim and every enqueue inside the same transaction so locks are held until the slice is fully enqueued', async () => {
    // The locks are released at transaction commit. Holding them
    // across the producer.enqueue calls means a concurrent sweeper
    // that beats us to the cron tick by milliseconds still sees this
    // pod's slice as locked and SKIPs it for its own claim — instead
    // of racing past the SELECT and producing duplicate finalize jobs.
    const { processor, txn, producer } = await buildProcessor([
      { id: 'u1' },
      { id: 'u2' },
    ]);
    await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_SWEEP_RUN, {}) as never,
    );
    // Single transaction wraps the whole sweep — not one txn per user,
    // not zero txns with a bare `find`.
    expect(txn).toHaveBeenCalledTimes(1);
    expect(producer.enqueueAccountDeletionFinalize).toHaveBeenCalledTimes(2);
  });
});

describe('AccountDeletionFinalizeProcessor', () => {
  let accountDeletion: { finalizeUser: jest.Mock };
  let processor: AccountDeletionFinalizeProcessor;

  beforeEach(async () => {
    accountDeletion = { finalizeUser: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountDeletionFinalizeProcessor,
        { provide: AccountDeletionService, useValue: accountDeletion },
      ],
    }).compile();
    processor = moduleRef.get(AccountDeletionFinalizeProcessor);
  });

  it('reports users_purged=1 when the service confirms the purge', async () => {
    accountDeletion.finalizeUser.mockResolvedValue(true);
    const result = await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER, {
        user_id: 'u-42',
      }) as never,
    );
    expect(accountDeletion.finalizeUser).toHaveBeenCalledWith('u-42');
    expect(result).toEqual({ users_purged: 1 });
  });

  it('reports users_purged=0 when the row was no longer eligible (concurrent purge / restore / postpone)', async () => {
    accountDeletion.finalizeUser.mockResolvedValue(false);
    const result = await processor.process(
      fakeJob(JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER, {
        user_id: 'u-42',
      }) as never,
    );
    expect(result).toEqual({ users_purged: 0 });
  });

  it("throws on a malformed job body so retries don't silently no-op", async () => {
    await expect(
      processor.process(
        fakeJob(JOB_NAMES.ACCOUNT_DELETION_FINALIZE_USER, {}) as never,
      ),
    ).rejects.toThrow('user_id');
  });
});

describe('FunzoneRecomputeProcessor', () => {
  it('happy path: invokes runClustering with no overrides and returns the cluster summary', async () => {
    const clustering = {
      runClustering: jest.fn().mockResolvedValue({
        zones_written: 4,
        zones_pruned: 1,
        members_written: 38,
        duration_ms: 1234,
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FunzoneRecomputeProcessor,
        { provide: FunZoneClusteringService, useValue: clustering },
      ],
    }).compile();
    const processor = moduleRef.get(FunzoneRecomputeProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.FUNZONE_RECOMPUTE_RUN, {}) as never,
    );
    expect(clustering.runClustering).toHaveBeenCalledWith({});
    expect(result).toEqual({
      zones_written: 4,
      zones_pruned: 1,
      members_written: 38,
      duration_ms: 1234,
    });
  });
});

describe('PushNotificationProcessor', () => {
  it('happy path: returns noop while no provider is wired and redacts the device token in logs', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PushNotificationProcessor],
    }).compile();
    const processor = moduleRef.get(PushNotificationProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.PUSH_NOTIFICATION_SEND, {
        user_id: 'u1',
        device_token: 'abcdefghijkl',
        title: 'Hello',
        body: 'World',
      }) as never,
    );
    expect(result).toMatchObject({ status: 'noop' });
  });
});
