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
      // Default disambiguating read (only consulted on a zero-row Apple claim):
      // an unowned/absent row resolves an affected=0 to 'conflict'.
      findOne: jest.fn().mockResolvedValue(null),
      // The stale-fence read in `claimForApple`'s zero-row branch. Driver shape:
      // a SELECT returns plain rows (not the `[rows, count]` tuple an
      // `UPDATE ... RETURNING` produces). Defaults to fence 0 — below every
      // minted token — so tests that do not care about the fence keep taking the
      // business-classification path they were written for.
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

  describe('claimForGoogle', () => {
    it('claims an unowned slot and stamps the ordering key and fence', async () => {
      queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

      const result = await service.claimForGoogle('user-1', 'gp-otid-1', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
        observedAt: new Date('2026-08-06T12:00:00Z'),
        cancelAtPeriodEnd: false,
        fenceToken: 7,
      });

      expect(result).toBe('claimed');
      expect(queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_provider: 'google',
          google_original_transaction_id: 'gp-otid-1',
          subscription_tier: 'pro',
          plan_source: 'subscription',
          subscription_store_signed_date: new Date('2026-08-06T12:00:00Z'),
          subscription_lock_fence: 7,
        }),
      );
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      // The WHERE clause is this method's entire safety mechanism — pin all
      // four guard predicates' exact SQL and bound parameters so a deleted,
      // mistyped, or inverted (e.g. `<=` flipped to `>=`) guard fails a test
      // even though `execute()` is a bare mock that ignores what was built.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider IS NULL OR subscription_provider = 'google')",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(google_original_transaction_id IS NULL OR google_original_transaction_id = :otid)',
        { otid: 'gp-otid-1' },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt: new Date('2026-08-06T12:00:00Z') },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'subscription_lock_fence <= :fence',
        { fence: 7 },
      );
    });

    it("returns 'conflict' when the guard matches no row", async () => {
      queryBuilder.execute.mockResolvedValueOnce({ affected: 0 });

      const result = await service.claimForGoogle('user-1', 'gp-otid-1', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: null,
        observedAt: new Date('2026-08-06T12:00:00Z'),
        cancelAtPeriodEnd: false,
        fenceToken: 7,
      });

      expect(result).toBe('conflict');
    });

    it('folds the once-per-rider trial stamp into the same statement when markTrialUsed is set', async () => {
      queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

      const result = await service.claimForGoogle('user-1', 'gp-otid-1', {
        tier: 'pro',
        status: 'trialing',
        currentPeriodEnd: null,
        observedAt: new Date('2026-08-06T12:00:00Z'),
        cancelAtPeriodEnd: false,
        markTrialUsed: true,
        fenceToken: 7,
      });

      expect(result).toBe('claimed');
      // Exactly one UPDATE issued (the claim) — no second stamp statement.
      // `createQueryBuilder` always returns this SAME mocked queryBuilder, so
      // without this call-count check a separate follow-up `.set()` call would
      // still land as `.mock.calls.at(-1)` below and this test would pass even
      // though the fold-into-one-statement property it claims to verify had
      // regressed.
      expect(userRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queryBuilder.execute).toHaveBeenCalledTimes(1);

      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // The SAME set() call also carries the grant fields, proving the trial
      // stamp landed on the SAME statement as the claim rather than a
      // same-shaped call made in isolation.
      expect(setArg).toMatchObject({
        subscription_provider: 'google',
        google_original_transaction_id: 'gp-otid-1',
        subscription_tier: 'pro',
        subscription_status: 'trialing',
      });
      // Folded into the SAME UPDATE, as a raw COALESCE expression — a separate
      // follow-up statement would leave a window where a concurrent claim on
      // another provider could consume the trial marker a second time.
      expect(typeof setArg?.['billing_trial_used_at']).toBe('function');
    });

    it('omits the trial stamp entirely when markTrialUsed is not set', async () => {
      queryBuilder.execute.mockResolvedValueOnce({ affected: 1 });

      await service.claimForGoogle('user-1', 'gp-otid-1', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: null,
        observedAt: new Date('2026-08-06T12:00:00Z'),
        cancelAtPeriodEnd: false,
        fenceToken: 7,
      });

      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(setArg).not.toHaveProperty('billing_trial_used_at');
    });
  });

  describe('claimForApple', () => {
    const SIGNED_DATE = new Date('2026-08-23T12:00:00Z');
    // Default CAS baseline: a fresh, unowned, never-signed slot (the common
    // step-3 read for a first purchase). Branch A's compare-and-swap requires the
    // row to still match this at claim time; individual tests override the
    // `observed*` fields and/or the disambiguating `findOne` to model a slot that
    // did (or did not) change since the read.
    const appleClaimFields = {
      tier: 'pro' as const,
      status: 'active' as const,
      currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
      signedDate: SIGNED_DATE,
      cancelAtPeriodEnd: false,
      observedProvider: null,
      observedOriginalTransactionId: null,
      observedSignedDate: null,
      fenceToken: 1,
    };

    // WHERE = A OR B. Branch A (cross-lineage replacement of an unowned slot
    // bearing a DIFFERENT/absent otid) is guarded by a COMPARE-AND-SWAP on the
    // initially-observed row version (Finding 1, round 25) — `IS NOT DISTINCT
    // FROM` on provider/otid/signedDate — instead of a meaningless cross-lineage
    // monotonic compare. Branch B (same-OTID reclaim / active ownership) keeps its
    // monotonic signedDate ordering guard.
    const COMBINED_GUARD =
      '((subscription_provider IS NULL AND apple_original_transaction_id IS DISTINCT FROM :otid AND subscription_provider IS NOT DISTINCT FROM :casProvider AND apple_original_transaction_id IS NOT DISTINCT FROM :casOtid AND subscription_store_signed_date IS NOT DISTINCT FROM :casSignedDate)' +
      ' OR (((subscription_provider IS NULL AND apple_original_transaction_id = :otid)' +
      " OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
      ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)))';

    // The parameter object the CAS-form guard is invoked with when the default
    // (null) observed baseline is used.
    const casParams = {
      casProvider: null,
      casOtid: null,
      casSignedDate: null,
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
        subscription_store_signed_date: SIGNED_DATE,
        subscription_cancel_at_period_end: false,
        plan_source: 'subscription',
        subscription_lock_fence: 1,
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      // Finding 1: the A-OR-B guard, carrying the otid identity, Branch A's CAS on
      // the observed baseline, AND the monotonic signedDate bound (inside branch
      // B).
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
        otid: 'otid-1',
        signedDate: SIGNED_DATE,
        ...casParams,
      });
    });

    it('returns "conflict" when the guarded update affects zero rows and the row is not apple-owned by this otid', async () => {
      execute.mockResolvedValue({ affected: 0 });
      // Disambiguating read: a Stripe-owned row that was ALREADY Stripe-owned at
      // the observed baseline (CAS still matches → the row did not change) →
      // genuine conflict, not a retryable CAS-fail.
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'stripe',
        apple_original_transaction_id: null,
        subscription_store_signed_date: null,
      });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        observedProvider: 'stripe',
      });

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

    // P2 review round 21, Finding 1: the otid is already stored on ANOTHER
    // user's row — the partial unique index rejects the UPDATE with a 23505
    // QueryFailedError. Because this UPDATE's WHERE targets ONLY the caller's
    // own row (`id = :userId`), the collision can only be with a DIFFERENT
    // rider's row — a cross-rider OWNERSHIP conflict. The method must
    // translate that to the DISTINCT 'ownership_conflict' result (not the
    // same-slot 'conflict'), and must NOT consult the disambiguating read.
    it('returns "ownership_conflict" (not "conflict") when the UPDATE hits a 23505 unique violation', async () => {
      execute.mockRejectedValue({
        name: 'QueryFailedError',
        driverError: { code: '23505' },
      });

      const result = await service.claimForApple(
        'user-1',
        'otid-1',
        appleClaimFields,
      );

      expect(result).toBe('ownership_conflict');
      expect(userRepo.findOne).not.toHaveBeenCalled();
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
        ...casParams,
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

      // The row was ALREADY apple-owned by otid-other at the observed baseline
      // (the CAS still matches → unchanged), so this is a genuine exclusivity
      // conflict, not a retryable CAS-fail.
      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        observedProvider: 'apple',
        observedOriginalTransactionId: 'otid-other',
        observedSignedDate: new Date('2027-01-01T00:00:00Z'),
      });

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
        ...casParams,
      });
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });

    // Finding 4: a zero-row miss where another ACTIVE provider (Stripe) now owns
    // the slot but the retained apple otid + a newer signedDate still linger from
    // a prior terminal clear is an exclusivity CONFLICT, not a benign 'stale'
    // no-op. Otherwise the endpoint would hand back Stripe's snapshot as success
    // and open no exclusivity reconciliation. The 'stale' classification is
    // scoped to provider 'apple' OR NULL.
    it('returns "conflict" when stripe owns the slot despite a retained apple otid + newer signedDate', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'stripe',
        apple_original_transaction_id: 'otid-1',
        subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
      });

      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        signedDate: new Date('2026-01-01T00:00:00Z'),
        // Stripe already owned the slot (with a retained apple otid/date) at the
        // observed baseline — the CAS still matches, so this is a genuine
        // exclusivity conflict, not a CAS-fail retry.
        observedProvider: 'stripe',
        observedOriginalTransactionId: 'otid-1',
        observedSignedDate: new Date('2027-01-01T00:00:00Z'),
      });

      expect(result).toBe('conflict');
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

      // Unchanged since the observed baseline (CAS matches), same otid but no
      // recorded signedDate → no newer state to defer to → genuine conflict.
      const result = await service.claimForApple('user-1', 'otid-1', {
        ...appleClaimFields,
        observedProvider: 'apple',
        observedOriginalTransactionId: 'otid-1',
        observedSignedDate: null,
      });

      expect(result).toBe('conflict');
    });

    // Finding 1 (round 25): Branch A uses a COMPARE-AND-SWAP on the initially
    // observed row version instead of a cross-lineage monotonic guard. Round 24's
    // monotonic guard here caused a livelock — an active OTID whose latest
    // signedDate PREDATES a retained DIFFERENT-otid tombstone (a rider switching
    // back to an older App Store account) was rejected forever. The CAS fixes it:
    // when the row is UNCHANGED since the observed version it replaces (even over
    // a later-signed different-otid tombstone), and only a CONCURRENT change since
    // the read blocks it (→ retryable 'stale').
    describe('Branch A compare-and-swap (Finding 1, round 25)', () => {
      it('(a) claims when the row is UNCHANGED since the observed version, even over a LATER-signed different-otid tombstone (no false stale — round 25 fix)', async () => {
        // The slot is a pre-existing DIFFERENT-otid tombstone with a signedDate
        // LATER than this active OTID's. It was already in this state at the
        // service's initial read, so the CAS matches and — with NO cross-lineage
        // ordering guard on Branch A — the replacement lands in real Postgres.
        execute.mockResolvedValue({ affected: 1 });

        const result = await service.claimForApple('user-1', 'otid-older-A', {
          ...appleClaimFields,
          signedDate: new Date('2026-01-01T00:00:00Z'), // OLDER than the tombstone
          observedProvider: null,
          observedOriginalTransactionId: 'otid-newer-B',
          observedSignedDate: new Date('2027-01-01T00:00:00Z'),
        });

        expect(result).toBe('claimed');
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
          otid: 'otid-older-A',
          signedDate: new Date('2026-01-01T00:00:00Z'),
          casProvider: null,
          casOtid: 'otid-newer-B',
          casSignedDate: new Date('2027-01-01T00:00:00Z'),
        });
      });

      it('(b) classifies "stale" when the row CHANGED since the observed version (a different tombstone/owner appeared) — round 24 race still covered', async () => {
        // The service observed a fresh (null) slot at step 3; by claim time a
        // concurrent newer DIFFERENT-otid tombstone appeared. The CAS no longer
        // matches, so the guarded UPDATE affects 0 rows, and the disambiguating
        // read (the changed row) → benign 'stale' (retryable), never a false
        // 'conflict' that would overwrite the newer tombstone.
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-newer-B',
          subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
        });

        const result = await service.claimForApple('user-1', 'otid-older-A', {
          ...appleClaimFields,
          signedDate: new Date('2026-01-01T00:00:00Z'),
          // observed baseline = fresh/unowned (default null), i.e. the slot
          // changed under us.
        });

        expect(result).toBe('stale');
      });

      it('(c) claims a fresh new-otid replacement when the observed baseline is null and the slot is still null at claim time', async () => {
        // A first-ever claim: observed (null, null, null) still holds at claim
        // time → the CAS matches and the UPDATE lands.
        execute.mockResolvedValue({ affected: 1 });

        const result = await service.claimForApple(
          'user-1',
          'otid-new',
          appleClaimFields,
        );

        expect(result).toBe('claimed');
      });
    });

    // Finding 2 (round 17): the atomic Branch A trial guard lost the race — a
    // concurrent validation for a DIFFERENT subscription consumed the rider's
    // once-per-rider trial (stamping billing_trial_used_at) and
    // terminal-cleared its OWN slot between this claim's eligibility read and
    // its guarded UPDATE. The slot is UNOWNED (not held by a rival
    // provider/otid), so this must be classified as 'trial_ineligible', not a
    // genuine exclusivity 'conflict'.
    describe('trial_ineligible classification', () => {
      it('returns "trial_ineligible" when a markTrialUsed claim finds the slot unowned with billing_trial_used_at set and a DIFFERENT otid', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-other-subscription',
          subscription_store_signed_date: null,
          billing_trial_used_at: new Date('2026-08-01T00:00:00Z'),
        });

        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(result).toBe('trial_ineligible');
      });

      it('returns "trial_ineligible" when a markTrialUsed claim finds the slot unowned with billing_trial_used_at set and NO otid recorded', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: null,
          subscription_store_signed_date: null,
          billing_trial_used_at: new Date('2026-08-01T00:00:00Z'),
        });

        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(result).toBe('trial_ineligible');
      });

      it('returns "conflict" (not "trial_ineligible") when a DIFFERENT active provider genuinely owns the slot', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: 'stripe',
          apple_original_transaction_id: null,
          subscription_store_signed_date: null,
          billing_trial_used_at: new Date('2026-08-01T00:00:00Z'),
        });

        // Stripe already owned the slot at the observed baseline (CAS matches →
        // unchanged), so this is a genuine exclusivity conflict.
        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
          observedProvider: 'stripe',
        });

        expect(result).toBe('conflict');
      });

      it('returns "conflict" (not "trial_ineligible") when markTrialUsed is false, even with the same unowned+stamped shape', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-other-subscription',
          subscription_store_signed_date: null,
          billing_trial_used_at: new Date('2026-08-01T00:00:00Z'),
        });

        // The row was already this different-otid tombstone at the observed
        // baseline (CAS matches → unchanged); markTrialUsed is false so the trial
        // guard never applies → genuine conflict.
        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: false,
          observedProvider: null,
          observedOriginalTransactionId: 'otid-other-subscription',
          observedSignedDate: null,
        });

        expect(result).toBe('conflict');
      });

      it('still resolves the same-otid case to "stale", not "trial_ineligible", when the guard blocked on ordering', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-new-trial',
          subscription_store_signed_date: new Date('2027-01-01T00:00:00Z'),
          billing_trial_used_at: new Date('2026-08-01T00:00:00Z'),
        });

        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(result).toBe('stale');
      });
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

    // P2 Finding 1: atomically recheck trial eligibility in Branch A ONLY.
    describe('trial-eligibility guard (Branch A)', () => {
      const NEW_OTID_TRIAL_GUARD =
        '((subscription_provider IS NULL AND apple_original_transaction_id IS DISTINCT FROM :otid AND billing_trial_used_at IS NULL AND subscription_provider IS NOT DISTINCT FROM :casProvider AND apple_original_transaction_id IS NOT DISTINCT FROM :casOtid AND subscription_store_signed_date IS NOT DISTINCT FROM :casSignedDate)' +
        ' OR (((subscription_provider IS NULL AND apple_original_transaction_id = :otid)' +
        " OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
        ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)))';

      it('includes "AND billing_trial_used_at IS NULL" in Branch A ONLY when markTrialUsed is true', async () => {
        execute.mockResolvedValue({ affected: 1 });

        await service.claimForApple('user-1', 'otid-new', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          NEW_OTID_TRIAL_GUARD,
          { otid: 'otid-new', signedDate: SIGNED_DATE, ...casParams },
        );
      });

      it('omits the trial guard entirely when markTrialUsed is false (Branch A keeps its CAS but no trial predicate)', async () => {
        execute.mockResolvedValue({ affected: 1 });

        await service.claimForApple('user-1', 'otid-new', {
          ...appleClaimFields,
          markTrialUsed: false,
        });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
          otid: 'otid-new',
          signedDate: SIGNED_DATE,
          ...casParams,
        });
      });

      // THE RACE this finding closes: a NEW-otid trial claim (markTrialUsed)
      // against a slot that CHANGED to a DIFFERENT-otid tombstone since the
      // observed baseline (a concurrent, DIFFERENT subscription's claim that
      // terminal-cleared its own slot). With no trial marker set, Branch A fails
      // on the CAS (the row moved under us), so the guarded UPDATE affects 0
      // rows and the disambiguating read classifies a retryable 'stale' — the
      // caller re-validates against the now-current state instead of granting a
      // second trial or opening a false conflict.
      it('classifies "stale" when a new-otid markTrialUsed claim finds the slot CHANGED to a different-otid tombstone since the observed version', async () => {
        execute.mockResolvedValue({ affected: 0 });
        userRepo.findOne.mockResolvedValue({
          subscription_provider: null,
          apple_original_transaction_id: 'otid-other-subscription',
          subscription_store_signed_date: null,
        });

        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
          // observed baseline = fresh/unowned (default null) → the slot changed.
        });

        expect(result).toBe('stale');
      });

      // Same claim, but billing_trial_used_at is still null (no concurrent
      // consumption) — Branch A matches normally and the genuine first trial is
      // granted.
      it('grants the trial: a new-otid markTrialUsed claim matches Branch A when billing_trial_used_at is still null', async () => {
        execute.mockResolvedValue({ affected: 1 });

        const result = await service.claimForApple('user-1', 'otid-new-trial', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(result).toBe('claimed');
      });

      // A SAME-otid reactivation (Branch B) must still succeed even though
      // billing_trial_used_at is already set for the rider's OWN trial — the
      // trial guard is confined to Branch A and never blocks Branch B.
      it('reactivation of the SAME otid still succeeds via Branch B even with billing_trial_used_at set (markTrialUsed true)', async () => {
        execute.mockResolvedValue({ affected: 1 });

        const result = await service.claimForApple('user-1', 'otid-1', {
          ...appleClaimFields,
          markTrialUsed: true,
        });

        expect(result).toBe('claimed');
        // Branch B's fragment (the same-otid-reclaim / active-ownership clause
        // plus its signedDate ordering guard) is sent unmodified — no trial
        // predicate reaches it.
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          expect.stringContaining(
            "OR (subscription_provider = 'apple' AND (apple_original_transaction_id IS NULL OR apple_original_transaction_id = :otid)))" +
              ' AND (subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :signedDate)))',
          ),
          { otid: 'otid-1', signedDate: SIGNED_DATE, ...casParams },
        );
      });

      // A markTrialUsed:false new-otid claim is unaffected by the stamp: the
      // trial guard is never applied, so the pre-fix behavior is preserved.
      it('a markTrialUsed:false new-otid claim is unaffected by billing_trial_used_at', async () => {
        execute.mockResolvedValue({ affected: 1 });

        const result = await service.claimForApple('user-1', 'otid-new', {
          ...appleClaimFields,
          markTrialUsed: false,
        });

        expect(result).toBe('claimed');
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(COMBINED_GUARD, {
          otid: 'otid-new',
          signedDate: SIGNED_DATE,
          ...casParams,
        });
      });
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
        1,
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
        subscription_lock_fence: 1,
      });
      // ...but the store binding is RETAINED (not written to null).
      expect(setArg).not.toHaveProperty('apple_original_transaction_id');
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider = 'apple' OR subscription_provider IS NULL)",
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
        1,
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
        1,
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
        1,
      );

      expect(result).toBe(true);
    });

    // Round 23 finding: a NEWER terminal observation must be able to advance
    // an ALREADY-cleared same-OTID tombstone's subscription_store_signed_date
    // — otherwise the tombstone's date freezes at the first clear, and a
    // later, older-but-still-newer-than-the-freeze active validation could
    // pass claimForApple's Branch B monotonic guard and resurrect the
    // subscription even though a newer terminal state was observed.
    it('(a) advances an already-cleared same-OTID tombstone (provider NULL) to a newer signedDate', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2027-03-01T00:00:00Z'), // the newer (300) terminal observation
        1,
      );

      expect(result).toBe(true);
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(setArg).toEqual({
        subscription_provider: null,
        plan_source: null,
        subscription_tier: 'free',
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: new Date('2027-03-01T00:00:00Z'),
        subscription_lock_fence: 1,
      });
      // The broadened WHERE: apple-owned OR already a null-provider tombstone.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider = 'apple' OR subscription_provider IS NULL)",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'apple_original_transaction_id = :otid',
        { otid: 'otid-1' },
      );
    });

    // (b) after the tombstone was advanced to 300, an older (200) active
    // reclaim must NOT resurrect the subscription: claimForApple's Branch B
    // monotonic guard blocks it (stored 300 > incoming 200 -> the guarded
    // UPDATE affects 0 rows in real Postgres). Here we simulate the
    // disambiguating read seeing the advanced tombstone.
    it('(b) a subsequent claimForApple Branch-B attempt at an older signedDate does not resurrect the advanced tombstone', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue({
        subscription_provider: null,
        apple_original_transaction_id: 'otid-1',
        subscription_store_signed_date: new Date('2027-03-01T00:00:00Z'), // advanced to 300
      });

      const result = await service.claimForApple('user-1', 'otid-1', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
        signedDate: new Date('2027-02-01T00:00:00Z'), // older (200) incoming
        cancelAtPeriodEnd: false,
        observedProvider: null,
        observedOriginalTransactionId: 'otid-1',
        observedSignedDate: new Date('2027-03-01T00:00:00Z'),
      });

      // stored (300) >= incoming (200) for the same otid, apple-owned-or-unowned
      // -> benign 'stale', never a resurrecting 'claimed'.
      expect(result).toBe('stale');
    });

    // (c) clearAppleTerminal must STILL NOT match a Stripe-owned row, even with
    // the same otid retained on it — the broadened WHERE must not clear rows
    // owned by a different provider.
    it('(c) does not match a Stripe-owned row with the same otid (no-op)', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2027-03-01T00:00:00Z'),
        1,
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "(subscription_provider = 'apple' OR subscription_provider IS NULL)",
      );
    });

    // (d) clearAppleTerminal must not match a null-provider row belonging to a
    // DIFFERENT otid — the identity guard keeps a fresh/never-Apple or
    // other-subscription tombstone from being touched.
    it('(d) does not match a null-provider row with a different otid (no-op)', async () => {
      execute.mockResolvedValue({ affected: 0 });

      const result = await service.clearAppleTerminal(
        'user-1',
        'otid-1',
        new Date('2027-03-01T00:00:00Z'),
        1,
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'apple_original_transaction_id = :otid',
        { otid: 'otid-1' },
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

  describe('clearGoogleTerminal', () => {
    it('clears ownership and tier and NULLS the store transaction id', async () => {
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearGoogleTerminal(
        'user-1',
        'gp-otid-1',
        new Date('2026-08-06T12:00:00Z'),
        7,
      );

      expect(result).toBe(true);
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      expect(setArg).toMatchObject({
        subscription_provider: null,
        subscription_tier: 'free',
        plan_source: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: new Date('2026-08-06T12:00:00Z'),
        subscription_lock_fence: 7,
        // NULLED, like clearStripeTerminal's stripe_subscription_id. Retaining
        // it would leave claimForGoogle's `(IS NULL OR = :otid)` identity guard
        // permanently unsatisfiable for a re-subscribe under a NEW original
        // transaction id — see the regression test at the end of this describe
        // block.
        google_original_transaction_id: null,
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'user-1',
      });
      // The WHERE clause is this method's entire safety mechanism — pin every
      // guard predicate's exact SQL and bound parameters (mirrors
      // claimForGoogle's happy-path test) so a deleted, mistyped, or inverted
      // guard fails a test even though `execute()` is a bare mock.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "subscription_provider = 'google'",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'google_original_transaction_id = :otid',
        { otid: 'gp-otid-1' },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)',
        { observedAt: new Date('2026-08-06T12:00:00Z') },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'subscription_lock_fence <= :fence',
        { fence: 7 },
      );
    });

    it('preserves a non-subscription grant when preserveGrant is set', async () => {
      // A founder/promo/admin grant is not the ending subscription's to
      // revoke — identical carve-out to clearStripeTerminal's preserveGrant.
      execute.mockResolvedValue({ affected: 1 });

      const result = await service.clearGoogleTerminal(
        'user-1',
        'gp-otid-1',
        new Date('2026-08-06T12:00:00Z'),
        7,
        { preserveGrant: true },
      );

      expect(result).toBe(true);
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      // The entitlement fields are left standing...
      expect(setArg).not.toHaveProperty('subscription_tier');
      expect(setArg).not.toHaveProperty('plan_source');
      // ...while the Google slot is still released regardless of preserveGrant
      // (the two are independent: preserveGrant only gates the tier/provenance
      // spread). The ordering watermark and the fence are pinned here too: both
      // are UNCONDITIONAL writes, and omitting them would let a future edit move
      // the watermark inside the `preserveGrant ? {} : {…}` spread — silently
      // dropping the ordering guard's advance on grant rows while keeping this
      // test and the happy-path one green.
      expect(setArg).toMatchObject({
        subscription_provider: null,
        google_original_transaction_id: null,
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_store_signed_date: new Date('2026-08-06T12:00:00Z'),
        subscription_lock_fence: 7,
      });
      // The guards are untouched, so identity/ownership/fence behaviour — and
      // the stale-fence 503 — are unchanged.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        "subscription_provider = 'google'",
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'google_original_transaction_id = :otid',
        { otid: 'gp-otid-1' },
      );
    });

    it('returns false when the identity guard matches nothing and the fence is current', async () => {
      execute.mockResolvedValue({ affected: 0 });
      // Fence check (`assertSubscriptionFenceCurrent`, which reads via
      // `repo.existsBy`) finds our token still current → a genuine
      // stale/superseded terminal, not lease loss. `existsBy` already
      // defaults to `false` in `beforeEach`; set it explicitly so the test
      // documents the scenario it exercises rather than relying on a fixture
      // default that could silently change.
      userRepo.existsBy.mockResolvedValueOnce(false);

      const result = await service.clearGoogleTerminal(
        'user-1',
        'gp-otid-old',
        new Date('2026-08-06T12:00:00Z'),
        7,
      );

      expect(result).toBe(false);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'google_original_transaction_id = :otid',
        { otid: 'gp-otid-old' },
      );
    });

    /** The `users` columns these two guarded UPDATEs read or write. */
    type SimulatedRow = {
      subscription_provider: string | null;
      google_original_transaction_id: string | null;
      subscription_store_signed_date: Date | null;
      subscription_current_period_end: Date | null;
      subscription_lock_fence: number;
      subscription_tier: string;
    };

    // Evaluates ONE captured `andWhere` predicate against the simulated row.
    // Exhaustive over the exact SQL these two methods emit, and it THROWS on
    // anything unrecognised: a renamed, reworded or newly-added guard must fail
    // loudly rather than silently evaluate `true` and let the simulation below
    // "pass" on a predicate it never actually checked.
    const evaluatePredicate = (
      row: SimulatedRow,
      sql: string,
      params: Record<string, unknown> | undefined,
    ): boolean => {
      switch (sql) {
        case "subscription_provider = 'google'":
          return row.subscription_provider === 'google';
        case "(subscription_provider IS NULL OR subscription_provider = 'google')":
          return (
            row.subscription_provider === null ||
            row.subscription_provider === 'google'
          );
        case 'google_original_transaction_id = :otid':
          return row.google_original_transaction_id === params?.['otid'];
        case '(google_original_transaction_id IS NULL OR google_original_transaction_id = :otid)':
          return (
            row.google_original_transaction_id === null ||
            row.google_original_transaction_id === params?.['otid']
          );
        case '(subscription_store_signed_date IS NULL OR subscription_store_signed_date <= :observedAt)': {
          const observedAt = params?.['observedAt'];
          if (!(observedAt instanceof Date)) {
            throw new Error('observedAt is not bound to a Date');
          }
          return (
            row.subscription_store_signed_date === null ||
            row.subscription_store_signed_date.getTime() <= observedAt.getTime()
          );
        }
        case 'subscription_lock_fence <= :fence': {
          const fence = params?.['fence'];
          if (typeof fence !== 'number') {
            throw new Error('fence is not bound to a number');
          }
          return row.subscription_lock_fence <= fence;
        }
        default:
          throw new Error(`unrecognised guard predicate: ${sql}`);
      }
    };

    // Replays the statement the service just built against the simulated row:
    // evaluates every captured predicate and applies the captured SET only when
    // all of them hold, returning the row count Postgres would report.
    const applyCapturedStatement = (row: SimulatedRow): number => {
      const predicates = queryBuilder.andWhere.mock.calls as unknown as Array<
        [string, Record<string, unknown> | undefined]
      >;
      if (
        !predicates.every(([sql, params]) =>
          evaluatePredicate(row, sql, params),
        )
      ) {
        return 0;
      }
      const setArg = (
        queryBuilder.set.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      ).at(-1)?.[0];
      if (setArg === undefined) {
        throw new Error('no SET clause was captured');
      }
      for (const [column, value] of Object.entries(setArg)) {
        if (typeof value === 'function') {
          throw new Error(`unexpected raw SQL expression for ${column}`);
        }
        Object.assign(row, { [column]: value });
      }
      return 1;
    };

    // REGRESSION — cancel-then-resubscribe must not lock the rider out of their
    // own re-purchase. This is the exact failure a retained
    // `google_original_transaction_id` produced, and the test whose absence let it
    // through.
    //
    // `execute()` is a bare mock in every other test here, so asserting a claim
    // result directly would prove nothing — it returns whatever the mock is
    // told. This test therefore SIMULATES the row across BOTH guarded
    // statements: it captures each method's real SET clause and real WHERE
    // predicates and applies the SET only when the predicates actually pass.
    // `'claimed'` is then a genuine consequence of the guards, so reverting
    // `clearGoogleTerminal`'s `google_original_transaction_id: null` to a retained
    // id fails this test with `'conflict'`.
    it('leaves the freed slot claimable by a LATER re-subscribe under a NEW original transaction id', async () => {
      // The rider's row while the ORIGINAL Play subscription is live.
      const row: SimulatedRow = {
        subscription_provider: 'google',
        google_original_transaction_id: 'gp-otid-A',
        subscription_store_signed_date: new Date('2026-08-06T12:00:00Z'),
        subscription_current_period_end: new Date('2026-09-01T12:00:00Z'),
        subscription_lock_fence: 7,
        subscription_tier: 'pro',
      };
      execute.mockImplementation(() =>
        Promise.resolve({ affected: applyCapturedStatement(row) }),
      );

      // 1. The Play subscription expires. The consumer re-queries, sees the
      //    terminal state, and clears under a fresh lease.
      const cleared = await service.clearGoogleTerminal(
        'user-1',
        'gp-otid-A',
        new Date('2026-09-01T12:00:00Z'),
        8,
      );

      expect(cleared).toBe(true);
      expect(row.subscription_provider).toBeNull();
      expect(row.subscription_tier).toBe('free');
      // The freed slot carries NO store identity, so no stale binding is left
      // to block a different purchase from claiming it.
      expect(row.google_original_transaction_id).toBeNull();

      queryBuilder.set.mockClear();
      queryBuilder.andWhere.mockClear();

      // 2. The rider re-subscribes later. That is a NEW subscription, so
      //    RevenueCat reports a DIFFERENT original_transaction_id for it, and
      //    the consumer's re-query is necessarily newer than the terminal's.
      const result = await service.claimForGoogle('user-1', 'gp-otid-B', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: new Date('2027-10-01T12:00:00Z'),
        observedAt: new Date('2026-10-01T12:00:00Z'),
        cancelAtPeriodEnd: false,
        fenceToken: 9,
      });

      // With the id retained this is `'conflict'` FOREVER: the provider guard
      // passes (NULL) but `(IS NULL OR = 'gp-otid-B')` can never match a
      // retained 'gp-otid-A'. The rider would keep being billed by Google while
      // stranded on `free`, and every redelivery and every future purchase
      // would re-open a reconciliation row. Nothing self-heals it.
      expect(result).toBe('claimed');
      expect(row.subscription_provider).toBe('google');
      expect(row.google_original_transaction_id).toBe('gp-otid-B');
      expect(row.subscription_tier).toBe('pro');
    });

    // REGRESSION — a RENEWAL must re-claim the SAME slot and advance the period.
    //
    // This is the defect that motivated binding on RevenueCat's
    // `original_transaction_id` rather than its `store_transaction_id` /
    // `transaction_id`. Per RevenueCat's field docs, `transaction_id` is
    // "Transaction identifier from the store" and CHANGES on every renewal (a
    // Play order id gains an incrementing `..N` suffix), while
    // `original_transaction_id` is
    // "`transaction_id` of the original transaction in the subscription" and is
    // stable for the subscription's lifetime. Had the binding stayed on the
    // per-period id, the identity guard `(google_original_transaction_id IS NULL
    // OR = :otid)` would reject EVERY renewal after the first — a reconciliation
    // row per renewal and a `subscription_current_period_end` frozen forever.
    //
    // Uses the same row simulation as the test above, so `'claimed'` and the
    // advanced period are genuine consequences of the real guards rather than a
    // mock's return value.
    it('re-claims the SAME slot on a renewal and advances the period end', async () => {
      // The rider's row after the INITIAL purchase claimed it.
      const row: SimulatedRow = {
        subscription_provider: 'google',
        google_original_transaction_id: 'gp-otid-A',
        subscription_store_signed_date: new Date('2026-08-06T12:00:00Z'),
        subscription_current_period_end: new Date('2026-09-06T12:00:00Z'),
        subscription_lock_fence: 7,
        subscription_tier: 'pro',
      };
      execute.mockImplementation(() =>
        Promise.resolve({ affected: applyCapturedStatement(row) }),
      );

      // The subscription renews. RevenueCat's `original_transaction_id` is
      // UNCHANGED (only the per-period transaction id moved on), the consumer
      // re-queries under a fresh lease, and the new period end is a month out.
      const result = await service.claimForGoogle('user-1', 'gp-otid-A', {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: new Date('2026-10-06T12:00:00Z'),
        observedAt: new Date('2026-09-06T12:00:00Z'),
        cancelAtPeriodEnd: false,
        fenceToken: 8,
      });

      expect(result).toBe('claimed');
      expect(row.subscription_provider).toBe('google');
      expect(row.subscription_tier).toBe('pro');
      // The whole point: the period actually MOVED. A frozen period end is how
      // this defect would present in production — the rider keeps being charged
      // by Google while their entitlement silently lapses at the old date.
      expect(row.subscription_current_period_end).toEqual(
        new Date('2026-10-06T12:00:00Z'),
      );
      expect(row.subscription_store_signed_date).toEqual(
        new Date('2026-09-06T12:00:00Z'),
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

    it('claimForGoogle throws a retryable 503 instead of a false conflict', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.existsBy.mockResolvedValue(true); // a newer fence is present

      await expect(
        service.claimForGoogle('user-1', 'gp-otid-1', {
          tier: 'pro',
          status: 'active',
          currentPeriodEnd: null,
          observedAt: new Date('2026-08-06T12:00:00Z'),
          cancelAtPeriodEnd: false,
          fenceToken: 7,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('clearStripeTerminal throws a retryable 503 instead of a silent false', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.existsBy.mockResolvedValue(true);

      await expect(
        service.clearStripeTerminal('user-1', 'sub-1', 1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('clearGoogleTerminal throws a retryable 503 instead of a silent false', async () => {
      execute.mockResolvedValue({ affected: 0 });
      userRepo.existsBy.mockResolvedValue(true); // a newer fence is present

      await expect(
        service.clearGoogleTerminal(
          'user-1',
          'gp-otid-1',
          new Date('2026-08-06T12:00:00Z'),
          7,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('claimForApple throws a retryable 503 instead of a false conflict', async () => {
      execute.mockResolvedValue({ affected: 0 });
      // The disambiguating re-read shows a fence STRICTLY GREATER than our token.
      //
      // The fence comes from its OWN query, not from `findOne`: the column is
      // `select: false` so it cannot ride along on whole-entity saves, which
      // means a `findOne` never carries it. A mock that puts it on the entity
      // instead would pass while production read `undefined` and reported a false
      // conflict — the regression this arrangement exists to prevent.
      userRepo.findOne.mockResolvedValue({
        subscription_provider: 'apple',
        apple_original_transaction_id: 'otid-1',
      } as unknown as User);
      userRepo.query.mockResolvedValue([{ fence: 2 }]);

      await expect(
        service.claimForApple('user-1', 'otid-1', {
          tier: 'pro',
          status: 'active',
          currentPeriodEnd: new Date('2026-08-23T12:00:00Z'),
          signedDate: new Date('2026-08-23T12:00:00Z'),
          cancelAtPeriodEnd: false,
          observedProvider: null,
          observedOriginalTransactionId: null,
          observedSignedDate: null,
          fenceToken: 1,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
