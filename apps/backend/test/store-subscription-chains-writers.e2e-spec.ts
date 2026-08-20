import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';
import { StoreSubscription } from '../src/entities/store-subscription.entity.js';
import { StoreBillingReconciliation } from '../src/entities/store-billing-reconciliation.entity.js';
import {
  StoreChainWriterService,
  type StoreChainStateInput,
} from '../src/modules/account/store-chain-writer.service.js';
import type { SubscriptionMutationLockService } from '../src/modules/account/subscription-mutation-lock.service.js';
import {
  liveStoreTier,
  resolveEntitledTier,
} from '../src/modules/account/entitlement.js';

/**
 * Release A items (2) and (4) of #1191 against REAL PostgreSQL — the chain
 * writers, the rollup they maintain, the provisional-overlap machinery, and
 * the two sweeps.
 *
 * Real-Postgres on purpose, like the schema suite beside it: the writers'
 * correctness rests on CHECK constraints, partial unique indexes and
 * `ON CONFLICT` inference that a mocked repository never evaluates — and the
 * `firstReturnedRow` incident (#1142) is this repo's standing proof that a
 * mocked driver shape ships bugs green.
 *
 * ## Running it
 *
 *   pnpm db:up && pnpm db:migrate && pnpm --filter @tarmoto/backend test:e2e -- store-subscription-chains
 *
 * In CI the `backend: schema from zero (real postgres)` job migrates an EMPTY
 * database and runs every `store-subscription-chains*` suite, this one
 * included.
 */
describe('store subscription chains — writers, rollup and overlaps (#1191)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let writer: StoreChainWriterService;
  let userId: string;
  let otherUserId: string;

  const DAY = 24 * 3600_000;
  const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  /** A strictly-increasing fence, minted from the production sequence. */
  const mintFence = async (): Promise<number> => {
    const rows: Array<{ token: string }> = await dataSource.query(
      `SELECT nextval('subscription_lock_fence_seq') AS token`,
    );
    return Number(rows[0]?.token);
  };

  const claimInput = async (
    over: Partial<StoreChainStateInput> = {},
  ): Promise<StoreChainStateInput> => ({
    userId,
    provider: 'google',
    originalTransactionId: `GPA.${tag()}`,
    productId: 'tarmoto_pro_monthly',
    originalPurchaseDate: null,
    tier: 'pro',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    cancelAtPeriodEnd: false,
    observedAt: new Date(),
    fenceToken: await mintFence(),
    ...over,
  });

  const readRollup = async (
    id: string,
  ): Promise<{ tier: string | null; expiresAt: Date | null }> => {
    // The pair is `select: false`, so it is NAMED explicitly — the same rule
    // every production reader follows.
    const rows: Array<{
      store_subscription_tier: string | null;
      store_subscription_tier_expires_at: Date | null;
    }> = await dataSource.query(
      `SELECT store_subscription_tier, store_subscription_tier_expires_at
         FROM users WHERE id = $1`,
      [id],
    );
    return {
      tier: rows[0]?.store_subscription_tier ?? null,
      expiresAt: rows[0]?.store_subscription_tier_expires_at ?? null,
    };
  };

  const readStripeColumns = async (
    id: string,
  ): Promise<Record<string, unknown>> => {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT subscription_provider, stripe_subscription_id, subscription_tier,
              subscription_status, subscription_current_period_end,
              subscription_cancel_at_period_end, plan_source
         FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ?? {};
  };

  const listOverlaps = async (
    id: string,
  ): Promise<StoreBillingReconciliation[]> =>
    dataSource.getRepository(StoreBillingReconciliation).find({
      where: { user_id: id },
      order: { created_at: 'ASC' },
    });

  /** Persist a Stripe side directly, as the hardened Stripe writers would. */
  const givenStripeSide = async (
    over: Partial<{
      status: string;
      tier: string;
      subId: string | null;
      periodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
    }> = {},
  ): Promise<void> => {
    await dataSource.query(
      `UPDATE users SET
         subscription_provider = 'stripe',
         stripe_subscription_id = $2,
         subscription_tier = $3,
         subscription_status = $4,
         subscription_current_period_end = $5,
         subscription_cancel_at_period_end = $6,
         plan_source = 'subscription'
       WHERE id = $1`,
      [
        userId,
        over.subId === undefined ? `sub_${tag()}` : over.subId,
        over.tier ?? 'premium',
        over.status ?? 'active',
        over.periodEnd === undefined
          ? new Date(Date.now() + 20 * DAY)
          : over.periodEnd,
        over.cancelAtPeriodEnd ?? false,
      ],
    );
  };

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
    // Constructed directly rather than through Nest DI: the service's work is
    // SQL, and this suite exists to run that SQL against real Postgres. The
    // config supplies the documented defaults; the lock service is needed only
    // by the recompute worker, which mints its fence the same way this suite
    // does.
    const config = {
      get: <T>(_key: string, def: T): T => def,
    } as unknown as ConfigService;
    const fakeLock = {
      runExclusive: async <T>(
        lockedUserId: string,
        fn: (
          manager: unknown,
          lease: { fenceToken: number; assertHeld: () => Promise<void> },
        ) => Promise<T>,
      ): Promise<T> =>
        fn(dataSource.manager, {
          fenceToken: await mintFence(),
          assertHeld: () => Promise.resolve(),
        }),
    } as unknown as SubscriptionMutationLockService;
    writer = new StoreChainWriterService(
      userRepo,
      dataSource.getRepository(StoreBillingReconciliation),
      config,
      fakeLock,
    );
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    const mk = async (label: string) => {
      const saved = await userRepo.save(
        userRepo.create({
          email: `chain-writers-${label}-${tag()}@tarmoto.test`,
          password_hash: 'x',
          display_name: 'Chain Writers',
        }),
      );
      return saved.id;
    };
    userId = await mk('a');
    otherUserId = await mk('b');
  });

  afterEach(async () => {
    // Reconciliation rows do not cascade with the rider; chains do.
    await dataSource.query(
      `DELETE FROM store_billing_reconciliations WHERE user_id = ANY($1)`,
      [[userId, otherUserId]],
    );
    await userRepo.delete([userId, otherUserId]);
  });

  describe('applyChainState — the claim writer', () => {
    it('inserts the chain AND maintains the rollup pair in the same write', async () => {
      const input = await claimInput();
      await expect(writer.applyChainState(input)).resolves.toBe('claimed');

      const chains = await dataSource
        .getRepository(StoreSubscription)
        .find({ where: { user_id: userId } });
      expect(chains).toHaveLength(1);
      expect(chains[0]).toMatchObject({
        provider: 'google',
        original_transaction_id: input.originalTransactionId,
        target_key: input.originalTransactionId,
        target_key_provisional: false,
        tier: 'pro',
      });

      const rollup = await readRollup(userId);
      expect(rollup.tier).toBe('pro');
      expect(rollup.expiresAt?.getTime()).toBe(
        input.currentPeriodEnd?.getTime(),
      );
    });

    it('release A — Stripe is NOT clobbered: a Google Pro chain leaves a Stripe Premium untouched', async () => {
      await givenStripeSide({ tier: 'premium', status: 'active' });
      const before = await readStripeColumns(userId);

      await expect(writer.applyChainState(await claimInput())).resolves.toBe(
        'claimed',
      );

      // Every legacy `users.subscription_*` value is byte-identical — the
      // store writer owns the chain and the rollup, never the Stripe side.
      expect(await readStripeColumns(userId)).toEqual(before);

      // And entitlement stays Premium: the chain contributes through the
      // rollup, and max(stripe premium, store pro) is premium.
      const rollup = await readRollup(userId);
      expect(
        resolveEntitledTier({
          grant_tier: null,
          subscription_tier: 'premium',
          store_subscription_tier: rollup.tier as 'pro' | null,
          store_subscription_tier_expires_at: rollup.expiresAt,
        }),
      ).toBe('premium');
    });

    it('a Play plan replacement holds BOTH chains; the superseded terminal leaves the other entitling', async () => {
      const a = await claimInput({
        originalTransactionId: `GPA.a-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      });
      await writer.applyChainState(a);
      const b = await claimInput({
        originalTransactionId: `GPA.b-${tag()}`,
        tier: 'pro',
        currentPeriodEnd: new Date(Date.now() + 365 * DAY),
      });
      await writer.applyChainState(b);

      expect(
        await dataSource
          .getRepository(StoreSubscription)
          .count({ where: { user_id: userId } }),
      ).toBe(2);
      // Entitlement unchanged while both are live.
      expect((await readRollup(userId)).tier).toBe('pro');

      // A's terminal arrives: truncated period, canceled status. B still
      // entitles and the rollup now carries B's expiry.
      await writer.applyChainState({
        ...a,
        status: 'canceled',
        currentPeriodEnd: new Date(),
        observedAt: new Date(Date.now() + 1000),
        fenceToken: await mintFence(),
      });
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBe('pro');
      expect(rollup.expiresAt?.getTime()).toBe(b.currentPeriodEnd?.getTime());
    });

    it('two independent products: one terminal recomputes the rollup from what remains', async () => {
      const premium = await claimInput({
        originalTransactionId: `GPA.p-${tag()}`,
        tier: 'premium',
        productId: 'tarmoto_premium_monthly',
        currentPeriodEnd: new Date(Date.now() + 15 * DAY),
      });
      await writer.applyChainState(premium);
      const pro = await claimInput({
        originalTransactionId: `GPA.q-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 25 * DAY),
      });
      await writer.applyChainState(pro);
      expect((await readRollup(userId)).tier).toBe('premium');

      await writer.applyChainState({
        ...premium,
        status: 'canceled',
        currentPeriodEnd: new Date(),
        observedAt: new Date(Date.now() + 1000),
        fenceToken: await mintFence(),
      });
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBe('pro');
      expect(rollup.expiresAt?.getTime()).toBe(pro.currentPeriodEnd?.getTime());
    });

    it('per-chain ordering: a later-but-valid event for chain A is applied after a NEWER event for chain B', async () => {
      // The cross-chain interference the rider-level ordering key caused: B's
      // newer observation used to advance the watermark A was checked against.
      const base = Date.now();
      const a = await claimInput({
        originalTransactionId: `GPA.a-${tag()}`,
        observedAt: new Date(base - 60_000),
      });
      await writer.applyChainState(a);
      const b = await claimInput({
        originalTransactionId: `GPA.b-${tag()}`,
        observedAt: new Date(base),
      });
      await writer.applyChainState(b);

      // An event for A observed BETWEEN the two: newer than A's watermark,
      // older than B's. Per-chain ordering applies it.
      await expect(
        writer.applyChainState({
          ...a,
          tier: 'premium',
          observedAt: new Date(base - 30_000),
          fenceToken: await mintFence(),
        }),
      ).resolves.toBe('claimed');
      const chainA = await dataSource
        .getRepository(StoreSubscription)
        .findOneByOrFail({ target_key: a.originalTransactionId! });
      expect(chainA.tier).toBe('premium');
    });

    it("an OLDER read of the SAME chain is 'stale' and changes nothing", async () => {
      const input = await claimInput();
      await writer.applyChainState(input);

      await expect(
        writer.applyChainState({
          ...input,
          tier: 'premium',
          observedAt: new Date(input.observedAt.getTime() - 60_000),
          fenceToken: await mintFence(),
        }),
      ).resolves.toBe('stale');
      const chain = await dataSource
        .getRepository(StoreSubscription)
        .findOneByOrFail({ target_key: input.originalTransactionId! });
      expect(chain.tier).toBe('pro');
    });

    it("a cross-rider identity is 'ownership_conflict' and mutates NOTHING", async () => {
      const identity = `GPA.owned-${tag()}`;
      await writer.applyChainState(
        await claimInput({ originalTransactionId: identity }),
      );

      const result = await writer.applyChainState({
        ...(await claimInput({ originalTransactionId: identity })),
        userId: otherUserId,
      });
      expect(result).toBe('ownership_conflict');
      // The transaction rolled back: no chain for the other rider, no rollup.
      expect(
        await dataSource
          .getRepository(StoreSubscription)
          .count({ where: { user_id: otherUserId } }),
      ).toBe(0);
      expect((await readRollup(otherUserId)).tier).toBeNull();
    });

    it('a NULL-period chain entitles from the start, bounded by the fallback window', async () => {
      const observedAt = new Date();
      await writer.applyChainState(
        await claimInput({ currentPeriodEnd: null, observedAt }),
      );
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBe('pro');
      // The bounded fallback expiry — value asserted, not just non-null: a
      // fallback that stops discriminating would still be non-null.
      expect(rollup.expiresAt?.getTime()).toBe(observedAt.getTime() + 35 * DAY);
    });

    it('a canceled chain with an unexpired period STILL entitles (rollup keeps the tier to the period end)', async () => {
      const input = await claimInput({
        status: 'canceled',
        currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      });
      await writer.applyChainState(input);
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBe('pro');
      expect(rollup.expiresAt?.getTime()).toBe(
        input.currentPeriodEnd?.getTime(),
      );
    });

    it('a refund/revocation TRUNCATES the period and the rollup drops immediately', async () => {
      const input = await claimInput();
      await writer.applyChainState(input);
      expect((await readRollup(userId)).tier).toBe('pro');

      await writer.applyChainState({
        ...input,
        status: 'canceled',
        // The revocation instant — entitlement ends NOW, not at period end.
        currentPeriodEnd: new Date(Date.now() - 1000),
        observedAt: new Date(input.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBeNull();
      expect(rollup.expiresAt).toBeNull();
    });

    it('past_due entitles: the rollup carries the tier through billing retry', async () => {
      await writer.applyChainState(await claimInput({ status: 'past_due' }));
      expect((await readRollup(userId)).tier).toBe('pro');
    });

    it('markTrialUsed stamps the once-per-rider marker monotonically in the SAME write', async () => {
      const first = await claimInput({ markTrialUsed: true });
      await writer.applyChainState(first);
      const stamped: Array<{ billing_trial_used_at: Date | null }> =
        await dataSource.query(
          `SELECT billing_trial_used_at FROM users WHERE id = $1`,
          [userId],
        );
      expect(stamped[0]?.billing_trial_used_at).not.toBeNull();

      // A later trial-marked write must never re-date it.
      await writer.applyChainState({
        ...first,
        observedAt: new Date(first.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
        markTrialUsed: true,
      });
      const after: Array<{ billing_trial_used_at: Date | null }> =
        await dataSource.query(
          `SELECT billing_trial_used_at FROM users WHERE id = $1`,
          [userId],
        );
      expect(after[0]?.billing_trial_used_at?.getTime()).toBe(
        stamped[0]?.billing_trial_used_at?.getTime(),
      );
    });
  });

  describe('provisional overlaps — creation', () => {
    it('a second future-billing chain records ONE provisional row and ZERO operator items', async () => {
      const a = await claimInput({
        originalTransactionId: `GPA.a-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      });
      await writer.applyChainState(a);
      const b = await claimInput({
        originalTransactionId: `GPA.b-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 40 * DAY),
      });
      await writer.applyChainState(b);

      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reason: 'provisional_overlap',
        status: 'provisional',
        overlap_pair_low: expect.stringMatching(/^google:/) as unknown,
        overlap_pair_high: expect.stringMatching(/^google:/) as unknown,
      });
      // Deadline VALUE, not just non-nullness: min(effective ends) + 72h.
      expect(rows[0]?.escalate_after?.getTime()).toBe(
        a.currentPeriodEnd!.getTime() + 72 * 3600_000,
      );
      // A plan replacement is indistinguishable from a duplicate at creation —
      // so the assertion is one PROVISIONAL and zero OPEN, never an operator
      // conflict for what may be a legitimate upgrade.
      expect(rows.filter((row) => row.status === 'open')).toHaveLength(0);
    });

    it('redelivery is idempotent: the same claim twice still yields ONE row', async () => {
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);
      await writer.applyChainState({
        ...b,
        observedAt: new Date(b.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      expect(await listOverlaps(userId)).toHaveLength(1);
    });

    it('a live STRIPE side pairs with a chain — provider-qualified, with the refund role from the store chronology', async () => {
      const subId = `sub_${tag()}`;
      await givenStripeSide({
        subId,
        periodEnd: new Date(Date.now() + 20 * DAY),
      });
      const stripeCreated = new Date('2026-01-01T00:00:00Z');
      await writer.applyChainState(
        await claimInput({
          originalPurchaseDate: new Date('2026-06-01T00:00:00Z'),
          stripeCreatedAt: stripeCreated,
        }),
      );

      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      const members = [rows[0]?.overlap_pair_low, rows[0]?.overlap_pair_high];
      expect(members).toContain(`stripe:${subId}`);
      expect(members.some((m) => m?.startsWith('google:'))).toBe(true);
      // Stripe was purchased first, whatever the byte order says.
      expect(rows[0]?.overlap_older_member).toBe(`stripe:${subId}`);
    });

    it('an UNKNOWN purchase time records an AMBIGUOUS refund target (NULL), never a guess', async () => {
      await givenStripeSide({});
      await writer.applyChainState(
        await claimInput({ originalPurchaseDate: null }),
      );
      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.overlap_older_member).toBeNull();
    });

    it('a NULL-period chain still forms a pair, swept at ITS fallback bound rather than the partner boundary', async () => {
      const observedAt = new Date();
      await givenStripeSide({
        periodEnd: new Date(Date.now() + 300 * DAY),
      });
      await writer.applyChainState(
        await claimInput({ currentPeriodEnd: null, observedAt }),
      );
      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.escalate_after?.getTime()).toBe(
        observedAt.getTime() + 35 * DAY + 72 * 3600_000,
      );
    });

    it('three live sources produce THREE pairs; ending one retires its two and leaves the third tracked', async () => {
      await givenStripeSide({ subId: `sub_${tag()}` });
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);

      let rows = await listOverlaps(userId);
      expect(rows.filter((row) => row.status === 'provisional')).toHaveLength(
        3,
      );

      // Chain A ends → A–stripe and A–B retire; B–stripe survives.
      await writer.applyChainState({
        ...a,
        status: 'canceled',
        currentPeriodEnd: new Date(),
        observedAt: new Date(a.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      rows = await listOverlaps(userId);
      const provisional = rows.filter((row) => row.status === 'provisional');
      expect(provisional).toHaveLength(1);
      expect([
        provisional[0]?.overlap_pair_low,
        provisional[0]?.overlap_pair_high,
      ]).toContain(`google:${b.originalTransactionId}`);
      expect(rows.filter((row) => row.status === 'retired')).toHaveLength(2);
    });

    it('a source cancelled BEFORE the second purchase creates NO pair (future-billing, not entitling)', async () => {
      // Stripe cancelled at period end: still entitling, never charging again
      // — its retiring event already fired, so a pair here could never clear.
      await givenStripeSide({ cancelAtPeriodEnd: true });
      await writer.applyChainState(await claimInput());
      expect(await listOverlaps(userId)).toHaveLength(0);
    });

    it('a mid-period store cancellation retires the pair even though the chain still entitles', async () => {
      await givenStripeSide({});
      const chain = await claimInput({
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
      });
      await writer.applyChainState(chain);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);

      // The chain cancels but keeps its paid period: entitling, not billing.
      await writer.applyChainState({
        ...chain,
        status: 'canceled',
        observedAt: new Date(chain.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      const rows = await listOverlaps(userId);
      expect(rows.filter((row) => row.status === 'provisional')).toHaveLength(
        0,
      );
      expect(rows.filter((row) => row.status === 'retired')).toHaveLength(1);
      // Still entitling to the period end, exactly as the design requires.
      expect((await readRollup(userId)).tier).toBe('pro');
    });

    it('the Stripe settle-point sync retires pairs once the Stripe side goes terminal', async () => {
      await givenStripeSide({});
      await writer.applyChainState(await claimInput());
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);

      // The Stripe terminal lands (as clearStripeTerminal would write it),
      // then the settle point calls the sync.
      await dataSource.query(
        `UPDATE users SET subscription_status = 'canceled',
                subscription_provider = NULL, stripe_subscription_id = NULL
          WHERE id = $1`,
        [userId],
      );
      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
    });

    it('FAILS LOUDLY on a future-billing Stripe status with no subscription id — never a silent skip', async () => {
      await givenStripeSide({ subId: null });
      await expect(writer.applyChainState(await claimInput())).rejects.toThrow(
        /no stripe_subscription_id/,
      );
    });
  });

  describe('the expired-rollup recomputation worker', () => {
    it('a lapsed Premium beside a live Pro: free until the sweep, then Pro — never the lapsed Premium', async () => {
      const pro = await claimInput({
        originalTransactionId: `GPA.pro-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 25 * DAY),
      });
      await writer.applyChainState(pro);
      const premium = await claimInput({
        originalTransactionId: `GPA.prem-${tag()}`,
        tier: 'premium',
        productId: 'tarmoto_premium_monthly',
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      });
      await writer.applyChainState(premium);

      // The premium chain LAPSES with no terminal: its period passes and no
      // chain writer runs. Simulated by rewinding the persisted state, which
      // is exactly what a lost terminal leaves behind.
      await dataSource.query(
        `UPDATE store_subscriptions SET current_period_end = now() - interval '1 hour'
          WHERE target_key = $1`,
        [premium.originalTransactionId],
      );
      await dataSource.query(
        `UPDATE users SET store_subscription_tier_expires_at = now() - interval '1 hour'
          WHERE id = $1`,
        [userId],
      );

      // BEFORE the sweep: self-invalidation drops the WHOLE store side — the
      // fail-closed under-grant the design accepts because it is bounded.
      const stale = await readRollup(userId);
      expect(
        liveStoreTier({
          store_subscription_tier: stale.tier as 'premium' | null,
          store_subscription_tier_expires_at: stale.expiresAt,
        }),
      ).toBeNull();

      // The sweep recomputes from what is live and restores Pro.
      const result = await writer.recomputeExpiredRollups(50);
      expect(result.recomputed).toBeGreaterThanOrEqual(1);
      const fresh = await readRollup(userId);
      expect(fresh.tier).toBe('pro');
      expect(fresh.expiresAt?.getTime()).toBe(pro.currentPeriodEnd?.getTime());
    });

    it('clears the rollup entirely when every chain has lapsed', async () => {
      await writer.applyChainState(await claimInput());
      await dataSource.query(
        `UPDATE store_subscriptions SET current_period_end = now() - interval '1 hour'
          WHERE user_id = $1`,
        [userId],
      );
      await dataSource.query(
        `UPDATE users SET store_subscription_tier_expires_at = now() - interval '1 hour'
          WHERE id = $1`,
        [userId],
      );

      await writer.recomputeExpiredRollups(50);
      const rollup = await readRollup(userId);
      expect(rollup.tier).toBeNull();
      expect(rollup.expiresAt).toBeNull();
    });
  });

  describe('the overlap deadline sweep', () => {
    it('retires a due pair whose member has locally stopped billing (the lost-terminal replacement)', async () => {
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);

      // A's terminal was LOST: by the deadline its period has simply passed.
      await dataSource.query(
        `UPDATE store_subscriptions SET current_period_end = now() - interval '1 hour'
          WHERE target_key = $1`,
        [a.originalTransactionId],
      );
      await dataSource.query(
        `UPDATE store_billing_reconciliations SET escalate_after = now() - interval '1 minute'
          WHERE user_id = $1`,
        [userId],
      );

      const result = await writer.sweepDueOverlaps(50);
      expect(result.retired).toBe(1);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
    });

    it('leaves a due pair whose members BOTH still bill locally — promotion is step 5, never the clock', async () => {
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);
      await dataSource.query(
        `UPDATE store_billing_reconciliations SET escalate_after = now() - interval '1 minute'
          WHERE user_id = $1`,
        [userId],
      );

      const result = await writer.sweepDueOverlaps(50);
      expect(result.retired).toBe(0);
      expect(result.waiting).toBe(1);
      const rows = await listOverlaps(userId);
      expect(rows[0]?.status).toBe('provisional');
      // And no operator item was minted: promotion needs the re-query.
      expect(rows.filter((row) => row.status === 'open')).toHaveLength(0);
    });
  });
});
