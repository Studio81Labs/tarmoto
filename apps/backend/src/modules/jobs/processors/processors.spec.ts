/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EmailService } from '../../email/email.service.js';
import { HazardsCleanupProcessor } from './hazards-cleanup.processor.js';
import { BadgesRecheckProcessor } from './badges-recheck.processor.js';
import { DigestWeeklyProcessor } from './digest-weekly.processor.js';
import { DataExportQueueProcessor } from './data-export.processor.js';
import { AccountDeletionSweepProcessor } from './account-deletion-sweep.processor.js';
import { AccountDeletionFinalizeProcessor } from './account-deletion-finalize.processor.js';
import { FunzoneRecomputeProcessor } from './funzone-recompute.processor.js';
import { ModelEvalReconcileProcessor } from './model-eval-reconcile.processor.js';
import { ModelEvalAgreementProcessor } from './model-eval-agreement.processor.js';
import { ModelEvalService } from '../../model-eval/model-eval.service.js';
import { HazardsService } from '../../hazards/hazards.service.js';
import { BadgesService } from '../../badges/badges.service.js';
import { FeatureResolver } from '../../features/feature-resolver.service.js';
import { JobsProducer } from '../jobs.producer.js';
import { DataExportProcessor as DataExportRunner } from '../../account/data-export/data-export.processor.js';
import { AccountDeletionService } from '../../account/account-deletion.service.js';
import { FunZoneClusteringService } from '../../roads/fun-zone-clustering.service.js';
import { SubscriptionNotifyProcessor } from './subscription-notify.processor.js';
import { SubscriptionNotificationService } from '../../account/subscription-notification.service.js';
import { JOB_NAMES } from '../jobs.constants.js';

function fakeJob<T = unknown>(
  name: string,
  data: T,
): { id: string; name: string; data: T } {
  return { id: 'job-test', name, data };
}

describe('HazardsCleanupProcessor', () => {
  it('happy path: expires old hazards and sweeps orphaned photos', async () => {
    const hazards = {
      expireOld: jest.fn().mockResolvedValue(7),
      sweepOrphanedPhotos: jest.fn().mockResolvedValue(3),
    };
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
    expect(hazards.sweepOrphanedPhotos).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expired_marked: 7, orphan_photos_removed: 3 });
  });

  it('still reports expiry when the orphan photo sweep throws', async () => {
    const hazards = {
      expireOld: jest.fn().mockResolvedValue(2),
      sweepOrphanedPhotos: jest.fn().mockRejectedValue(new Error('disk error')),
    };
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
    // The sweep failure is swallowed so expiry (the safety-critical step)
    // still completes and is reported.
    expect(result).toEqual({ expired_marked: 2, orphan_photos_removed: 0 });
  });
});

describe('BadgesRecheckProcessor', () => {
  let dataSource: { query: jest.Mock };
  let badges: { checkAndAward: jest.Mock };
  let producer: { enqueueBadgesRecheckUser: jest.Mock };
  let featureResolver: { isSystemSwitchEnabled: jest.Mock };
  let processor: BadgesRecheckProcessor;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    badges = { checkAndAward: jest.fn() };
    producer = {
      enqueueBadgesRecheckUser: jest.fn().mockResolvedValue(undefined),
    };
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        BadgesRecheckProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: BadgesService, useValue: badges },
        { provide: JobsProducer, useValue: producer },
        { provide: FeatureResolver, useValue: featureResolver },
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

  it('dispatch: skips and enqueues nothing when sys_gamification is off', async () => {
    featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
    const result = await processor.process(
      fakeJob(JOB_NAMES.BADGES_RECHECK_DISPATCH, {}) as never,
    );
    expect(result).toEqual({ users_enqueued: 0 });
    expect(producer.enqueueBadgesRecheckUser).not.toHaveBeenCalled();
    expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
      'sys_gamification',
    );
  });

  it('recheck-user: skips and does not call checkAndAward when sys_gamification is off', async () => {
    featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
    const result = await processor.process(
      fakeJob(JOB_NAMES.BADGES_RECHECK_USER, { user_id: 'u1' }) as never,
    );
    expect(result).toEqual({ badges_awarded: [] });
    expect(badges.checkAndAward).not.toHaveBeenCalled();
    expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
      'sys_gamification',
    );
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
        // compose() deps — the dispatch tests below don't exercise them, but
        // the processor's constructor requires them for DI to resolve.
        { provide: ConfigService, useValue: { get: () => 'http://x' } },
        { provide: EmailService, useValue: { sendWeeklyDigest: jest.fn() } },
      ],
    }).compile();
    processor = moduleRef.get(DigestWeeklyProcessor);
  });

  it('dispatch: enqueues a compose job per user that the SQL filter returned', async () => {
    dataSource.query.mockResolvedValue([
      {
        user_id: 'u1',
        window_start: '2026-06-28T08:00:00.000Z',
        window_end: '2026-07-05T08:00:00.000Z',
      },
      {
        user_id: 'u2',
        window_start: '2026-06-28T07:00:00.000Z',
        window_end: '2026-07-05T07:00:00.000Z',
      },
    ]);
    const result = await processor.process(
      fakeJob(JOB_NAMES.DIGEST_WEEKLY_DISPATCH, {}) as never,
    );
    expect(producer.enqueueDigestWeeklyCompose).toHaveBeenCalledTimes(2);
    const firstPayload = producer.enqueueDigestWeeklyCompose.mock
      .calls[0][0] as {
      for_local_window: string;
      window_start: string;
      window_end: string;
    };
    // The idempotency key is the UTC week of the PINNED send boundary
    // (window_end) — constant across catch-up runs, not the dispatcher slot's
    // week (which would double-send when catch-up crosses a week boundary). The
    // 'YYYY-Www' format matches the legacy key so old + new jobs dedupe on
    // deploy. window_end 2026-07-05 → 2026-W27.
    expect(firstPayload.for_local_window).toBe('2026-W27');
    // ...and the DST-correct window bounds resolved per rider at dispatch, so
    // compose never re-derives them from a fixed 7×24h delta.
    expect(firstPayload.window_start).toBe('2026-06-28T08:00:00.000Z');
    expect(firstPayload.window_end).toBe('2026-07-05T08:00:00.000Z');
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
    // The rider timezone is sourced from the persisted, user-writable
    // `notification_preferences.quiet_hours_timezone` — NOT
    // `users.preferences->>'timezone'`, which has no writer in any settings
    // path (the profile DTO whitelist rejects the key) and would silently pin
    // every rider to UTC. A regression back to that dead field fails here.
    expect(sql).toMatch(/quiet_hours_timezone/);
    expect(sql).not.toMatch(/preferences->>'timezone'/);
    // Digest opt-in is the typed `notification_preferences.email_digest`, not
    // the legacy `users.preferences` flag (#278) — a stale check would email
    // every rider regardless of the 'daily'/'never' they picked.
    expect(sql).toMatch(/notification_preferences/);
    expect(sql).toMatch(/email_digest/);
    expect(sql).not.toMatch(/weekly_digest/);
    // The digest window is derived in the rider's timezone at dispatch:
    // window_start subtracts a LOCAL `interval '7 days'` (DST-correct) rather
    // than a fixed millisecond delta, and both bounds ride along to compose.
    expect(sql).toMatch(/interval '7 days'/);
    expect(sql).toMatch(/window_start/);
    expect(sql).toMatch(/window_end/);
    // The HOUR filter is a catch-up RANGE (BETWEEN $3 AND $4), not a single
    // hour: BullMQ skips slots across a multi-hour outage, so one post-outage
    // run must replay every rider whose local 08:00 fell in the gap. A
    // regression back to a single-hour `= $3` match fails here.
    expect(sql).toMatch(/BETWEEN \$3 AND \$4/);
    expect(sql).not.toMatch(/HOUR FROM[\s\S]*?\)::int = \$3/);
    // Verification is evaluated AS OF the pinned send time, so the widened hour
    // range can't mail a rider who verified their email after 08:00.
    expect(sql).toMatch(/email_verified_at <= s\.send_at/);
    // The opt-in is NOT gated on notification_preferences.updated_at — that is
    // not opt-in history and would drop default-weekly riders whose row was
    // touched after the send (e.g. by the timezone sync). Assert the predicate
    // itself is gone (the surrounding comment still mentions the column).
    expect(sql).not.toMatch(/np\.updated_at <= s\.send_at/);
  });

  it('anchors the dispatch to the scheduled slot in the jobId, not the processing clock', async () => {
    // A retried/backlogged dispatch processed after the rider's 08:00 hour must
    // still target the slot it was scheduled for; otherwise EXTRACT(HOUR)=8
    // finds nobody and the week's digest is silently skipped. BullMQ encodes the
    // slot millis as the trailing segment of the repeatable jobId.
    const slot = Date.UTC(2026, 6, 5, 8); // Sun 2026-07-05 08:00 UTC
    dataSource.query.mockResolvedValue([]);
    await processor.process({
      id: `repeat:digest-weekly.${JOB_NAMES.DIGEST_WEEKLY_DISPATCH}:${slot}`,
      name: JOB_NAMES.DIGEST_WEEKLY_DISPATCH,
      data: {},
      // Creation time ≈ 1h before the slot (what job.timestamp holds) — must be
      // ignored; the `new Date()` fallback (test's "now") would also differ.
      timestamp: Date.UTC(2026, 6, 5, 7),
    } as never);
    const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    // $1 (drives the DOW/HOUR filter + window) is the scheduled slot, verbatim.
    expect(params[0]).toBe(new Date(slot).toISOString());
  });

  // `compose` is covered end-to-end in digest-weekly.processor.spec.ts (#866).
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

describe('SubscriptionNotifyProcessor', () => {
  async function build(): Promise<{
    processor: SubscriptionNotifyProcessor;
    deliver: jest.Mock;
  }> {
    const deliver = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionNotifyProcessor,
        { provide: SubscriptionNotificationService, useValue: { deliver } },
      ],
    }).compile();
    return { processor: moduleRef.get(SubscriptionNotifyProcessor), deliver };
  }

  it('delegates a well-formed job to the notification service (state revalidation lives there)', async () => {
    const { processor, deliver } = await build();
    const data = {
      kind: 'confirmed',
      userId: 'u1',
      tier: 'pro',
      periodEnd: null,
    };
    await processor.process(
      fakeJob(JOB_NAMES.SUBSCRIPTION_NOTIFY_SEND, data) as never,
    );
    expect(deliver).toHaveBeenCalledWith(data);
  });

  it('rejects a malformed job (missing userId/kind) so it never silently no-ops', async () => {
    const { processor, deliver } = await build();
    await expect(
      processor.process(
        fakeJob(JOB_NAMES.SUBSCRIPTION_NOTIFY_SEND, {
          kind: 'confirmed',
        }) as never,
      ),
    ).rejects.toThrow('missing');
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('ModelEvalReconcileProcessor', () => {
  it('happy path: invokes ModelEvalService.reconcilePending and returns the summary', async () => {
    const evalService = {
      reconcilePending: jest.fn().mockResolvedValue({
        reconciled: 7,
        dangerous: 1,
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelEvalReconcileProcessor,
        { provide: ModelEvalService, useValue: evalService },
      ],
    }).compile();
    const processor = moduleRef.get(ModelEvalReconcileProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.MODEL_EVAL_RECONCILE_RUN, {}) as never,
    );
    expect(evalService.reconcilePending).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reconciled: 7, dangerous: 1 });
  });
});

describe('ModelEvalAgreementProcessor', () => {
  it('happy path: invokes ModelEvalService.recomputeAgreements and returns flat summary', async () => {
    const evalService = {
      recomputeAgreements: jest.fn().mockResolvedValue({
        cross_device: {
          agreement_score: 0.83,
          segments_evaluated: 12,
          computed_at: '2026-05-08T00:00:00.000Z',
        },
        cross_bike: {
          agreement_score: 0.77,
          segments_evaluated: 8,
          computed_at: '2026-05-08T00:00:00.000Z',
        },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelEvalAgreementProcessor,
        { provide: ModelEvalService, useValue: evalService },
      ],
    }).compile();
    const processor = moduleRef.get(ModelEvalAgreementProcessor);
    const result = await processor.process(
      fakeJob(JOB_NAMES.MODEL_EVAL_AGREEMENT_RUN, {}) as never,
    );
    expect(evalService.recomputeAgreements).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      cross_device_score: 0.83,
      cross_device_segments: 12,
      cross_bike_score: 0.77,
      cross_bike_segments: 8,
    });
  });
});
