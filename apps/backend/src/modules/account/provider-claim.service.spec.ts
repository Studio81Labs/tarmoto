import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProviderClaimService } from './provider-claim.service.js';
import { User } from '../../entities/user.entity.js';

describe('ProviderClaimService', () => {
  let service: ProviderClaimService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    query: jest.Mock;
    existsBy: jest.Mock;
  };
  let execute: jest.Mock;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };

  const claimFields = {
    tier: 'pro' as const,
    status: 'active' as const,
    currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
    cancelAtPeriodEnd: false,
    planSource: 'subscription' as const,
    fenceToken: 1,
  };

  beforeEach(async () => {
    execute = jest.fn().mockResolvedValue({ affected: 1 });
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    userRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue([{ fence: 0 }]),
      // Fence-stale guard (`assertSubscriptionFenceCurrent`): default not stale.
      existsBy: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderClaimService,
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get(ProviderClaimService);
  });

  describe('claimForStripe', () => {
    it('returns "claimed" when the guarded update affects one row', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForStripe(
        'user-1',
        'sub-1',
        claimFields,
      );

      expect(result).toBe('claimed');
      expect(userRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_provider: 'stripe',
          stripe_subscription_id: 'sub-1',
          subscription_tier: 'pro',
          subscription_status: 'active',
          subscription_current_period_end: claimFields.currentPeriodEnd,
          subscription_cancel_at_period_end: false,
          plan_source: 'subscription',
        }),
      );
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: 'sub-1' },
      );
    });

    it('returns "conflict" when the guarded update affects zero rows', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.claimForStripe(
        'user-1',
        'sub-1',
        claimFields,
      );

      expect(result).toBe('conflict');
    });

    it('returns "conflict" when affected is undefined', async () => {
      execute.mockResolvedValue({ affected: undefined });

      const result = await service.claimForStripe(
        'user-1',
        'sub-1',
        claimFields,
      );

      expect(result).toBe('conflict');
    });

    it('omits the subscription_status write but keeps the mutable fields and guard when skipStatus is set', async () => {
      // The caller passes skipStatus when an activation/past_due transition
      // UPDATE already owns the status for this event: re-stamping it here could
      // clobber a newer, concurrently-committed status for the same
      // subscription. The ownership/identity guard and the mutable-field refresh
      // still run so conflict detection is unaffected.
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForStripe(
        'user-1',
        'sub-1',
        claimFields,
        {
          skipStatus: true,
        },
      );

      expect(result).toBe('claimed');
      const setCalls = queryBuilder.set.mock.calls as unknown as Array<
        [Record<string, unknown>]
      >;
      const setArg = setCalls.at(-1)?.[0];
      // The status write is omitted entirely...
      expect(setArg).not.toHaveProperty('subscription_status');
      // ...while every mutable field (and ownership) is still refreshed.
      expect(setArg).toMatchObject({
        subscription_provider: 'stripe',
        stripe_subscription_id: 'sub-1',
        subscription_tier: 'pro',
        subscription_current_period_end: claimFields.currentPeriodEnd,
        subscription_cancel_at_period_end: false,
        plan_source: 'subscription',
      });
      // The ownership/identity guard is unchanged so conflict detection still
      // works.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: 'sub-1' },
      );
    });

    it('omits the ownership writes but keeps the mutable fields and guard when skipOwnership is set', async () => {
      // The caller passes skipOwnership for a subscription that has NEVER
      // entitled the rider landing on a founder/promo/admin grant. Recording it
      // as the row's Stripe owner would arm `clearStripeTerminal` (provider =
      // 'stripe' AND the stored id) to wipe that grant when the dead checkout
      // later expires — and to send a cancellation mail for it. The row is still
      // refreshed and the exclusivity guard still runs.
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForStripe(
        'user-1',
        'sub-1',
        { ...claimFields, tier: 'premium', planSource: 'founder' },
        { skipOwnership: true },
      );

      expect(result).toBe('claimed');
      const setCalls = queryBuilder.set.mock.calls as unknown as Array<
        [Record<string, unknown>]
      >;
      const setArg = setCalls.at(-1)?.[0];
      // The slot is NOT taken...
      expect(setArg).not.toHaveProperty('subscription_provider');
      expect(setArg).not.toHaveProperty('stripe_subscription_id');
      // ...while the preserved grant and every other mutable field still land.
      expect(setArg).toMatchObject({
        subscription_tier: 'premium',
        subscription_status: 'active',
        plan_source: 'founder',
        subscription_current_period_end: claimFields.currentPeriodEnd,
        subscription_cancel_at_period_end: false,
      });
      // Conflict detection is unaffected: an Apple/Google-owned row or a
      // different subscription id is still rejected by the WHERE clause.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
        { sub: 'sub-1' },
      );
    });
  });

  describe('clearStripeTerminal', () => {
    it('returns true and includes the identity guard when the stored subscription id matches', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearStripeTerminal('user-1', 'sub-1', 1);

      expect(result).toBe(true);
      expect(queryBuilder.set).toHaveBeenCalledWith({
        subscription_provider: null,
        plan_source: null,
        stripe_subscription_id: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_lock_fence: 1,
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "subscription_provider = 'stripe'",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'stripe_subscription_id = :sub',
        { sub: 'sub-1' },
      );
    });

    it('returns false when the stored subscription id differs (stale/superseded event)', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearStripeTerminal('user-1', 'sub-old', 1);

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'stripe_subscription_id = :sub',
        { sub: 'sub-old' },
      );
    });

    it('releases the slot but KEEPS the tier and provenance when preserveGrant is set', async () => {
      // A founder/promo/admin grant is not the ending subscription's to revoke.
      // `claimForStripe`'s `skipOwnership` cannot cover this case: it only
      // avoids ADDING ownership, and a row that was already Stripe-owned when
      // the grant was applied still matches this clear's guard.
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearStripeTerminal('user-1', 'sub-1', 1, {
        preserveGrant: true,
      });

      expect(result).toBe(true);
      const setCalls = queryBuilder.set.mock.calls as unknown as Array<
        [Record<string, unknown>]
      >;
      const setArg = setCalls.at(-1)?.[0];
      // The entitlement fields are left standing...
      expect(setArg).not.toHaveProperty('subscription_tier');
      expect(setArg).not.toHaveProperty('plan_source');
      // ...while the Stripe slot is still fully released, so a later event for
      // this subscription can no longer match this row.
      expect(setArg).toMatchObject({
        subscription_provider: null,
        stripe_subscription_id: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
      });
      // The guards are untouched, so identity/ownership/fence behaviour — and
      // the stale-fence 503 — are unchanged.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "subscription_provider = 'stripe'",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'stripe_subscription_id = :sub',
        { sub: 'sub-1' },
      );
    });

    it('matches ONLY a Stripe-owned row — the provider guard is a strict equality, never an IS NULL match', async () => {
      // Load-bearing for the grant-preservation fix in `AccountService`: a
      // never-entitling checkout deliberately leaves `subscription_provider`
      // NULL on a founder/promo/admin row, and it is THIS strict equality that
      // then makes the follow-on terminal event a no-op instead of wiping the
      // grant (and mailing the rider that it was cancelled). Loosening this to
      // the `(... IS NULL OR ...)` form used by `clearStripeTerminal`'s Apple
      // sibling — which intentionally also matches the unowned same-OTID
      // tombstone — would silently reintroduce that revocation, so pin the
      // exact predicate in both directions.
      execute.mockResolvedValue({ affected: 1 });

      await service.clearStripeTerminal('user-1', 'sub-1', 1);

      const predicates = (
        queryBuilder.andWhere.mock.calls as unknown as Array<[string]>
      ).map(([sql]) => sql);
      expect(predicates).toContain("subscription_provider = 'stripe'");
      expect(predicates).not.toContain(
        "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
      );
      expect(predicates).not.toContain(
        "(subscription_provider = 'stripe' OR subscription_provider IS NULL)",
      );
    });
  });

  // Round-15: a 0-row guarded UPDATE can mean this flow's FENCE is stale (a newer
  // holder advanced past our token), NOT a business rejection. Each classifier
  // must surface a retryable 503 in that case rather than a wrong verdict.
  describe('fence-stale (0-row = a newer holder advanced the fence)', () => {
    it('claimForStripe throws a retryable 503 instead of a false conflict', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.existsBy.mockResolvedValue(true); // a newer fence is present

      await expect(
        service.claimForStripe('user-1', 'sub-1', claimFields),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('clearStripeTerminal throws a retryable 503 instead of a silent false', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.existsBy.mockResolvedValue(true);

      await expect(
        service.clearStripeTerminal('user-1', 'sub-1', 1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
