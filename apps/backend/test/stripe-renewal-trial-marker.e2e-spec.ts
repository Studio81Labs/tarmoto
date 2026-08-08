import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { ProviderClaimService } from '../src/modules/account/provider-claim.service.js';

/**
 * A renewal must not re-stamp `billing_trial_used_at` — proven on the REAL
 * writer and the persisted row.
 *
 * ## Why the unit test cannot prove this
 *
 * On an already-active rider the activation transition matches zero rows, so
 * `claimForStripe` is the only successful writer on the renewal path — and in
 * `account.service.spec.ts` it is mocked. A "no trial marker in any write"
 * assertion there is satisfied by the zero-row transition's payload and never
 * inspects a renewal write at all: if `claimForStripe` gained an unconditional
 * trial stamp, that test would stay green.
 *
 * So this drives the real `ProviderClaimService` against real PostgreSQL and
 * reads the row back.
 *
 * ## Why the marker matters
 *
 * `billing_trial_used_at` is once-per-rider. Re-stamping it on every renewal
 * would walk the date forward indefinitely, so any eligibility window keyed off
 * it never closes and a paying rider could be granted a second free trial. The
 * date is also the only record of WHEN the one trial was consumed.
 */
describe('renewal does not re-stamp the trial marker (#1141)', () => {
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

  /** The renewal claim: same subscription, later period, still active. */
  async function renew(): Promise<'claimed' | 'conflict'> {
    return providerClaim.claimForStripe(userId, SUB_ID, {
      tier: 'pro',
      status: 'active',
      currentPeriodEnd: NEXT_PERIOD,
      cancelAtPeriodEnd: false,
      planSource: 'subscription',
      fenceToken: 1,
    });
  }

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
