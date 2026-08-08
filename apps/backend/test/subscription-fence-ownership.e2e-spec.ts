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
 * ## The gap this does NOT close — encoded as `it.failing`, not just described
 *
 * The acquire-to-stamp window. A holder that stalls BETWEEN acquiring and
 * stamping, past its lease TTL, stamps a LATER (higher) token than its successor
 * — because the token comes from `nextval` at STAMP time rather than at
 * ACQUISITION time. It is worse than that holder merely looking current: its
 * stamp **fences out the live holder**, whose legitimate guarded writes then fail
 * as stale, possibly after it has already committed a state transition.
 *
 * The last test in this file reproduces exactly that and is marked
 * `it.failing`, so CI stays green while the gap is open AND the suite breaks the
 * moment someone closes it — which forces the marker to be flipped rather than
 * the gap being quietly forgotten.
 *
 * Every other case here stalls AFTER the stamp, which is the realistic failure
 * (a heartbeat dying during a slow external call) and the window that was
 * previously wide open.
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
   * Deterministically strips a holder's lease — BOTH halves — standing in for the
   * heartbeat failing mid-section.
   *
   * Both, because since #1138 the lease IS both halves and one heartbeat renews
   * them together: a dead holder loses them together too. Expiring only Redis
   * models a Redis-specific fault (an evicted key, a failover that lost data)
   * while the holder is alive and still owns the DB lease — a different scenario
   * with a different correct answer, covered separately by
   * `a Redis-only blip does NOT hand ownership to a newcomer`.
   *
   * The Redis key is deleted rather than waited out because the renew path is
   * token-checked and will not recreate a key that is gone. The DB lease is
   * expired in place rather than cleared, because a holder that died does not
   * tidy up after itself — the takeover predicate is what has to cope.
   */
  async function loseLease(): Promise<void> {
    await redis.del(subscriptionMutationLockKey(userId));
    await dataSource.query(
      `UPDATE users SET subscription_lock_lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [userId],
    );
  }

  /**
   * The lease expiry in epoch MILLISECONDS. Not `String(date)`, which renders at
   * second resolution and silently hid a real difference: a foreign renewal sets
   * `now() + TTL`, only milliseconds from the incumbent's own `now() + TTL`, so
   * the stringified forms matched and the assertion could not fail.
   */
  async function readLeaseExpiryMs(): Promise<number> {
    const rows: unknown = await dataSource.query(
      `SELECT subscription_lock_lease_expires_at AS e FROM users WHERE id = $1`,
      [userId],
    );
    const row = (rows as Array<{ e: Date | null }>)[0];
    return row?.e ? new Date(row.e).getTime() : Number.NaN;
  }

  /** The lease's current owner token, so a test can renew AS the holder. */
  async function readLeaseOwner(): Promise<string> {
    const rows: unknown = await dataSource.query(
      `SELECT subscription_lock_owner AS o FROM users WHERE id = $1`,
      [userId],
    );
    return String((rows as Array<{ o: string | null }>)[0]?.o);
  }

  /** The rider's stored fence, for asserting a stale flow wrote nothing. */
  async function readFence(): Promise<number> {
    const row = await userRepo.findOne({
      where: { id: userId },
      select: { id: true, subscription_lock_fence: true },
    });
    return Number(row?.subscription_lock_fence);
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

  it('a live flow that calls assertFenceCurrent() still succeeds after acquisition-stamping', async () => {
    // REGRESSION GUARD for the P1 this PR introduced and review caught.
    //
    // Acquisition now stamps the fence, so by the time a callback runs the row
    // already carries THIS holder's token. `assertFenceCurrent`'s guard was
    // `subscription_lock_fence < :token` — strictly less — which then matched
    // zero rows for the legitimate holder and raised a retryable 503 on EVERY
    // invocation, breaking both live callers (`account.service.ts:660`, the
    // Stripe handler, and `subscription-notification.service.ts:127`).
    //
    // Neither the unit suite nor the other cases here caught it: the unit mock
    // reports a fixed `affectedCount` and so cannot model the guard, and no
    // other case in this file calls `assertFenceCurrent`. Exercising the real method
    // against a real row is the only thing that shows it.
    await expect(
      lock.runExclusive(userId, (_m, lease) => lease.assertFenceCurrent()),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('assertFenceCurrent() still detects a NEWER holder and fails closed', async () => {
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
        await leaseA.assertFenceCurrent();
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

  /**
   * THE KNOWN RESIDUAL HOLE, encoded rather than described.
   *
   * `it.failing` asserts this currently FAILS. CI stays green while the gap is
   * open, and the moment someone closes it this test starts passing and Jest
   * fails the suite — forcing whoever fixed it to flip the marker instead of the
   * gap quietly disappearing from anyone's memory.
   *
   * The scenario: A acquires, then stalls BEFORE stamping for longer than the
   * lease TTL. B acquires and stamps. A resumes and stamps — and because the
   * token comes from `nextval` at STAMP time rather than at ACQUISITION time, A's
   * token is HIGHER. A is aborted by its own `assertHeld`, but the stamp is
   * already committed, so B — the actual holder — is now fenced out and its
   * legitimate guarded writes fail as stale. Worse than "A appears current": A
   * actively breaks B, possibly after B has committed a state transition.
   *
   * Why it is not fixed in this PR: closing it requires the token to be issued
   * BY the acquisition, not after it — e.g. a Redis `INCR` performed atomically
   * with `SET NX PX` in one Lua script, with the DB stamp then guarded
   * (`WHERE fence < :token`) so a late-resuming stale acquirer simply loses. That
   * makes correctness depend on Redis counter durability (a flushed Redis would
   * issue tokens below stored fences and reject every write until reseeded from
   * the row), which is a real trade-off and a separate decision — not something
   * to bolt on at the end of the PR that already introduced two regressions in
   * this mechanism.
   */
  it('RESIDUAL GAP CLOSED: a stale acquirer resuming before its stamp does not fence out the live holder', async () => {
    // The gap step 4.75 left open, and the reason the DB lease exists.
    //
    // A acquires the Redis lock and stalls BEFORE reaching the database — pool
    // starvation is enough. Its TTL lapses, B acquires and stamps, and then A
    // resumes. Because the token came from `nextval` at STAMP time, A's was
    // allocated LATER and is therefore HIGHER: A's stamp fenced out the LIVE
    // holder, whose guarded writes then matched zero rows.
    //
    // This drove A's resume with a RAW `UPDATE ... nextval` while the gap was
    // open, because a stall before minting could not be forced from outside the
    // service. It can now: the lease is what A must take before it can stamp,
    // so "A resumes" is simply another flow reaching acquisition while B holds
    // the lease. Going through the real path also means the test exercises the
    // guard rather than a hand-written imitation of it.
    let leaseB!: SubscriptionLockLease;
    let staleError: unknown;

    await lock.runExclusive(userId, async (_m, lease) => {
      leaseB = lease;
      const fenceWhileBHolds = await readFence();

      // The Redis blip that lets the stalled acquirer back through the gate. B
      // is alive and still holds the DB lease.
      await redis.del(subscriptionMutationLockKey(userId));

      staleError = await lock
        .runExclusive(userId, () => Promise.resolve('stale flow ran'))
        .catch((err: unknown) => err);

      // Refused, retryably — and, crucially, having written NOTHING.
      expect((staleError as { getStatus?: () => number })?.getStatus?.()).toBe(
        503,
      );
      expect(await readFence()).toBe(fenceWhileBHolds);

      // The live holder's legitimate write still lands. This is the assertion
      // that used to fail.
      expect(await attemptClaim('sub_B', leaseB.fenceToken)).toBe('claimed');
    });

    const after = await readRiderState();
    expect(after?.stripe_subscription_id).toBe('sub_B');
  }, 30_000);

  it("a REFUSED acquirer does not release the live holder's lease on its way out", async () => {
    // The cleanup path is as dangerous as the acquisition path. A refused flow
    // still runs its `finally`, and an unguarded release there would clear the
    // lease of the holder that just refused it — handing the rider to whoever
    // asks next and fencing out an incumbent that is still working. The refusal
    // would look correct in isolation while the damage happened on the way out.
    //
    // Proven by consequence, not by reading the row: after a refused flow has
    // fully unwound, a SECOND newcomer must still be refused. If the first one
    // freed the lease, the second one takes it.
    await lock.runExclusive(userId, async (_m, lease) => {
      await redis.del(subscriptionMutationLockKey(userId));

      const first = await lock
        .runExclusive(userId, () => Promise.resolve('first'))
        .catch((err: unknown) => err);
      expect((first as { getStatus?: () => number })?.getStatus?.()).toBe(503);

      // The first newcomer released its own Redis key on the way out, so this
      // one gets through the gate too — and must be stopped by the DB lease.
      await redis.del(subscriptionMutationLockKey(userId));
      const second = await lock
        .runExclusive(userId, () => Promise.resolve('second'))
        .catch((err: unknown) => err);
      expect((second as { getStatus?: () => number })?.getStatus?.()).toBe(503);

      expect(await attemptClaim('sub_incumbent2', lease.fenceToken)).toBe(
        'claimed',
      );
    });
  }, 30_000);

  it('a zombie heartbeat cannot extend a lease it no longer owns', async () => {
    // The heartbeat outlives the ownership it was started for: a flow stuck in a
    // long call keeps renewing every 15s even after its lease has been taken
    // over. Unguarded, those renewals land on whoever holds the lease NOW and
    // keep extending it — so if that holder dies without releasing, the zombie
    // renews a dead lease indefinitely and the rider is never unlockable.
    //
    // Reached through the private method deliberately: the interval is 15s and
    // the harm is a repeated write, so driving the real timer would need a
    // minutes-long test to observe what one direct call shows exactly.
    const service = lock as unknown as {
      renewLease(userId: string, owner: string): Promise<void>;
    };

    await lock.runExclusive(userId, async () => {
      // Park the expiry somewhere a renewal could never produce. Comparing two
      // `now() + TTL` values instead would differ by only milliseconds — near
      // enough to be flaky, and invisible entirely at second resolution. Nine
      // hours out is unambiguous: if a foreign renewal lands, it drops to ~60s.
      await dataSource.query(
        `UPDATE users
            SET subscription_lock_lease_expires_at = now() + interval '9 hours'
          WHERE id = $1`,
        [userId],
      );
      const parked = await readLeaseExpiryMs();

      // A different flow's heartbeat fires while B holds the lease.
      await service.renewLease(userId, 'some-other-flows-token');

      expect(await readLeaseExpiryMs()).toBe(parked);

      // And the owner's OWN renewal still works — the guard rejects strangers,
      // not the heartbeat it exists to serve. Without this the test would also
      // pass against a `renewLease` that did nothing at all.
      const owner = await readLeaseOwner();
      await service.renewLease(userId, owner);
      expect(await readLeaseExpiryMs()).toBeLessThan(parked);
    });
  }, 30_000);

  it('an unrelated whole-entity save cannot clobber the lock columns', async () => {
    // Codex P1. `save()` diffs a loaded entity against a fresh reload and writes
    // back every differing column, so any request that loads a `User` and saves
    // it later — `updateProfile`, `uploadAvatar` — can persist lock state from a
    // stale snapshot. Two ways that goes wrong, both silent:
    //
    //   loaded DURING a lease, saved AFTER release  → resurrects a dead owner and
    //     expiry, so subscription mutations are rejected until it lapses;
    //   loaded BEFORE acquisition, saved DURING one → clears the lease and
    //     reopens the handoff race this whole change exists to close;
    //
    // and for the FENCE, a stale write moves the high-water mark BACKWARDS, which
    // lets a stale flow's `fence <= :token` guard pass.
    //
    // The guard is `select: false` on all three columns: they load as `undefined`
    // and `save()` skips undefined properties. This test is what keeps that from
    // being quietly removed.

    // Snapshot the rider the way an unrelated request would — a plain load, no
    // explicit select.
    const stale = await userRepo.findOneOrFail({ where: { id: userId } });
    expect(stale.subscription_lock_owner).toBeUndefined();
    expect(stale.subscription_lock_fence).toBeUndefined();

    let duringLease!: { owner: string; expiryMs: number; fence: number };
    await lock.runExclusive(userId, async () => {
      duringLease = {
        owner: await readLeaseOwner(),
        expiryMs: await readLeaseExpiryMs(),
        fence: await readFence(),
      };

      // The unrelated request completes mid-lease and saves its stale snapshot.
      stale.display_name = 'Renamed Mid-Lease';
      await userRepo.save(stale);

      // Nothing about the lease moved.
      expect(await readLeaseOwner()).toBe(duringLease.owner);
      expect(await readLeaseExpiryMs()).toBe(duringLease.expiryMs);
      expect(await readFence()).toBe(duringLease.fence);
    });

    // The unrelated write itself still landed — `select: false` protects the lock
    // columns, it does not break ordinary profile saves.
    const after = await userRepo.findOneOrFail({ where: { id: userId } });
    expect(after.display_name).toBe('Renamed Mid-Lease');
  }, 30_000);

  it('a Redis-only blip does NOT hand ownership to a newcomer', async () => {
    // Distinct from a lost lease, and the distinction is the point. An evicted
    // key or a failover that lost data is a REDIS fault; the holder is alive and
    // still owns the DB lease, so ownership must not move. Before the DB lease
    // the newcomer simply took over and fenced out a live, working holder.
    //
    // A retryable 503 for the newcomer is the correct answer: it re-runs once the
    // holder finishes or its lease genuinely lapses.
    let newcomer: unknown;

    await lock.runExclusive(userId, async (_m, lease) => {
      await redis.del(subscriptionMutationLockKey(userId));

      newcomer = await lock
        .runExclusive(userId, () => Promise.resolve('took over'))
        .catch((err: unknown) => err);

      expect((newcomer as { getStatus?: () => number })?.getStatus?.()).toBe(
        503,
      );
      // The incumbent is unaffected and finishes normally.
      expect(await attemptClaim('sub_incumbent', lease.fenceToken)).toBe(
        'claimed',
      );
    });
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
