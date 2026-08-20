import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager, Repository } from 'typeorm';
import {
  StoreChainWriterService,
  type StoreChainStateInput,
} from './store-chain-writer.service.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';
import { User } from '../../entities/user.entity.js';
import type { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';

/**
 * Classification of `applyChainState`'s NON-happy paths — the branches a
 * mocked manager CAN prove, because they are pure control flow over driver
 * results. The SQL itself (guards, constraints, `ON CONFLICT`, rollback) is
 * covered by the real-Postgres writers suite; these pin the verdicts:
 *
 *  - a 0-row guarded UPDATE is a retryable 503 when a NEWER holder advanced
 *    the users fence, and a benign `stale` otherwise — the store-writer half
 *    of the invariant whose three single-slot tests were deleted with the
 *    retired claims;
 *  - a 0-row rollup write is a retryable 503 (the enclosing transaction rolls
 *    the chain write back — asserted against real Postgres in the e2e suite);
 *  - an INSERT-path 23505 is `ownership_conflict` ONLY once a post-abort read
 *    proves the row belongs to a DIFFERENT rider; the same code raised by a
 *    same-rider duplicate under a lost lease is the fence race, never a
 *    conflict — step 5 routes `ownership_conflict` toward the refund
 *    workflow, so a wrong verdict here is a wrong verdict on the money path;
 *  - any non-23505 insert error propagates untouched (no blanket catch).
 */
describe('StoreChainWriterService — write classification', () => {
  const input = (
    over: Partial<StoreChainStateInput> = {},
  ): StoreChainStateInput => ({
    userId: 'rider-1',
    provider: 'google',
    originalTransactionId: 'GPA.root-1',
    productId: 'tarmoto_pro_monthly',
    originalPurchaseDate: null,
    tier: 'pro',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600_000),
    cancelAtPeriodEnd: false,
    observedAt: new Date(),
    fenceToken: 10,
    ...over,
  });

  interface Harness {
    service: StoreChainWriterService;
    base: EntityManager;
    chainUpdateExecute: jest.Mock;
    rollupUpdateExecute: jest.Mock;
    txChainFindOne: jest.Mock;
    txChainInsert: jest.Mock;
    txUserExistsBy: jest.Mock;
    baseChainFindOne: jest.Mock;
    baseUserExistsBy: jest.Mock;
  }

  function setup(): Harness {
    const chainUpdateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const rollupUpdateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    // tx.createQueryBuilder() is called in a fixed order: the chain UPDATE,
    // then the rollup UPDATE. Each call gets a fresh chainable builder wired
    // to its execute.
    const executes = [chainUpdateExecute, rollupUpdateExecute];
    let updateQbIndex = 0;
    const makeUpdateQb = () => {
      const execute = executes[updateQbIndex] ?? jest.fn();
      updateQbIndex += 1;
      const qb: Record<string, unknown> = { execute };
      for (const method of [
        'update',
        'set',
        'setParameter',
        'where',
        'andWhere',
      ]) {
        qb[method] = jest.fn().mockReturnValue(qb);
      }
      return qb;
    };

    const txChainFindOne = jest.fn().mockResolvedValue(null);
    const txChainInsert = jest.fn().mockResolvedValue(undefined);
    const txUserExistsBy = jest.fn().mockResolvedValue(false);
    // Live-chain / future-billing list queries (rollup + overlap sync).
    const chainListQb: Record<string, unknown> = {
      getMany: jest.fn().mockResolvedValue([]),
    };
    for (const method of ['where', 'andWhere']) {
      chainListQb[method] = jest.fn().mockReturnValue(chainListQb);
    }
    const txQuery = jest.fn().mockResolvedValue(undefined);
    const txUserFindOne = jest.fn().mockResolvedValue(null);

    const tx = {
      createQueryBuilder: jest.fn(() => makeUpdateQb()),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === StoreSubscription) {
          return {
            findOne: txChainFindOne,
            insert: txChainInsert,
            createQueryBuilder: jest.fn(() => chainListQb),
          };
        }
        if (entity === User) {
          return { existsBy: txUserExistsBy, findOne: txUserFindOne };
        }
        throw new Error('unexpected repository');
      }),
      query: txQuery,
    } as unknown as EntityManager;

    const baseChainFindOne = jest.fn().mockResolvedValue(null);
    const baseUserExistsBy = jest.fn().mockResolvedValue(false);
    const base = {
      transaction: jest.fn((cb: (manager: EntityManager) => Promise<unknown>) =>
        cb(tx),
      ),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === StoreSubscription) return { findOne: baseChainFindOne };
        if (entity === User) return { existsBy: baseUserExistsBy };
        throw new Error('unexpected repository');
      }),
    } as unknown as EntityManager;

    const service = new StoreChainWriterService(
      { manager: base } as unknown as Repository<User>,
      {} as unknown as Repository<StoreBillingReconciliation>,
      { get: <T>(_key: string, def: T): T => def } as unknown as ConfigService,
      {} as unknown as SubscriptionMutationLockService,
    );

    return {
      service,
      base,
      chainUpdateExecute,
      rollupUpdateExecute,
      txChainFindOne,
      txChainInsert,
      txUserExistsBy,
      baseChainFindOne,
      baseUserExistsBy,
    };
  }

  it("classifies a 0-row UPDATE on an existing row as 'stale' when the fence is current — and inserts nothing", async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue({ id: 'chain-1' });
    h.txUserExistsBy.mockResolvedValue(false); // no newer fence

    await expect(h.service.applyChainState(input(), h.base)).resolves.toBe(
      'stale',
    );
    expect(h.txChainInsert).not.toHaveBeenCalled();
    // The rollup writer must not run for a no-op.
    expect(h.rollupUpdateExecute).not.toHaveBeenCalled();
  });

  it('throws the retryable 503 instead of a false stale when a NEWER holder advanced the users fence', async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue({ id: 'chain-1' });
    h.txUserExistsBy.mockResolvedValue(true); // users fence > our token

    await expect(
      h.service.applyChainState(input(), h.base),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('treats an undefined `affected` as 0 rows (the driver-shape defensive idiom), not as a write', async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({});
    h.txChainFindOne.mockResolvedValue({ id: 'chain-1' });

    await expect(h.service.applyChainState(input(), h.base)).resolves.toBe(
      'stale',
    );
    expect(h.rollupUpdateExecute).not.toHaveBeenCalled();
  });

  it('throws the retryable 503 when the fence-stale rollup write matches 0 rows, so the transaction rolls the chain back', async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 1 });
    h.rollupUpdateExecute.mockResolvedValue({ affected: 0 });

    await expect(
      h.service.applyChainState(input(), h.base),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The rollback itself is a database property, asserted in the
    // real-Postgres suite; here the point is the verdict.
  });

  it('rethrows a NON-unique-violation insert error untouched — no blanket catch', async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue(null);
    h.txChainInsert.mockRejectedValue(
      Object.assign(new Error('check violated'), { code: '23514' }),
    );

    await expect(h.service.applyChainState(input(), h.base)).rejects.toThrow(
      'check violated',
    );
    expect(h.baseChainFindOne).not.toHaveBeenCalled();
  });

  it("classifies an INSERT 23505 as 'ownership_conflict' only when the post-abort read shows a DIFFERENT rider", async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue(null);
    h.txChainInsert.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    h.baseChainFindOne.mockResolvedValue({ id: 'chain-x', user_id: 'rider-2' });

    await expect(h.service.applyChainState(input(), h.base)).resolves.toBe(
      'ownership_conflict',
    );
  });

  it("classifies a SAME-RIDER 23505 (lost-lease duplicate insert) as 'stale', never a conflict", async () => {
    // The global (provider, target_key) index raises the identical code for a
    // duplicate the rider's own newer flow inserted between our existence read
    // and our INSERT. Calling that an ownership conflict hands step 5 the
    // wrong contract on the money path.
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue(null);
    h.txChainInsert.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    h.baseChainFindOne.mockResolvedValue({ id: 'chain-x', user_id: 'rider-1' });
    h.baseUserExistsBy.mockResolvedValue(false);

    await expect(h.service.applyChainState(input(), h.base)).resolves.toBe(
      'stale',
    );
  });

  it('surfaces the SAME-RIDER 23505 as a retryable 503 when a newer holder advanced the fence', async () => {
    const h = setup();
    h.chainUpdateExecute.mockResolvedValue({ affected: 0 });
    h.txChainFindOne.mockResolvedValue(null);
    h.txChainInsert.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    h.baseChainFindOne.mockResolvedValue({ id: 'chain-x', user_id: 'rider-1' });
    h.baseUserExistsBy.mockResolvedValue(true);

    await expect(
      h.service.applyChainState(input(), h.base),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
