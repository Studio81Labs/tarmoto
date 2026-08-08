import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { ProviderClaimService } from '../src/modules/account/provider-claim.service.js';

/**
 * Stripe lifecycle transitions, asserted on the REAL writer and the PERSISTED
 * row — renewal and mid-period cancellation.
 *
 * ## Why the unit tests cannot prove these
 *
 * On an ALREADY-ACTIVE rider the activation transition guards on
 * `subscription_status NOT IN ('active','trialing')`, so it matches zero rows and
 * `claimForStripe` is the only SUCCESSFUL writer for both transitions. In
 * `account.service.spec.ts` that service is mocked, so those tests can only
 * inspect the argument handed to it. Any regression INSIDE `claimForStripe`
 * leaves them green:
 *
 *  - an unconditional `billing_trial_used_at` stamp — the renewal cases
 *  - dropping the tier when `cancelAtPeriodEnd` is true — the cancellation cases
 *
 * The second is the one that matters most and is easiest to introduce, because a
 * cancellation reads like an ending. It is not: the rider has paid through the
 * period and keeps the tier until it expires.
 *
 * ## Why the trial marker matters
 *
 * `billing_trial_used_at` is once-per-rider. Re-stamping it on every renewal
 * would walk the date forward indefinitely, so any eligibility window keyed off
 * it never closes and a paying rider could be granted a second free trial. The
 * date is also the only record of WHEN the one trial was consumed.
 */
describe('Stripe lifecycle, persisted (#1141)', () => {
  let dataSource: DataSource;
  let providerClaim: ProviderClaimService;
  let userId: string;

  const SUB_ID = 'sub_renewal_trial_marker';
  const FIRST_PERIOD = new Date('2026-09-01T00:00:00Z');
  const NEXT_PERIOD = new Date('2026-10-01T00:00:00Z');
  const TRIAL_USED_AT = new Date('2026-06-15T09:30:00Z');

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    providerClaim = new ProviderClaimService(dataSource.getRepository(User));
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  afterEach(async () => {
    if (userId) await dataSource.getRepository(User).delete(userId);
  });

  async function seedActivePaidRider(
    trialUsedAt: Date | null,
  ): Promise<string> {
    const repo = dataSource.getRepository(User);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await repo.save(
      repo.create({
        email: `renewal-trial-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'RenewalTest',
        subscription_provider: 'stripe',
        stripe_subscription_id: SUB_ID,
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_current_period_end: FIRST_PERIOD,
        plan_source: 'subscription',
        billing_trial_used_at: trialUsedAt,
      }),
    );
    return saved.id;
  }

  /**
   * The claim exactly as `applyStripeSubscriptionEvent` builds it for an
   * already-active rider: same subscription, still `active`, tier from the
   * price. Only the period and the cancel flag vary between transitions.
   */
  async function claim(over: {
    periodEnd: Date;
    cancelAtPeriodEnd: boolean;
  }): Promise<'claimed' | 'conflict'> {
    return providerClaim.claimForStripe(userId, SUB_ID, {
      tier: 'pro',
      status: 'active',
      currentPeriodEnd: over.periodEnd,
      cancelAtPeriodEnd: over.cancelAtPeriodEnd,
      planSource: 'subscription',
      fenceToken: 1,
    });
  }

  const renew = () =>
    claim({ periodEnd: NEXT_PERIOD, cancelAtPeriodEnd: false });

  async function readRider(): Promise<User> {
    return (
      dataSource
        .getRepository(User)
        .createQueryBuilder('u')
        // `billing_trial_used_at` is not `select: false`, but go through the
        // builder so the assertion reads the stored column rather than anything
        // an entity default could supply.
        .where('u.id = :id', { id: userId })
        .getOneOrFail()
    );
  }

  describe('cancellation mid-period', () => {
    it('keeps the paid tier, sets the flag, and leaves the period untouched', async () => {
      // The regression this exists for: Stripe keeps the subscription `active`
      // and flips `cancel_at_period_end`. Dropping the tier here revokes access
      // a rider has already paid for — cancel on day 2 of a paid month, lose it
      // on day 2. A cancellation reads like an ending, which is exactly why this
      // is easy to get wrong inside the claim writer where no mock can see it.
      userId = await seedActivePaidRider(null);

      expect(
        await claim({ periodEnd: FIRST_PERIOD, cancelAtPeriodEnd: true }),
      ).toBe('claimed');

      const row = await readRider();
      expect(row.subscription_tier).toBe('pro');
      expect(row.subscription_status).toBe('active');
      expect(row.subscription_cancel_at_period_end).toBe(true);
      expect(row.subscription_current_period_end).toEqual(FIRST_PERIOD);
    }, 30_000);

    it('un-cancelling clears the flag and keeps the tier', async () => {
      userId = await seedActivePaidRider(null);
      await claim({ periodEnd: FIRST_PERIOD, cancelAtPeriodEnd: true });

      expect(
        await claim({ periodEnd: FIRST_PERIOD, cancelAtPeriodEnd: false }),
      ).toBe('claimed');

      const row = await readRider();
      expect(row.subscription_cancel_at_period_end).toBe(false);
      expect(row.subscription_tier).toBe('pro');
    }, 30_000);
  });

  it('leaves an UNSET trial marker unset while advancing the period', async () => {
    userId = await seedActivePaidRider(null);

    expect(await renew()).toBe('claimed');

    const row = await readRider();
    expect(row.billing_trial_used_at).toBeNull();
    expect(row.subscription_current_period_end).toEqual(NEXT_PERIOD);
    expect(row.subscription_tier).toBe('pro');
  }, 30_000);

  it('does NOT move an already-stamped trial marker forward', async () => {
    // The more damaging direction: walking the date forward on every renewal
    // keeps any window keyed off it permanently open, and destroys the record of
    // when the single trial was actually consumed.
    userId = await seedActivePaidRider(TRIAL_USED_AT);

    expect(await renew()).toBe('claimed');

    const row = await readRider();
    expect(row.billing_trial_used_at).toEqual(TRIAL_USED_AT);
    expect(row.subscription_current_period_end).toEqual(NEXT_PERIOD);
  }, 30_000);
});
