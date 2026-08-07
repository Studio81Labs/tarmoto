import { DataSource, Repository } from 'typeorm';
import Redis from 'ioredis';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { ProviderClaimService } from '../src/modules/account/provider-claim.service.js';
import {
  SubscriptionMutationLockService,
  type SubscriptionLockLease,
} from '../src/modules/account/subscription-mutation-lock.service.js';
import { subscriptionMutationLockKey } from '../src/modules/account/store-reconciliation.service.js';

/**
 * #1138 — FENCE OWNERSHIP HARNESS (§12 step 4.75).
 *
 * ## Why this suite exists at all
 *
 * The design review of PR #1136 produced TEN successive mechanisms for making
 * subscription-lock ownership safe, and every one of them was refuted by the
 * next round of reading. The conclusion recorded in
 * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md` is that
 * prose review is exhausted on this: the mechanism must be chosen by a harness
 * running against REAL PostgreSQL and REAL Redis, because every disputed claim
 * was about what two concurrent transactions do at commit time. A mocked
 * manager returns whatever the test author expected and proves nothing — the
 * same trap the repo already hit with pessimistic locks plus relations.
 *
 * ## These tests are written to FAIL against the current implementation
 *
 * That is deliberate and is the point of the issue. `mintFenceToken` issues
 * tokens from a GLOBAL sequence (`SELECT nextval(...)`) without touching the
 * rider's row, so `users.subscription_lock_fence` names the last holder that got
 * as far as writing — not the current one. Case (i) below encodes exactly that
 * gap.
 *
 * ## What "the durable handoff" means here, and why it is the crux
 *
 * INV-A says ownership changes at a durable handoff: writes BEFORE it are the
 * prior owner's legitimate tenure and get superseded; writes AFTER it are
 * rejected. A test has to make "after" observable, and the review corrected this
 * definition twice, so it is stated once, explicitly:
 *
 *   **The handoff point is B ACQUIRING THE LOCK.**
 *
 * From the moment `runExclusive` hands B a lease, B is the owner by the only
 * definition the system has — Redis said so. The requirement is therefore that
 * A's guarded write is rejected from that instant. This constrains the OUTCOME
 * and not the means: a mechanism may achieve it by stamping at acquisition, by a
 * generation table, or otherwise. What it may not do is leave a window in which
 * neither flow is durably the owner, because that window is where a lease-lost
 * callback overwrites a live holder's state.
 *
 * The earlier framing — "reject on every interleaving, including before anything
 * durable exists" — was UNSATISFIABLE and is why ten candidates failed in turn.
 * Redis acquisition and a Postgres write cannot be made atomic. Do not restore
 * it.
 *
 * ## Scope
 *
 * Step 4.75 is store-free: `claimForStore` does not exist yet. These are cases
 * (i), (ii-a) and (v). Cases (ii-b), (iii), (iv), (vi-a) and (vi-b) need the
 * store writer and run in step 5, which is not complete until they pass.
 *
 * ## What this harness does NOT cover — stated so it is not mistaken for green
 *
 * The acquire-to-stamp gap. Redis acquisition and the stamping UPDATE are two
 * systems and cannot be made atomic, so a holder that stalls BETWEEN acquiring
 * and stamping — long enough to lose its lease — will stamp a LATER (higher)
 * token than its successor and appear current. Every case below has the stall
 * AFTER the stamp, which is the realistic failure (a heartbeat dying during a
 * slow external call), and is the window that was previously wide open.
 *
 * Closing the remainder means making PostgreSQL the ownership authority instead
 * of Redis, which this design rejects on connection-pool grounds — see the class
 * doc on `SubscriptionMutationLockService`. Recorded rather than silently
 * excluded, because a suite that passes is otherwise read as "no gap".
 *
 * Requires `pnpm db:up && pnpm db:migrate` before
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('subscription fence ownership (#1138, step 4.75)', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let lock: SubscriptionMutationLockService;
  let claim: ProviderClaimService;
  let userRepo: Repository<User>;
  let userId: string;

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    // Same host/port convention as `createSubscriptionLockRedis`.
    redis = new Redis({
      host: process.env.TARMOTO_REDIS_HOST ?? 'localhost',
      port: Number.parseInt(process.env.TARMOTO_REDIS_PORT ?? '6379', 10),
      maxRetriesPerRequest: 3,
      commandTimeout: 5000,
    });
    userRepo = dataSource.getRepository(User);
    claim = new ProviderClaimService(userRepo);
    lock = new SubscriptionMutationLockService(redis, dataSource);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (redis) await redis.quit();
  });

  beforeEach(async () => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const saved = await userRepo.save(
      userRepo.create({
        email: `fence-ownership-${tag}@tarmoto.test`,
        password_hash: 'x',
        display_name: 'FenceOwnership',
      }),
    );
    userId = saved.id;
  });

  afterEach(async () => {
    if (userId) {
      await userRepo.delete(userId);
      await redis.del(subscriptionMutationLockKey(userId));
    }
  });

  /** Reads the columns an ownership conflict must never touch. */
  async function readRiderState() {
    const row = await userRepo.findOne({
      where: { id: userId },
      select: {
        id: true,
        subscription_tier: true,
        subscription_status: true,
        subscription_provider: true,
        stripe_subscription_id: true,
        subscription_lock_fence: true,
      },
    });
    return row;
  }

  /**
   * The three outcomes a guarded claim can produce, kept distinct because
   * conflating the last two is a defect the design explicitly warns about:
   *
   *  - `claimed`        — the write landed.
   *  - `conflict`       — BUSINESS outcome: another provider owns the slot.
   *                       Not retryable; it opens a reconciliation row.
   *  - `retryable-503`  — INFRASTRUCTURE outcome: `assertSubscriptionFenceCurrent`
   *                       saw a newer holder ahead of us, so this flow is stale
   *                       and must re-run. Classifying this as `conflict` would
   *                       file a reconciliation against a perfectly valid
   *                       subscription.
   */
  type ClaimOutcome = 'claimed' | 'conflict' | 'retryable-503';

  async function attemptClaim(
    subscriptionId: string,
    fenceToken: number,
    tier: 'pro' | 'free' = 'pro',
  ): Promise<ClaimOutcome> {
    try {
      return await claim.claimForStripe(
        userId,
        subscriptionId,
        stripeFields(fenceToken, tier),
      );
    } catch (err) {
      const status = (err as { getStatus?: () => number })?.getStatus?.();
      if (status === 503) return 'retryable-503';
      throw err;
    }
  }

  function stripeFields(fenceToken: number, tier: 'pro' | 'free' = 'pro') {
    return {
      tier,
      status: 'active' as const,
      currentPeriodEnd: new Date('2030-01-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      planSource: null,
      fenceToken,
    };
  }

  /**
   * Deterministically strips a holder's Redis lease, standing in for the
   * heartbeat failing mid-section. Deleting the key is used rather than waiting
   * out the TTL because the renew path is token-checked and will not recreate a
   * key that is gone — so the loss is stable rather than timing-dependent.
   */
  async function loseLease(): Promise<void> {
    await redis.del(subscriptionMutationLockKey(userId));
  }

  it('(i) INV-A — a write AFTER the handoff is rejected', async () => {
    // A acquires. Its lease is then lost, B acquires, and only then does A
    // attempt its guarded write. B has done NO writes: the whole question is
    // whether merely being the owner is durable.
    let leaseA!: SubscriptionLockLease;
    let aResult: ClaimOutcome | undefined;

    let releaseA!: () => void;
    const aMayProceed = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aHasLease!: () => void;
    const aAcquired = new Promise<void>((resolve) => {
      aHasLease = resolve;
    });

    const flowA = lock.runExclusive(userId, async (_manager, lease) => {
      leaseA = lease;
      aHasLease();
      await aMayProceed;
      aResult = await attemptClaim('sub_A', leaseA.fenceToken);
    });

    await aAcquired;
    await loseLease();

    // ---- the handoff: B is now the owner ----
    let tokenB!: number;
    await lock.runExclusive(userId, (_manager, leaseB) => {
      // B acquires and does NOTHING else — the whole question is whether merely
      // holding the lock is durable.
      tokenB = leaseB.fenceToken;
      return Promise.resolve();
    });
    expect(tokenB).toBeGreaterThan(leaseA.fenceToken);

    releaseA();
    await flowA.catch(() => undefined);

    // THE ASSERTION, and the whole point of the harness. A lost the lock before
    // B took it, so A's write must not land — and A must be told to RETRY, not
    // handed a business conflict.
    //
    // Today this yields 'claimed'. B acquired but has not written, so nothing
    // raised the stored fence, and `assertSubscriptionFenceCurrent`'s premise —
    // "`fence > token` can only happen if our lease was lost" — cannot fire: a
    // successor that has not written yet has published nothing. The lost lease
    // is undetectable in exactly that window, which is the gap #1138 closes.
    expect(aResult).toBe('retryable-503');

    const after = await readRiderState();
    expect(after?.stripe_subscription_id).toBeNull();
    expect(after?.subscription_tier).toBe('free');
  }, 30_000);

  it('(i) INV-A — a write BEFORE the handoff is permitted, then superseded', async () => {
    // The mirror, and the half an over-strict mechanism breaks. While A is the
    // only owner the database knows about, its write is legitimate. B's later
    // re-query supersedes it. Assert the FINAL state is B's — not that A's write
    // never happened.
    let tokenA!: number;
    await lock.runExclusive(userId, async (_m, lease) => {
      tokenA = lease.fenceToken;
      const r = await claim.claimForStripe(
        userId,
        'sub_A',
        stripeFields(tokenA),
      );
      expect(r).toBe('claimed');
    });

    await lock.runExclusive(userId, async (_m, leaseB) => {
      const r = await claim.claimForStripe(
        userId,
        'sub_A',
        stripeFields(leaseB.fenceToken, 'free'),
      );
      expect(r).toBe('claimed');
    });

    const after = await readRiderState();
    expect(after?.subscription_tier).toBe('free');
  }, 30_000);

  it('(ii-a) INV-B — a same-rider ownership rejection mutates no entitlement state', async () => {
    // Seed the slot as store-owned, then let a Stripe claim hit the exclusivity
    // guard. `claimForStripe` matches `(provider IS NULL OR 'stripe')`, so this
    // is the rejection it can actually produce.
    await userRepo.update(userId, {
      subscription_provider: 'apple',
      subscription_tier: 'pro',
      subscription_status: 'active',
      apple_original_transaction_id: 'otid_seeded',
    });
    const before = await readRiderState();

    await lock.runExclusive(userId, async (_m, lease) => {
      const r = await claim.claimForStripe(
        userId,
        'sub_intruder',
        stripeFields(lease.fenceToken),
      );
      expect(r).toBe('conflict');
    });

    const after = await readRiderState();
    // Entitlement and identity only. NOT the fence: a mechanism may legitimately
    // advance it on acquisition, and asserting a whole unmutated row is how this
    // requirement became self-contradictory during review.
    expect(after?.subscription_tier).toBe(before?.subscription_tier);
    expect(after?.subscription_status).toBe(before?.subscription_status);
    expect(after?.subscription_provider).toBe(before?.subscription_provider);
    expect(after?.stripe_subscription_id).toBeNull();
  }, 30_000);

  it('a live flow that calls publishFence() still succeeds after acquisition-stamping', async () => {
    // REGRESSION GUARD for the P1 this PR introduced and review caught.
    //
    // Acquisition now stamps the fence, so by the time a callback runs the row
    // already carries THIS holder's token. `publishFence`'s guard was
    // `subscription_lock_fence < :token` — strictly less — which then matched
    // zero rows for the legitimate holder and raised a retryable 503 on EVERY
    // invocation, breaking both live callers (`account.service.ts:660`, the
    // Stripe handler, and `subscription-notification.service.ts:127`).
    //
    // Neither the unit suite nor the other cases here caught it: the unit mock
    // reports a fixed `affectedCount` and so cannot model the guard, and no
    // other case in this file calls `publishFence`. Exercising the real method
    // against a real row is the only thing that shows it.
    await expect(
      lock.runExclusive(userId, (_m, lease) => lease.publishFence()),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('publishFence() still detects a NEWER holder and fails closed', async () => {
    // The half that must survive the `<` → `<=` relaxation: publishing is still
    // rejected when someone newer has stamped strictly higher.
    let leaseA!: SubscriptionLockLease;

    let releaseA!: () => void;
    const aMayProceed = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aHasLease!: () => void;
    const aAcquired = new Promise<void>((resolve) => {
      aHasLease = resolve;
    });

    let publishError: unknown;
    const flowA = lock.runExclusive(userId, async (_m, lease) => {
      leaseA = lease;
      aHasLease();
      await aMayProceed;
      try {
        await leaseA.publishFence();
      } catch (err) {
        publishError = err;
      }
    });

    await aAcquired;
    await loseLease();
    await lock.runExclusive(userId, (_m, _leaseB) => Promise.resolve());

    releaseA();
    await flowA.catch(() => undefined);

    expect((publishError as { getStatus?: () => number })?.getStatus?.()).toBe(
      503,
    );
  }, 30_000);

  it('(v) INV-C — two claim transactions for one rider, one lease lost: exactly one commits', async () => {
    // The half that ALREADY WORKS, kept as a regression guard and to pin the
    // 503-vs-conflict distinction. Here B both acquires AND writes, so the
    // stored fence rises above A's token and `assertSubscriptionFenceCurrent`
    // can see that A is stale.
    //
    // Contrast with case (i): the difference between the two is only whether B
    // has written yet, which is precisely the window the current mechanism
    // cannot cover.
    let leaseA!: SubscriptionLockLease;
    let aResult: ClaimOutcome | undefined;
    let bResult: ClaimOutcome | undefined;

    let releaseA!: () => void;
    const aMayProceed = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aHasLease!: () => void;
    const aAcquired = new Promise<void>((resolve) => {
      aHasLease = resolve;
    });

    const flowA = lock.runExclusive(userId, async (_m, lease) => {
      leaseA = lease;
      aHasLease();
      await aMayProceed;
      aResult = await attemptClaim('sub_A', leaseA.fenceToken, 'pro');
    });

    await aAcquired;
    await loseLease();

    await lock.runExclusive(userId, async (_m, leaseB) => {
      bResult = await attemptClaim('sub_B', leaseB.fenceToken, 'free');
    });

    releaseA();
    await flowA.catch(() => undefined);

    expect(bResult).toBe('claimed');
    // NOT 'conflict'. A is stale infrastructure-wise, not losing a business
    // exclusivity contest — misclassifying it would file a reconciliation row
    // against B's perfectly valid subscription.
    expect(aResult).toBe('retryable-503');

    const after = await readRiderState();
    expect(after?.stripe_subscription_id).toBe('sub_B');
    expect(after?.subscription_tier).toBe('free');
  }, 30_000);
});
