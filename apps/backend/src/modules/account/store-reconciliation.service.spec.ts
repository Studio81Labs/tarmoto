/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';

describe('StoreReconciliationService', () => {
  let service: StoreReconciliationService;
  let repo: Partial<jest.Mocked<Repository<StoreBillingReconciliation>>>;

  beforeEach(async () => {
    repo = {
      create: jest
        .fn()
        .mockImplementation(
          (entity: Partial<StoreBillingReconciliation>) =>
            entity as StoreBillingReconciliation,
        ),
      save: jest
        .fn()
        .mockImplementation((entity: Partial<StoreBillingReconciliation>) =>
          Promise.resolve({
            id: 'sbr-1',
            ...entity,
          } as StoreBillingReconciliation),
        ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoreReconciliationService,
        {
          provide: getRepositoryToken(StoreBillingReconciliation),
          useValue: repo,
        },
      ],
    }).compile();

    service = module.get(StoreReconciliationService);
  });

  describe('openConflict', () => {
    it('inserts an open row with the given reason and provider identifiers', async () => {
      const result = await service.openConflict({
        userId: 'user-1',
        provider: 'stripe',
        stripeSubscriptionId: 'sub_losing',
        reason: 'exclusivity_conflict',
        detail: { winningSubscriptionId: 'sub_winning' },
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          provider: 'stripe',
          stripe_subscription_id: 'sub_losing',
          apple_original_transaction_id: null,
          google_original_transaction_id: null,
          reason: 'exclusivity_conflict',
          status: 'open',
          resolution: null,
          detail: { winningSubscriptionId: 'sub_winning' },
        }),
      );
      expect(repo.save).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'sbr-1', status: 'open' });
    });

    it('defaults the optional provider identifiers and detail to null', async () => {
      await service.openConflict({
        userId: 'user-2',
        provider: 'apple',
        appleOriginalTransactionId: 'apl_123',
        reason: 'ineligible_trial_rejected',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-2',
          provider: 'apple',
          apple_original_transaction_id: 'apl_123',
          stripe_subscription_id: null,
          google_original_transaction_id: null,
          reason: 'ineligible_trial_rejected',
          detail: null,
        }),
      );
    });

    // Finding 4: two concurrent validations rejecting the same ineligible/
    // exclusivity Apple transaction can both pass the findOpen fast-path; the
    // partial unique index makes the loser's INSERT raise a 23505. openConflict
    // treats that as a dedup no-op and returns the winner's already-open row.
    it('treats a 23505 on an Apple open as a dedup no-op and returns the existing open row', async () => {
      const existing = {
        id: 'sbr-winner',
        provider: 'apple',
        apple_original_transaction_id: 'apl_race',
        reason: 'exclusivity_conflict',
        status: 'open',
      } as unknown as StoreBillingReconciliation;
      repo.save = jest.fn().mockRejectedValue({
        name: 'QueryFailedError',
        driverError: { code: '23505' },
      });
      repo.find = jest.fn().mockResolvedValue([existing]);

      const result = await service.openConflict({
        userId: 'user-1',
        provider: 'apple',
        appleOriginalTransactionId: 'apl_race',
        reason: 'exclusivity_conflict',
      });

      expect(result).toBe(existing);
      // Re-fetched the open row via findOpen (scoped to the same identity).
      expect(repo.find).toHaveBeenCalledWith({
        where: {
          status: 'open',
          user_id: 'user-1',
          provider: 'apple',
          reason: 'exclusivity_conflict',
        },
      });
    });

    it('does NOT swallow a 23505 raised on a non-Apple (Stripe) open', async () => {
      const violation = {
        name: 'QueryFailedError',
        driverError: { code: '23505' },
      };
      repo.save = jest.fn().mockRejectedValue(violation);
      const find = jest.fn().mockResolvedValue([]);
      repo.find = find;

      await expect(
        service.openConflict({
          userId: 'user-1',
          provider: 'stripe',
          stripeSubscriptionId: 'sub_1',
          reason: 'exclusivity_conflict',
        }),
      ).rejects.toBe(violation);
      // The Stripe path never enters the Apple dedup re-fetch.
      expect(find).not.toHaveBeenCalled();
    });

    it('rethrows a non-unique-violation error on an Apple open (no blanket catch)', async () => {
      const other = {
        name: 'QueryFailedError',
        driverError: { code: '40P01' },
      };
      repo.save = jest.fn().mockRejectedValue(other);
      const find = jest.fn().mockResolvedValue([]);
      repo.find = find;

      await expect(
        service.openConflict({
          userId: 'user-1',
          provider: 'apple',
          appleOriginalTransactionId: 'apl_x',
          reason: 'exclusivity_conflict',
        }),
      ).rejects.toBe(other);
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('marks the row resolved with the resolution and a resolved_at timestamp', async () => {
      await service.resolve('sbr-1', 'refunded');

      expect(repo.update).toHaveBeenCalledWith('sbr-1', {
        status: 'resolved',
        resolution: 'refunded',
        resolved_at: expect.any(Date),
      });
    });
  });

  describe('manager-bound variants (atomic with the caller transaction)', () => {
    it('openConflictWith creates + saves the same open row via the caller manager', async () => {
      const create = jest
        .fn()
        .mockImplementation(
          (_entity: unknown, payload: Partial<StoreBillingReconciliation>) =>
            payload as StoreBillingReconciliation,
        );
      const save = jest
        .fn()
        .mockImplementation((_entity: unknown, payload: unknown) =>
          Promise.resolve({ id: 'sbr-tx', ...(payload as object) }),
        );
      const manager = {
        create,
        save,
      } as unknown as import('typeorm').EntityManager;

      const result = await service.openConflictWith(manager, {
        userId: 'user-1',
        provider: 'stripe',
        stripeSubscriptionId: 'sub_1',
        reason: 'deletion_cancel_failed',
        detail: { opened: 'deletion_scheduled' },
      });

      expect(create).toHaveBeenCalledWith(
        StoreBillingReconciliation,
        expect.objectContaining({
          user_id: 'user-1',
          provider: 'stripe',
          stripe_subscription_id: 'sub_1',
          reason: 'deletion_cancel_failed',
          status: 'open',
          resolution: null,
        }),
      );
      expect(save).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'sbr-tx', status: 'open' });
    });

    it('resolveWith updates via the caller manager', async () => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        update,
      } as unknown as import('typeorm').EntityManager;

      await service.resolveWith(manager, 'sbr-tx', 'server_canceled');

      expect(update).toHaveBeenCalledWith(
        StoreBillingReconciliation,
        'sbr-tx',
        {
          status: 'resolved',
          resolution: 'server_canceled',
          resolved_at: expect.any(Date),
        },
      );
    });

    it('findOpenWith reads via the caller manager with the same where-clause', async () => {
      const find = jest.fn().mockResolvedValue([]);
      const manager = {
        find,
      } as unknown as import('typeorm').EntityManager;

      await service.findOpenWith(manager, {
        userId: 'user-1',
        provider: 'stripe',
        reason: 'deletion_cancel_failed',
      });

      expect(find).toHaveBeenCalledWith(StoreBillingReconciliation, {
        where: {
          status: 'open',
          user_id: 'user-1',
          provider: 'stripe',
          reason: 'deletion_cancel_failed',
        },
      });
    });

    it('resetAttemptsWith zeroes the retry budget via the caller manager', async () => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        update,
      } as unknown as import('typeorm').EntityManager;

      await service.resetAttemptsWith(manager, 'sbr-tx');

      expect(update).toHaveBeenCalledWith(
        StoreBillingReconciliation,
        'sbr-tx',
        {
          attempts: 0,
        },
      );
    });
  });

  describe('findOpen', () => {
    it('queries only open rows and applies the supplied filters', async () => {
      await service.findOpen({
        userId: 'user-1',
        reason: 'exclusivity_conflict',
      });

      expect(repo.find).toHaveBeenCalledWith({
        where: {
          status: 'open',
          user_id: 'user-1',
          reason: 'exclusivity_conflict',
        },
      });
    });

    it('filters open rows by stripe subscription id when supplied', async () => {
      await service.findOpen({
        provider: 'stripe',
        reason: 'exclusivity_conflict',
        stripeSubscriptionId: 'sub_losing',
      });

      expect(repo.find).toHaveBeenCalledWith({
        where: {
          status: 'open',
          provider: 'stripe',
          reason: 'exclusivity_conflict',
          stripe_subscription_id: 'sub_losing',
        },
      });
    });

    it('queries all open rows when no filter is supplied', async () => {
      await service.findOpen();

      expect(repo.find).toHaveBeenCalledWith({ where: { status: 'open' } });
    });

    it('bounds the query when batching options are supplied: excludes retry-capped rows, orders oldest-first, and caps the batch', async () => {
      // The worker passes these so one hourly run loads only a bounded,
      // oldest-first slice and NEVER a row already at the retry cap — so an
      // accumulating backlog of parked rows can't bloat every run.
      await service.findOpen(
        { provider: 'stripe', reason: 'deletion_cancel_failed' },
        { maxAttempts: 5, limit: 50 },
      );

      expect(repo.find).toHaveBeenCalledWith({
        where: {
          status: 'open',
          provider: 'stripe',
          reason: 'deletion_cancel_failed',
          // Capped rows (attempts >= 5) are filtered out at the query level.
          attempts: LessThan(5),
        },
        order: { created_at: 'ASC' },
        take: 50,
      });
    });
  });
});
