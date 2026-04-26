/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import { User } from '../../entities/user.entity.js';
import { AccountDeletionLog } from '../../entities/account-deletion-log.entity.js';

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let userRepo: jest.Mocked<Pick<Repository<User>, 'find' | 'update'>> & {
    createQueryBuilder: jest.Mock;
  };
  let auditRepo: jest.Mocked<
    Pick<Repository<AccountDeletionLog>, 'create' | 'save'>
  >;
  let stripe: jest.Mocked<StripeBillingClient>;
  let dataSource: { transaction: jest.Mock };
  let txManager: {
    createQueryBuilder: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let surfaceUpdateExecute: jest.Mock;

  const KNOWN_PASSWORD = 'correcthorse';
  let knownHash: string;

  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      password_hash: knownHash,
      display_name: 'Test Rider',
      phone: null,
      avatar_url: null,
      bio: null,
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: {},
      stripe_customer_id: null,
      stripe_subscription_id: null,
      subscription_tier: 'free',
      subscription_status: 'canceled',
      subscription_cancel_at_period_end: false,
      subscription_current_period_end: null,
      billing_trial_used_at: null,
      deleted_at: null,
      deletion_scheduled_at: null,
      deletion_reason: null,
      created_at: new Date('2026-04-01T00:00:00Z'),
      updated_at: new Date('2026-04-01T00:00:00Z'),
      ...overrides,
    }) as User;

  beforeAll(async () => {
    knownHash = await bcrypt.hash(KNOWN_PASSWORD, 4);
  });

  beforeEach(async () => {
    surfaceUpdateExecute = jest.fn().mockResolvedValue({ affected: 0 });
    txManager = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: surfaceUpdateExecute,
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest
        .fn()
        .mockImplementation((_entity, payload: Record<string, unknown>) => ({
          ...payload,
        })),
      save: jest.fn().mockImplementation((_entity, payload) => payload),
    };

    dataSource = {
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) => {
          return cb(txManager as unknown as EntityManager);
        },
      ),
    };

    const userQb = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(buildUser()),
    };
    userRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(userQb),
    } as any;

    auditRepo = {
      create: jest.fn().mockImplementation((payload: any) => ({ ...payload })),
      save: jest.fn().mockImplementation((entity: any) => entity),
    } as any;

    stripe = {
      ensureCustomer: jest.fn(),
      getBillingSnapshot: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
      cancelSubscription: jest.fn().mockResolvedValue(undefined),
      deleteCustomer: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(true),
      constructWebhookEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: getRepositoryToken(AccountDeletionLog),
          useValue: auditRepo,
        },
        {
          provide: getDataSourceToken(),
          useValue: dataSource as unknown as DataSource,
        },
        { provide: STRIPE_BILLING_CLIENT, useValue: stripe },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TARMOTO_ACCOUNT_DELETION_GRACE_DAYS'
                ? undefined
                : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AccountDeletionService>(AccountDeletionService);
  });

  describe('requestDeletion (soft delete)', () => {
    it('schedules the user for deletion 30 days out and writes a requested audit row', async () => {
      const user = buildUser();
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(user);

      const before = Date.now();
      const result = await service.requestDeletion('user-1', {
        password: KNOWN_PASSWORD,
        reason: 'no longer riding',
      });
      const after = Date.now();

      expect(result.status).toBe('scheduled');
      expect(result.grace_period_days).toBe(30);

      const scheduledMs = new Date(result.scheduled_for).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(scheduledMs - before).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
      expect(scheduledMs - after).toBeLessThanOrEqual(thirtyDaysMs + 1000);

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          deleted_at: expect.any(Date),
          deletion_scheduled_at: expect.any(Date),
          deletion_reason: 'no longer riding',
        }),
      );
      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          email: 'rider@tarmoto.app',
          event: 'requested',
          details: { reason: 'no longer riding' },
        }),
      );
      expect(auditRepo.save).toHaveBeenCalled();
    });

    it('rejects with 403 (not 401) when the password does not match — companion treats 401 as session expiry', async () => {
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());

      await expect(
        service.requestDeletion('user-1', { password: 'wrong' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(userRepo.update).not.toHaveBeenCalled();
      expect(auditRepo.save).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the account is already pending deletion', async () => {
      userRepo
        .createQueryBuilder()
        .getOne.mockResolvedValueOnce(
          buildUser({ deleted_at: new Date('2026-04-20T00:00:00Z') }),
        );

      await expect(
        service.requestDeletion('user-1', { password: KNOWN_PASSWORD }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('rejects with 404 when the user does not exist', async () => {
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(null);

      await expect(
        service.requestDeletion('user-missing', { password: KNOWN_PASSWORD }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('honours TARMOTO_ACCOUNT_DELETION_GRACE_DAYS override', async () => {
      const config = service['config'] as { get: jest.Mock };
      config.get.mockImplementation((key: string) =>
        key === 'TARMOTO_ACCOUNT_DELETION_GRACE_DAYS' ? '7' : undefined,
      );
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());

      const result = await service.requestDeletion('user-1', {
        password: KNOWN_PASSWORD,
      });

      expect(result.grace_period_days).toBe(7);
    });
  });

  describe('processDueDeletions (hard delete sweeper)', () => {
    it('cancels Stripe and purges users whose grace window has elapsed', async () => {
      const due = buildUser({
        id: 'expired-1',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc',
        deletion_reason: 'gdpr',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
      expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_abc');
      expect(surfaceUpdateExecute).toHaveBeenCalled();
      expect(txManager.delete).toHaveBeenCalledWith(User, { id: 'expired-1' });
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          user_id: 'expired-1',
          email: 'rider@tarmoto.app',
          event: 'purged',
          stripe_customer_id: 'cus_abc',
          stripe_subscription_id: 'sub_abc',
          details: expect.objectContaining({
            stripe_subscription_canceled: true,
            stripe_customer_deleted: true,
            deletion_reason: 'gdpr',
          }),
        }),
      );
    });

    it('skips Stripe entirely when billing is not configured', async () => {
      stripe.isConfigured.mockReturnValue(false);
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_orphan',
        stripe_subscription_id: 'sub_orphan',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      await service.processDueDeletions(new Date('2026-04-02T00:00:00Z'));

      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.deleteCustomer).not.toHaveBeenCalled();
      expect(txManager.delete).toHaveBeenCalled();
    });

    it('still purges DB rows when Stripe cancellation fails (logged for ops)', async () => {
      stripe.cancelSubscription.mockRejectedValueOnce(new Error('stripe down'));
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(1);
      expect(txManager.delete).toHaveBeenCalled();
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          details: expect.objectContaining({
            stripe_subscription_canceled: false,
            stripe_error: 'stripe down',
          }),
        }),
      );
    });

    it('continues the batch when one user fails to purge', async () => {
      const failing = buildUser({ id: 'fail-1' });
      const succeeding = buildUser({ id: 'ok-1', email: 'ok@tarmoto.app' });
      userRepo.find.mockResolvedValueOnce([failing, succeeding]);
      let calls = 0;
      dataSource.transaction.mockImplementation(
        async (cb: (manager: EntityManager) => Promise<unknown>) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('db blew up');
          }
          return cb(txManager as unknown as EntityManager);
        },
      );

      const purged = await service.processDueDeletions();

      expect(purged).toBe(1);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no users are due', async () => {
      userRepo.find.mockResolvedValueOnce([]);
      const purged = await service.processDueDeletions();
      expect(purged).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('does not touch the user row before its scheduled timestamp', async () => {
      // The repository query already filters by `deletion_scheduled_at <= now`,
      // so a user scheduled in the future is simply not returned. This test
      // documents that contract by asserting `userRepo.find` was called with
      // a `LessThanOrEqual(now)` clause.
      const fakeNow = new Date('2026-04-15T00:00:00Z');
      userRepo.find.mockResolvedValueOnce([]);

      await service.processDueDeletions(fakeNow);

      expect(userRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletion_scheduled_at: expect.objectContaining({
              _type: 'lessThanOrEqual',
              _value: fakeNow,
            }),
          }),
        }),
      );
    });
  });
});
