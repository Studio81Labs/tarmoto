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
      // Default disambiguating read (only consulted on a zero-row Apple claim):
      // an unowned/absent row resolves an affected=0 to 'conflict'.
      findOne: jest.fn().mockResolvedValue(null),
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
    const SIGNED_DATE = new Date('2026-08-23T12:00:00Z');
    const appleClaimFields = {
      tier: 'pro' as const,
      status: 'active' as const,
      currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
      signedDate: SIGNED_DATE,
      cancelAtPeriodEnd: false,
    };

    // Finding 1: WHERE = A OR B. Branch A (genuine replacement of an unowned
    // slot bearing a DIFFERENT/absent otid) has NO ordering guard; branch B
    // (same-OTID reclaim after a terminal clear OR active Apple ownership) is
    // ordering-guarded on the monotonic signedDate. The period is no longer the
    // ordering key.
    const COMBINED_GUARD =
      '((subscription_provider IS NULL AND apple_original_transaction_id IS DISTINCT FROM :otid)' +
      ' OR (((subscription_provider IS NULL AND apple_original_transaction_id = :otid)' +
      " OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
      ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)))';

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
        subscription_store_signed_date: SIGNED_DATE,
        subscription_cancel_at_period_end: false,
        plan_source: 'subscription',
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      // Finding 1: the A-OR-B guard, carrying the otid identity AND the monotonic
      // signedDate bound (inside branch B).
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
        otid: 'otid-1',
        signedDate: SIGNED_DATE,
      });
    });

    it('returns "conflict" when the guarded update affects zero rows and the row is not apple-owned by this otid', async () => {
      execute.mockResolvedValue({ affected: 0 });
      // Disambiguating read: a Stripe-owned row → genuine conflict.
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'stripe',
        apple_original_transaction_id: null,
        subscription_store_signed_date: null,
      });

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
        subscription_store_signed_date: SIGNED_DATE,
        plan_source: 'subscription',
      });
      // The trial stamp is a raw SQL function preserving an existing timestamp.
      const trialStamp = setArg?.billing_trial_used_at as () => string;
      expect(typeof trialStamp).toBe('function');
      expect(trialStamp()).toBe('COALESCE(billing_trial_used_at, NOW())');
    });

    // Finding 1: after a terminal transition RETAINS apple_original_transaction_id
    // (provider cleared to NULL), a same-OTID reactivation with a NEWER (or
    // equal) signedDate re-claims cleanly via branch B — the stored signedDate is
    // not newer than the incoming one, so the ordering guard passes.
    it('re-claims a reactivation on the retained OTID (guard passes → "claimed")', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('claimed');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
        otid: 'otid-1',
        signedDate: SIGNED_DATE,
      });
    });

    // Finding 1: after a terminal transition sets provider=NULL but RETAINS the
    // OLD otid, a later valid purchase carrying a NEW otid must REPLACE the stale
    // binding via branch A (`provider IS NULL AND otid IS DISTINCT FROM :otid`),
    // with NO ordering guard. The SET clause overwrites the otid + signedDate.
    it('replaces a stale retained OTID with a new one when the provider slot is unowned (NULL)', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple(
        'user-1',
        'otid-new',
        appleClaimFields,
      );

      expect(result).toBe('claimed');
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // The SET overwrites the binding to the NEW otid + signedDate.
      expect(setArg).toMatchObject({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-new',
        subscription_store_signed_date: SIGNED_DATE,
      });
      // The disambiguating read is never reached on a successful claim.
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    // Finding 1: Apple actively owns the slot with a DIFFERENT otid → branch B's
    // otid identity check blocks the write, and the disambiguating read confirms
    // a real conflict (the stored otid differs from the incoming one).
    it('returns "conflict" when apple owns the slot with a different otid', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-other',
        subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
      });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('conflict');
    });

    // Finding 1 — THE RACE: A(active, OLDER signedDate) must not overwrite
    // B(revoked/expired, NEWER signedDate that clearAppleTerminal stamped). The
    // guarded UPDATE affects 0 rows; the disambiguating read sees THIS otid with
    // a stored signedDate >= the incoming one → BENIGN 'stale', NOT a conflict —
    // so the rider stays free and the terminated sub is NOT resurrected. Covers
    // BOTH an active-owned-newer row and a terminal-cleared-newer row (provider
    // apple OR null).
    it('returns "stale" when a newer signedDate is already recorded for the owned otid (terminal-cleared)', async () => {
      execute.mockResolvedValue({ affected: 0 });
      // Terminal clear left provider NULL but retained the otid and stamped a
      // NEWER signedDate than A's stale active snapshot carries.
      userRepo.findOne.mockResolvedValue({
        subscription_provider: null,
        apple_original_transaction_id: 'otid-1',
        subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
      });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        signedDate: new Date('2026-01-01T00:00:00Z'), // A's OLDER signedDate
      });

      expect(result).toBe('stale');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
        otid: 'otid-1',
        signedDate: new Date('2026-01-01T00:00:00Z'),
      });
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });

    // Finding 1: same as above but the row is still active-owned (provider apple)
    // with a newer signedDate — also a benign 'stale' no-op.
    it('returns "stale" when an active-owned row already holds a newer signedDate for this otid', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-1',
        subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
      });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        signedDate: new Date('2026-01-01T00:00:00Z'),
      });

      expect(result).toBe('stale');
    });

    // Finding 1: a genuinely NEWER same-OTID reactivation (incoming signedDate >
    // stored) wins the ordering guard → the claim succeeds.
    it('returns "claimed" for a genuinely newer same-OTID reactivation (signedDate advances)', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        signedDate: new Date('2027-01-01T00:00:00Z'), // newer signedDate
      });

      expect(result).toBe('claimed');
    });

    // Finding 1: a zero-row miss where the stored otid matches but NO signedDate
    // was ever recorded is a genuine conflict (not stale) — there is no newer
    // state to defer to.
    it('returns "conflict" when the owned otid has no recorded signedDate', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-1',
        subscription_store_signed_date: null,
      });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('conflict');
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
    const SIGNED_DATE = new Date('2026-08-23T12:00:00Z');

    // Finding 1: the terminal transition clears ACTIVE ownership but RETAINS
    // apple_original_transaction_id as a historical store binding, AND stamps the
    // terminal state's signedDate so a later stale active snapshot can't resurrect
    // the killed sub.
    it('clears active ownership, RETAINS the otid, stamps + guards on signedDate', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        SIGNED_DATE,
      );

      expect(result).toBe(true);
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // Active ownership is cleared; the terminal signedDate is stamped...
      expect(setArg).toEqual({
        subscription_provider: null,
        plan_source: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: SIGNED_DATE,
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
      // Finding 1: monotonic signedDate guard — only clear when the stored
      // signedDate is NOT newer than what this caller observed.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)',
        { signedDate: SIGNED_DATE },
      );
    });

    it('returns false when the stored original transaction id differs (identity guard blocks the clear)', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-old',
        SIGNED_DATE,
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'apple_original_transaction_id = :otid',
        { otid: 'otid-old' },
      );
    });

    // Finding 1: a STALE terminal (A saw an OLDER signedDate) must NOT clear a
    // row whose state a concurrent recovery (B saw a NEWER signedDate, committed
    // the renewed state) already advanced. The monotonic guard makes A's guarded
    // UPDATE affect 0 rows, so the row keeps B's tier and A no-ops.
    it('no-ops (affects 0 rows) when a concurrent recovery stamped a newer signedDate than this caller observed', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2026-01-01T00:00:00Z'), // A's older observed signedDate
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)',
        { signedDate: new Date('2026-01-01T00:00:00Z') },
      );
    });

    // Finding 1: a genuine terminal with no concurrent recovery still downgrades
    // (the guarded UPDATE affects the row).
    it('clears the row when no concurrent recovery advanced the state', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        SIGNED_DATE,
      );

      expect(result).toBe(true);
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
