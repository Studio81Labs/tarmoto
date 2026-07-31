import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { StoreReconciliationProcessor } from './store-reconciliation.processor.js';
import {
  StoreReconciliationService,
  accountDeletionLockKey,
} from '../../account/store-reconciliation.service.js';
import { STRIPE_BILLING_CLIENT } from '../../account/stripe-billing.client.js';
import { JOB_NAMES } from '../jobs.constants.js';

function fakeJob<T = unknown>(
  name: string,
  data: T,
): { id: string; name: string; data: T } {
  return { id: 'job-test', name, data };
}

interface Row {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  reason: string;
  attempts: number;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    user_id: 'user-1',
    stripe_subscription_id: 'sub_1',
    reason: 'deletion_cancel_failed',
    attempts: 0,
    ...overrides,
  };
}

describe('StoreReconciliationProcessor', () => {
  let reconciliation: {
    findOpen: jest.Mock;
    resolve: jest.Mock;
  };
  let stripe: { setCancelAtPeriodEnd: jest.Mock };
  let userFindOne: jest.Mock;
  let sbrIncrement: jest.Mock;
  let managerQuery: jest.Mock;
  let dataSourceQuery: jest.Mock;
  let processor: StoreReconciliationProcessor;

  function buildUser(
    deletionScheduledAt: Date | null,
    stripeSubscriptionId: string | null = 'sub_1',
  ): void {
    userFindOne.mockResolvedValue({
      id: 'user-1',
      deletion_scheduled_at: deletionScheduledAt,
      stripe_subscription_id: stripeSubscriptionId,
    });
  }

  beforeEach(async () => {
    reconciliation = {
      findOpen: jest.fn().mockResolvedValue([]),
      resolve: jest.fn().mockResolvedValue(undefined),
    };
    stripe = { setCancelAtPeriodEnd: jest.fn().mockResolvedValue(undefined) };
    userFindOne = jest.fn();
    sbrIncrement = jest.fn().mockResolvedValue(undefined);
    managerQuery = jest.fn().mockResolvedValue(undefined);
    // Prune returns an empty deleted-rows array by default.
    dataSourceQuery = jest.fn().mockResolvedValue([]);

    const manager = {
      query: managerQuery,
      getRepository: jest.fn().mockImplementation(() => ({
        findOne: userFindOne,
        increment: sbrIncrement,
      })),
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>): Promise<unknown> =>
          cb(manager),
      ),
      query: dataSourceQuery,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        StoreReconciliationProcessor,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: StoreReconciliationService, useValue: reconciliation },
        { provide: STRIPE_BILLING_CLIENT, useValue: stripe },
      ],
    }).compile();
    processor = moduleRef.get(StoreReconciliationProcessor);
  });

  it('only drains Stripe-actionable deletion_cancel_failed rows, bounded oldest-first and excluding retry-capped rows', async () => {
    await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );
    // Bounded slice: excludes rows already at the retry cap and caps the batch
    // so a prolonged outage / parked-row backlog can't make one run load the
    // whole history. `maxAttempts` matches the retryRow cap; `limit` is the
    // per-run batch size.
    expect(reconciliation.findOpen).toHaveBeenCalledWith(
      { provider: 'stripe', reason: 'deletion_cancel_failed' },
      { maxAttempts: 5, limit: 50 },
    );
  });

  it('restoration-safe: resolves without touching Stripe when the rider was restored (deletion_scheduled_at = null)', async () => {
    reconciliation.findOpen.mockResolvedValue([row()]);
    buildUser(null);

    const result = await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );

    // A stale retry must NOT cancel a restored, now-active subscription.
    expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
    // The row is closed out — nothing left to do for a restored rider.
    expect(reconciliation.resolve).toHaveBeenCalledWith('row-1', 'expired');
    expect(result.resolved_restored).toBe(1);
    expect(result.resolved_canceled).toBe(0);
  });

  it('still-pending: retries setCancelAtPeriodEnd(subId, true) then resolves server_canceled', async () => {
    reconciliation.findOpen.mockResolvedValue([row()]);
    buildUser(new Date());

    const result = await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );

    expect(stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', true);
    expect(reconciliation.resolve).toHaveBeenCalledWith(
      'row-1',
      'server_canceled',
    );
    expect(result.resolved_canceled).toBe(1);
    expect(result.still_open).toBe(0);
  });

  it('takes the per-rider advisory lock before deciding (serialises concurrent workers)', async () => {
    reconciliation.findOpen.mockResolvedValue([row()]);
    buildUser(new Date());

    await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );

    expect(managerQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [accountDeletionLockKey('user-1')],
    );
    // The lock must be taken before the Stripe cancel runs.
    const lockOrder = managerQuery.mock.invocationCallOrder[0];
    const cancelOrder = stripe.setCancelAtPeriodEnd.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(cancelOrder);
  });

  it('records (does not hide) a Stripe failure: increments attempts, leaves the row open, does not resolve', async () => {
    reconciliation.findOpen.mockResolvedValue([row()]);
    buildUser(new Date());
    stripe.setCancelAtPeriodEnd.mockRejectedValue(new Error('stripe down'));

    const result = await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );

    expect(reconciliation.resolve).not.toHaveBeenCalled();
    expect(sbrIncrement).toHaveBeenCalledWith({ id: 'row-1' }, 'attempts', 1);
    expect(result.still_open).toBe(1);
    expect(result.resolved_canceled).toBe(0);
  });

  it('bounds retries: a row at the attempts cap is left open for ops, not retried against Stripe', async () => {
    reconciliation.findOpen.mockResolvedValue([row({ attempts: 5 })]);
    buildUser(new Date());

    const result = await processor.process(
      fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
    );

    expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(reconciliation.resolve).not.toHaveBeenCalled();
    expect(result.still_open).toBe(1);
  });

  describe('inbox retention prune', () => {
    it('deletes completed processed_store_notifications older than the horizon', async () => {
      // Simulate two old completed rows being deleted.
      dataSourceQuery.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);

      const result = await processor.process(
        fakeJob(JOB_NAMES.STORE_RECONCILIATION_RETRY_RUN, {}) as never,
      );

      const calls = dataSourceQuery.mock.calls as Array<[string, unknown[]]>;
      const call = calls.find(([sql]) =>
        sql.includes('DELETE FROM processed_store_notifications'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call as [string, unknown[]];
      // Only completed rows are eligible — a pending row (any age) never
      // matches this predicate and is therefore retained.
      expect(sql).toMatch(/status = 'completed'/);
      expect(sql).not.toMatch(/pending/);
      expect(sql).toMatch(/created_at < \$1/);
      // Cutoff is roughly the retention horizon in the past (regression
      // guard against adding instead of subtracting the interval).
      const cutoff = params[0] as Date;
      const ageMs = Date.now() - cutoff.getTime();
      expect(ageMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(ageMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);

      expect(result.inbox_pruned).toBe(2);
    });
  });
});
