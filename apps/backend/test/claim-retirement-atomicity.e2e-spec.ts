import { DataSource, type EntityManager } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { StoreBillingReconciliation } from '../src/entities/store-billing-reconciliation.entity.js';
import { ProviderClaimService } from '../src/modules/account/provider-claim.service.js';
import { StoreReconciliationService } from '../src/modules/account/store-reconciliation.service.js';

/**
 * Claim + retirement are ONE transaction — proven against real PostgreSQL.
 *
 * ## Why the unit test is not enough
 *
 * `account.service.spec.ts` asserts that both calls happen inside the
 * `manager.transaction` callback, but its transaction mock invokes the callback
 * inline and `claimForStripe` is itself mocked. That combination still passes if
 * the two writes use DIFFERENT managers, or if a failed retirement leaves the
 * claim committed — which is precisely the guarantee this change introduces.
 * Only a real database can refute it.
 *
 * ## What this pins that nothing else does
 *
 * 1. **Both services honour the caller's manager.** If either ignored it and
 *    reached for the pool repository, its write would commit independently and
 *    the rollback case below would find a claimed row.
 * 2. **A retirement failure rolls the claim back.** The rider must not be left
 *    owning a subscription whose conflict row was never closed, nor the reverse.
 *
 * ## What this deliberately does NOT cover
 *
 * It reconstructs the orchestration rather than driving `AccountService`, so it
 * cannot see WHICH manager the production call site chooses: these cases would
 * still pass if that call site handed the pool manager to either collaborator.
 * That half is asserted by object IDENTITY in
 * `account.service.spec.ts` → "hands the SAME transaction manager to the claim
 * and the retirement", which fails if either argument is swapped for the pool
 * manager. The two specs are complementary and neither is sufficient alone:
 *
 *  - here: the services honour whatever manager they are given (real rollback)
 *  - there: the call site gives both of them the transaction's manager
 *
 * Driving the full webhook through `AccountService` would cover both at once but
 * needs the entire dependency graph (Stripe client, Redis lock, entitlements,
 * email, push, queues) stood up against live infrastructure — a fixture far
 * larger than the guarantee, and one that would fail for many reasons unrelated
 * to atomicity.
 *
 * ## Why the failure is forced with a bad resolution value
 *
 * Not an injected throw — a `sbr_resolution_check` violation, which is the exact
 * hazard migration 1834's header warns about: emitting `superseded_by_claim`
 * before the constraint accepts it raises a CHECK violation that rolls back the
 * **successful claim**, turning a schema oversight into a rider losing
 * entitlement they paid for. This test reproduces that coupling deliberately, so
 * the blast radius of getting the ordering wrong is demonstrated rather than
 * described.
 */
describe('claim + retirement atomicity (#1138)', () => {
  let dataSource: DataSource;
  let providerClaim: ProviderClaimService;
  let storeReconciliation: StoreReconciliationService;
  let userId: string;
  let conflictRowId: string;

  const SUB_ID = 'sub_atomicity_test';

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    providerClaim = new ProviderClaimService(dataSource.getRepository(User));
    storeReconciliation = new StoreReconciliationService(
      dataSource.getRepository(StoreBillingReconciliation),
    );
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    const repo = dataSource.getRepository(User);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await repo.save(
      repo.create({
        email: `claim-atomicity-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'AtomicityTest',
      }),
    );
    userId = saved.id;

    // The open conflict the winning claim supersedes.
    const row = await storeReconciliation.openConflict({
      userId,
      provider: 'stripe',
      stripeSubscriptionId: SUB_ID,
      reason: 'exclusivity_conflict',
    });
    conflictRowId = row.id;
  });

  afterEach(async () => {
    // Reconciliation rows cascade with the rider.
    if (userId) await dataSource.getRepository(User).delete(userId);
  });

  /** The production shape: claim, then retire, both on the transaction's manager. */
  async function claimAndRetire(resolution: string): Promise<void> {
    await dataSource.manager.transaction(async (tx: EntityManager) => {
      const result = await providerClaim.claimForStripe(
        userId,
        SUB_ID,
        {
          tier: 'pro',
          status: 'active',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          planSource: 'subscription',
          fenceToken: 1,
        },
        { manager: tx },
      );
      expect(result).toBe('claimed');
      await storeReconciliation.resolveWith(
        tx,
        conflictRowId,
        resolution as NonNullable<StoreBillingReconciliation['resolution']>,
      );
    });
  }

  async function readState(): Promise<{
    ownedSubscription: string | null;
    conflictStatus: string;
    conflictResolution: string | null;
  }> {
    const user = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: userId } });
    const row = await dataSource
      .getRepository(StoreBillingReconciliation)
      .findOneOrFail({ where: { id: conflictRowId } });
    return {
      ownedSubscription: user.stripe_subscription_id,
      conflictStatus: row.status,
      conflictResolution: row.resolution,
    };
  }

  it('commits the claim AND the retirement together', async () => {
    await claimAndRetire('superseded_by_claim');

    expect(await readState()).toEqual({
      ownedSubscription: SUB_ID,
      conflictStatus: 'resolved',
      conflictResolution: 'superseded_by_claim',
    });
  }, 30_000);

  it('rolls the CLAIM back when the retirement fails', async () => {
    // A rider left owning a subscription whose conflict row stayed open is the
    // half-applied state the transaction exists to prevent.
    await expect(claimAndRetire('not_a_real_value')).rejects.toThrow(
      /sbr_resolution_check/i,
    );

    expect(await readState()).toEqual({
      ownedSubscription: null,
      conflictStatus: 'open',
      conflictResolution: null,
    });
  }, 30_000);

  it('rolls the RETIREMENT back when something later in the transaction fails', async () => {
    // The mirror of the case above, and it catches a different defect: here BOTH
    // writes succeed and the transaction fails afterwards. If `resolveWith`
    // reached for the pool repository instead of the caller's manager, its
    // update would already be committed and would survive this rollback — the
    // conflict row would read `resolved` with nothing to show for it. The
    // failing-retirement test cannot see that, because there the retirement
    // never succeeds in the first place.
    await expect(
      dataSource.manager.transaction(async (tx: EntityManager) => {
        await providerClaim.claimForStripe(
          userId,
          SUB_ID,
          {
            tier: 'pro',
            status: 'active',
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            planSource: 'subscription',
            fenceToken: 1,
          },
          { manager: tx },
        );
        await storeReconciliation.resolveWith(
          tx,
          conflictRowId,
          'superseded_by_claim',
        );
        throw new Error('forced failure after both writes');
      }),
    ).rejects.toThrow('forced failure after both writes');

    expect(await readState()).toEqual({
      ownedSubscription: null,
      conflictStatus: 'open',
      conflictResolution: null,
    });
  }, 30_000);

  it('leaves the slot claimable after the rollback', async () => {
    // The rollback must not poison the row: a later, correct claim still wins.
    // Without this, a rolled-back attempt could look identical to a successful
    // one from the next writer's perspective.
    await expect(claimAndRetire('not_a_real_value')).rejects.toThrow();
    await claimAndRetire('superseded_by_claim');

    expect(await readState()).toEqual({
      ownedSubscription: SUB_ID,
      conflictStatus: 'resolved',
      conflictResolution: 'superseded_by_claim',
    });
  }, 30_000);
});
