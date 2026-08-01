import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProviderClaimService } from './provider-claim.service.js';
import { User } from '../../entities/user.entity.js';

describe('ProviderClaimService', () => {
  let service: ProviderClaimService;
  let userRepo: Partial<jest.Mocked<Repository<User>>> & {
    createQueryBuilder: jest.Mock;
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
  });

  describe('claimForApple', () => {
    const appleClaimFields = {
      tier: 'pro' as const,
      status: 'active' as const,
      currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
      cancelAtPeriodEnd: false,
    };

    it('returns "claimed" when the guarded update affects one row', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('claimed');
      expect(userRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queryBuilder.set).toHaveBeenCalledWith({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-1',
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_current_period_end: appleClaimFields.currentPeriodEnd,
        subscription_cancel_at_period_end: false,
        plan_source: 'subscription',
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'apple')",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)',
        { otid: 'otid-1' },
      );
    });

    it('returns "conflict" when the guarded update affects zero rows', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('conflict');
    });

    it('returns "conflict" when affected is undefined', async () => {
      execute.mockResolvedValue({ affected: undefined });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('conflict');
    });

    // Finding 3: the otid is already stored on ANOTHER user's row — the partial
    // unique index rejects the UPDATE with a 23505 QueryFailedError. The method
    // must translate that to 'conflict' (not let an untyped 500 escape).
    it('returns "conflict" when the UPDATE hits a 23505 unique violation', async () => {
      execute.mockRejectedValue({
        name: 'QueryFailedError',
        driverError: { code: '23505' },
      });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('conflict');
    });

    it('rethrows a non-unique-violation error (no blanket catch)', async () => {
      const other = Object.assign(new Error('deadlock detected'), {
        driverError: { code: '40P01' },
      });
      execute.mockRejectedValue(other);

      await expect(
        service.claimForApple('user-1', 'otid-1', appleClaimFields),
      ).rejects.toBe(other);
    });

    // Finding 3: the trial stamp is folded into the SAME atomic UPDATE as the
    // claim. A single guarded UPDATE sets both the tier and
    // billing_trial_used_at (via COALESCE, so an already-set stamp is
    // preserved) — no separate post-claim stamp write.
    it('stamps billing_trial_used_at via COALESCE in the SAME UPDATE when markTrialUsed is true', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        markTrialUsed: true,
      });

      expect(result).toBe('claimed');
      // Exactly one UPDATE issued (the claim) — no second stamp statement.
      expect(userRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);

      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(setArg).toMatchObject({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-1',
        subscription_tier: 'pro',
        subscription_status: 'active',
        plan_source: 'subscription',
      });
      // The trial stamp is a raw SQL function preserving an existing timestamp.
      const trialStamp = setArg?.billing_trial_used_at as () => string;
      expect(typeof trialStamp).toBe('function');
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
    });

    // Finding 2: after a terminal transition RETAINS apple_original_transaction_id
    // (provider cleared to NULL), a same-OTID reactivation re-claims cleanly —
    // both guards pass: `subscription_provider IS NULL` and
    // `apple_original_transaction_id = :otid` match the retained binding.
    it('re-claims a reactivation on the retained OTID (both guards pass → "claimed")', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('claimed');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'apple')",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)',
        { otid: 'otid-1' },
      );
    });

    it('omits the billing_trial_used_at write entirely when markTrialUsed is not set', async () => {
      execute.mockResolvedValue({ affected: 1 });

      await service.claimForApple('user-1', 'otid-1', appleClaimFields);

      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(setArg).not.toHaveProperty('billing_trial_used_at');
    });
  });

  describe('clearAppleTerminal', () => {
    // Finding 2: the terminal transition clears ACTIVE ownership but RETAINS
    // apple_original_transaction_id as a historical store binding, so a later
    // store-side reactivation can still resolve the rider by OTID.
    it('clears active ownership but RETAINS the original transaction id, with the identity + monotonic period guards', async () => {
      execute.mockResolvedValue({ affected: 1 });
      const observed = new Date('2026-08-23T12:00:00Z');

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        observed,
      );

      expect(result).toBe(true);
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // Active ownership is cleared...
      expect(setArg).toEqual({
        subscription_provider: null,
        plan_source: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
      });
      // ...but the store binding is RETAINED (not written to null).
      expect(setArg).not.toHaveProperty('apple_original_transaction_id');
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "subscription_provider = 'apple'",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'apple_original_transaction_id = :otid',
        { otid: 'otid-1' },
      );
      // Finding 1: monotonic period guard — only clear when the stored period is
      // NOT newer than what this caller observed.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_current_period_end IS NULL OR subscription_current_period_end <= :observedExpiresAt)',
        { observedExpiresAt: observed },
      );
    });

    it('returns false when the stored original transaction id differs (identity guard blocks the clear)', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-old',
        new Date('2026-08-23T12:00:00Z'),
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'apple_original_transaction_id = :otid',
        { otid: 'otid-old' },
      );
    });

    // Finding 1: a STALE terminal (A saw an OLDER expiry) must NOT clear a row
    // whose period a concurrent recovery (B saw a NEWER expiry, committed the
    // renewed period) already advanced. The monotonic guard makes A's guarded
    // UPDATE affect 0 rows, so the row keeps B's tier + period and A no-ops.
    it('no-ops (affects 0 rows) when a concurrent recovery advanced the period past what this caller observed', async () => {
      // Postgres: the row's subscription_current_period_end is now B's newer
      // date, so `stored <= :observedExpiresAt` (A's older expiry) is false and
      // the guarded UPDATE matches no row.
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2026-01-01T00:00:00Z'), // A's older observed expiry
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_current_period_end IS NULL OR subscription_current_period_end <= :observedExpiresAt)',
        { observedExpiresAt: new Date('2026-01-01T00:00:00Z') },
      );
    });

    // Finding 1: a genuine terminal with no concurrent recovery still downgrades
    // (the guarded UPDATE affects the row).
    it('clears the row when no concurrent recovery advanced the period', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2026-08-23T12:00:00Z'),
      );

      expect(result).toBe(true);
    });

    // Finding 1: null observed expiry can't prove the row is stale relative to
    // any concrete period, so it clears ONLY when the stored period is also
    // NULL — never clobbering a (possibly concurrently-advanced) non-null one.
    it('uses the IS-NULL guard (not the <= comparison) when the observed expiry is null', async () => {
      execute.mockResolvedValue({ affected: 1 });

      await service.clearAppleTerminal('user-1', 'otid-1', null);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'subscription_current_period_end IS NULL',
      );
      const guardCalls = (
        queryBuilder.andWhere.mock.calls as unknown as Array<[string, unknown?]>
      ).map((call) => call[0]);
      expect(guardCalls).not.toContain(
        '(subscription_current_period_end IS NULL OR subscription_current_period_end <= :observedExpiresAt)',
      );
    });
  });

  describe('clearStripeTerminal', () => {
    it('returns true and includes the identity guard when the stored subscription id matches', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearStripeTerminal('user-1', 'sub-1');

      expect(result).toBe(true);
      expect(queryBuilder.set).toHaveBeenCalledWith({
        subscription_provider: null,
        plan_source: null,
        stripe_subscription_id: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
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

      const result = await service.clearStripeTerminal('user-1', 'sub-old');

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'stripe_subscription_id = :sub',
        { sub: 'sub-old' },
      );
    });
  });
});
