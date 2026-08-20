import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
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
  /** See the fake lock in `beforeAll`: work committed "just before" a locked section. */
  let onLockAcquired: ((lockedUserId: string) => Promise<void>) | null = null;

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
    // Serialised stand-in for the per-rider lock. `onLockAcquired` lets a test
    // inject work that "held the lock just before us" — committed state a
    // correctly locked section MUST observe in its own re-read. Consumed once.
    const fakeLock = {
      runExclusive: async <T>(
        lockedUserId: string,
        fn: (
          manager: unknown,
          lease: { fenceToken: number; assertHeld: () => Promise<void> },
        ) => Promise<T>,
      ): Promise<T> => {
        if (onLockAcquired) {
          const hook = onLockAcquired;
          onLockAcquired = null;
          await hook(lockedUserId);
        }
        return fn(dataSource.manager, {
          fenceToken: await mintFence(),
          assertHeld: () => Promise.resolve(),
        });
      },
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
    // Reconciliation rows do not cascade with their rider, so earlier LOCAL
    // runs of this suite (the throwaway-database workflow keeps state across
    // runs) can leave DANGLING provisional rows whose future deadlines have
    // since become due — and the global deadline sweep would then pick them up
    // ahead of this test's rows. Scoped to rows whose rider no longer exists,
    // so nothing belonging to a real rider in a shared database is touched.
    await dataSource.query(
      `DELETE FROM store_billing_reconciliations sbr
        WHERE sbr.status = 'provisional'
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sbr.user_id)`,
    );
  });

  afterEach(async () => {
    onLockAcquired = null;
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
          stripe: {
            subscriptionId: subId,
            createdAt: stripeCreated,
            terminal: false,
          },
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

    it('a legacy customer-only rider (null stored id) STILL forms a pair — the selected id reaches the encoding', async () => {
      // The design's coverage item verbatim: the persisted column is null while
      // an entitling subscription is discovered from the customer, and the
      // caller (a snapshot-driven claim, or the webhook with its event record)
      // supplies the SELECTED id — item (8)'s snapshot fields exist for this.
      await givenStripeSide({
        subId: null,
        periodEnd: new Date(Date.now() + 20 * DAY),
      });
      const selected = `sub_selected_${tag()}`;
      await writer.applyChainState(
        await claimInput({
          originalPurchaseDate: new Date('2026-06-01T00:00:00Z'),
          stripe: {
            subscriptionId: selected,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            terminal: false,
          },
        }),
      );

      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      expect([rows[0]?.overlap_pair_low, rows[0]?.overlap_pair_high]).toContain(
        `stripe:${selected}`,
      );
      // Both fields came from the SAME record, so the chronology is usable.
      expect(rows[0]?.overlap_older_member).toBe(`stripe:${selected}`);
    });

    it('a MISMATCHED created time (delayed terminal for a superseded subscription) records an AMBIGUOUS role, never the wrong one', async () => {
      // The row names sub_NEW; the event carries sub_OLD's id and created.
      // Attaching the old record's chronology to the new identity would name a
      // confidently wrong refund target that ON CONFLICT never corrects — the
      // role falls to the NULL ambiguity sentinel instead.
      const subNew = `sub_new_${tag()}`;
      await givenStripeSide({
        subId: subNew,
        periodEnd: new Date(Date.now() + 20 * DAY),
      });
      await writer.applyChainState(
        await claimInput({
          originalPurchaseDate: new Date('2026-06-01T00:00:00Z'),
          stripe: {
            subscriptionId: `sub_old_${tag()}`,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            terminal: false,
          },
        }),
      );

      const rows = await listOverlaps(userId);
      expect(rows).toHaveLength(1);
      expect([rows[0]?.overlap_pair_low, rows[0]?.overlap_pair_high]).toContain(
        `stripe:${subNew}`,
      );
      expect(rows[0]?.overlap_older_member).toBeNull();
    });

    it('an INDETERMINATE Stripe side (no resolvable id) never retires the pair a resolvable reading recorded', async () => {
      // Pair recorded while the identity was supplied; a later chain event
      // arrives WITHOUT one (no snapshot, no Stripe event). The Stripe member
      // is then unseeable, not stopped — retiring on it would drop tracking of
      // a subscription this reading simply could not see.
      await givenStripeSide({
        subId: null,
        periodEnd: new Date(Date.now() + 20 * DAY),
      });
      const selected = `sub_selected_${tag()}`;
      const chain = await claimInput({
        stripe: { subscriptionId: selected, createdAt: null, terminal: false },
      });
      await writer.applyChainState(chain);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);

      // Renewal observed with NO Stripe knowledge: the pair must survive.
      await writer.applyChainState({
        ...chain,
        stripe: null,
        observedAt: new Date(chain.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);

      // Once the persisted status is AFFIRMATIVELY terminal, the same
      // no-identity reading retires it.
      await dataSource.query(
        `UPDATE users SET subscription_status = 'canceled' WHERE id = $1`,
        [userId],
      );
      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
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

    it('tolerates the grant-preserving ownerless past_due Stripe state — the sync must never fail the webhook', async () => {
      // AccountService deliberately persists a never-entitling checkout's
      // `past_due` status and period onto a grant rider with `skipOwnership`,
      // leaving `stripe_subscription_id` NULL so the failed checkout cannot
      // revoke the grant. That state reaches the settle-point sync on every
      // delivery of the event; an unconditional identity requirement turned
      // each one into an error and an indefinite Stripe retry.
      await givenStripeSide({ subId: null, status: 'past_due' });
      await dataSource.query(
        `UPDATE users SET plan_source = 'founder', subscription_tier = 'premium' WHERE id = $1`,
        [userId],
      );

      await expect(
        writer.syncOverlapsAfterBillingChange(dataSource.manager, userId),
      ).resolves.toBeUndefined();
      expect(await listOverlaps(userId)).toHaveLength(0);
    });

    it('excludes the ownerless Stripe state from pairing — a chain claim still completes', async () => {
      // Same rider state, now with a store purchase landing beside it: the
      // claim must not abort (the chain and rollup are store truth), and no
      // pair can be recorded — the unowned columns are not evidence of a
      // claimed, billing subscription; the exclusion is logged, not thrown.
      await givenStripeSide({ subId: null, status: 'past_due' });

      await expect(writer.applyChainState(await claimInput())).resolves.toBe(
        'claimed',
      );
      expect((await readRollup(userId)).tier).toBe('pro');
      expect(await listOverlaps(userId)).toHaveLength(0);
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

    it('leaves a due pair whose members BOTH still bill locally — promotion is step 5, never the clock — and REFRESHES its deadline so it cannot monopolise the batch', async () => {
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
      // The frozen past deadline would keep this row permanently the OLDEST
      // due row, and ~50 such rows would starve every newer due pair out of
      // the bounded oldest-first batch. An undecidable row yields its slot:
      // its deadline moves to the CURRENT pair deadline (min effective ends +
      // grace, per the design's definition).
      expect(rows[0]?.escalate_after?.getTime()).toBe(
        a.currentPeriodEnd!.getTime() + 72 * 3600_000,
      );
    });

    it('waiting rows cannot starve the batch: a refreshed waiter yields its slot to the next due pair (limit 1)', async () => {
      // Rider A: both members live, due, OLDEST deadline — the permanently
      // waiting shape. On otherUserId: a retirable due pair. With limit 1 the
      // old behaviour evaluated A every tick and never reached the other rider.
      const a1 = await claimInput({ originalTransactionId: `GPA.a1-${tag()}` });
      await writer.applyChainState(a1);
      const a2 = await claimInput({ originalTransactionId: `GPA.a2-${tag()}` });
      await writer.applyChainState(a2);
      await dataSource.query(
        `UPDATE store_billing_reconciliations SET escalate_after = now() - interval '2 hours'
          WHERE user_id = $1`,
        [userId],
      );

      const b1 = await claimInput({
        userId: otherUserId,
        originalTransactionId: `GPA.b1-${tag()}`,
      });
      await writer.applyChainState(b1);
      const b2 = await claimInput({
        userId: otherUserId,
        originalTransactionId: `GPA.b2-${tag()}`,
      });
      await writer.applyChainState(b2);
      await dataSource.query(
        `UPDATE store_subscriptions SET current_period_end = now() - interval '1 hour'
          WHERE target_key = $1`,
        [b1.originalTransactionId],
      );
      await dataSource.query(
        `UPDATE store_billing_reconciliations SET escalate_after = now() - interval '1 hour'
          WHERE user_id = $1`,
        [otherUserId],
      );

      // Tick 1 picks the oldest (rider A), waits, and refreshes its deadline.
      const first = await writer.sweepDueOverlaps(1);
      expect(first).toMatchObject({ scanned: 1, waiting: 1, retired: 0 });

      // Tick 2: rider A is no longer due, so the retirable pair is evaluated.
      const second = await writer.sweepDueOverlaps(1);
      expect(second).toMatchObject({ scanned: 1, retired: 1 });
      expect(
        (await listOverlaps(otherUserId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
    });

    it('does NOT retire a pair whose member a writer reactivated just before the sweep took the lock', async () => {
      // The Codex P1 interleaving: the sweep would read A as lapsed, a
      // concurrent claim reactivates A and its own sync inserts nothing (the
      // pair is still provisional), and an unlocked sweep then retires the row
      // — both members billing, no unresolved overlap, and no later event
      // guaranteed to re-create it. Check-and-retire under the SAME per-rider
      // lock closes it: the reactivation commits before the sweep's locked
      // section, and the section's own re-read sees it.
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);

      // The state an unlocked pre-read would act on: A lapsed, pair due.
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

      // The writer that held the lock JUST BEFORE the sweep: A renews.
      onLockAcquired = async () => {
        await writer.applyChainState({
          ...a,
          currentPeriodEnd: new Date(Date.now() + 30 * DAY),
          observedAt: new Date(a.observedAt.getTime() + 5000),
          fenceToken: await mintFence(),
        });
      };

      const result = await writer.sweepDueOverlaps(50);
      expect(result.retired).toBe(0);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);
    });

    it('the sweep serializes on the users row too: a reactivation committed while it WAITS for the lock is seen, the pair survives', async () => {
      // Round-5 review (P1): `runExclusive` alone cannot serialize the
      // sweep's re-read against its writes — plain SELECTs do not block on
      // row locks, so a lease lapse after the re-read let a stale section
      // retire a pair a newer writer had just reactivated. The per-rider
      // section is now ONE transaction opened on the users-row lock: this
      // test holds that lock, fires the sweep (which must block), commits the
      // reactivation, and the unblocked sweep must see it and wait instead of
      // retiring.
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);
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

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
          userId,
        ]);
        const sweepDone = writer.sweepDueOverlaps(50);
        // Without the lock this window is where the sweep read A as lapsed.
        await new Promise((resolve) => setTimeout(resolve, 150));
        // The newer writer's reactivation, committed while the sweep blocks.
        await runner.query(
          `UPDATE store_subscriptions SET current_period_end = now() + interval '30 days'
            WHERE target_key = $1`,
          [a.originalTransactionId],
        );
        await runner.commitTransaction();
        const result = await sweepDone;
        expect(result.retired).toBe(0);
      } finally {
        await runner.release();
      }
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);
    });

    it('stamps purchase_inactive on a sweep retirement, so operators can tell it from a legacy unset row', async () => {
      const a = await claimInput({ originalTransactionId: `GPA.a-${tag()}` });
      await writer.applyChainState(a);
      const b = await claimInput({ originalTransactionId: `GPA.b-${tag()}` });
      await writer.applyChainState(b);
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

      await writer.sweepDueOverlaps(50);
      const retiredRows = (await listOverlaps(userId)).filter(
        (row) => row.status === 'retired',
      );
      expect(retiredRows).toHaveLength(1);
      expect(retiredRows[0]?.resolution).toBe('purchase_inactive');
      expect(retiredRows[0]?.resolved_at).not.toBeNull();
    });
  });

  describe('deadline refresh at observation (ON CONFLICT DO UPDATE)', () => {
    it("a member's renewal moves the pair deadline to the NEW min effective end + grace", async () => {
      const a = await claimInput({
        originalTransactionId: `GPA.a-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      });
      await writer.applyChainState(a);
      const b = await claimInput({
        originalTransactionId: `GPA.b-${tag()}`,
        currentPeriodEnd: new Date(Date.now() + 40 * DAY),
      });
      await writer.applyChainState(b);
      const before = await listOverlaps(userId);
      expect(before[0]?.escalate_after?.getTime()).toBe(
        a.currentPeriodEnd!.getTime() + 72 * 3600_000,
      );

      // A renews: the design defines the deadline as min(effective ends) +
      // grace, so the stored value must follow the rolled-over period rather
      // than stay frozen at creation.
      const renewedEnd = new Date(Date.now() + 35 * DAY);
      await writer.applyChainState({
        ...a,
        currentPeriodEnd: renewedEnd,
        observedAt: new Date(a.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });
      const after = await listOverlaps(userId);
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe('provisional');
      expect(after[0]?.escalate_after?.getTime()).toBe(
        renewedEnd.getTime() + 72 * 3600_000,
      );
    });
  });

  describe('fence-stale store writes (the deleted single-slot coverage, re-pinned on chains)', () => {
    it('a chain write below a newer committed users fence throws the retryable 503 and mutates NOTHING (update path)', async () => {
      const input = await claimInput();
      await writer.applyChainState(input);

      // A newer holder committed: the users fence is advanced past a token
      // this stale flow will present.
      const staleToken = await mintFence();
      const newerToken = await mintFence();
      await dataSource.query(
        `UPDATE users SET subscription_lock_fence = $2 WHERE id = $1`,
        [userId, newerToken],
      );

      await expect(
        writer.applyChainState({
          ...input,
          tier: 'premium',
          observedAt: new Date(input.observedAt.getTime() + 1000),
          fenceToken: staleToken,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // The fence-stale rollup write rolled the chain UPDATE back with it.
      const chain = await dataSource
        .getRepository(StoreSubscription)
        .findOneByOrFail({ target_key: input.originalTransactionId! });
      expect(chain.tier).toBe('pro');
    });

    it('a fence-stale INSERT rolls back with the rollup write — no chain row survives', async () => {
      const staleToken = await mintFence();
      const newerToken = await mintFence();
      await dataSource.query(
        `UPDATE users SET subscription_lock_fence = $2 WHERE id = $1`,
        [userId, newerToken],
      );

      await expect(
        writer.applyChainState({
          ...(await claimInput()),
          fenceToken: staleToken,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(
        await dataSource
          .getRepository(StoreSubscription)
          .count({ where: { user_id: userId } }),
      ).toBe(0);
      expect((await readRollup(userId)).tier).toBeNull();
    });
  });

  describe('stripe observation stamp — anchoring the null-period fallback (migration 1838)', () => {
    const readStamp = async (): Promise<Date | null> => {
      const rows: Array<{ stamp: Date | null }> = await dataSource.query(
        `SELECT subscription_stripe_observed_at AS stamp FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0]?.stamp ?? null;
    };

    /** Null-period live Stripe side + one chain, pair recorded by an
     *  identity-matched (observing) reading — the shape every test here
     *  starts from. Returns the chain input for follow-up events. */
    const givenNullPeriodPair = async (subId: string) => {
      await givenStripeSide({ subId, periodEnd: null });
      const chain = await claimInput({
        stripe: {
          subscriptionId: subId,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          terminal: false,
        },
      });
      await writer.applyChainState(chain);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(1);
      return chain;
    };

    it('an observing reading persists the stamp; a MISMATCHED record does not', async () => {
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);
      const stamp = await readStamp();
      expect(stamp).not.toBeNull();
      expect(Math.abs(stamp!.getTime() - Date.now())).toBeLessThan(60_000);

      // A delayed event for a SUPERSEDED subscription must not vouch for the
      // tracked one's liveness — same binding rule as the refund role.
      await dataSource.query(
        `UPDATE users SET subscription_stripe_observed_at = NULL WHERE id = $1`,
        [userId],
      );
      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId, {
        subscriptionId: `sub_other_${tag()}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        terminal: false,
      });
      expect(await readStamp()).toBeNull();
    });

    it('a MISMATCHED record does not re-arm an aged-out side either: the pair retires and the stamp stays put', async () => {
      // Round-3 review: the anchor decision must obey the same binding rule
      // as the stamp. `stripe != null` alone selecting "now" let a delayed
      // event for a superseded subscription make the aged-out TRACKED side
      // look future-billing for another full window in the very reading that
      // correctly refused to persist the false observation.
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);
      await dataSource.query(
        `UPDATE users SET subscription_stripe_observed_at = now() - interval '36 days'
          WHERE id = $1`,
        [userId],
      );

      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId, {
        subscriptionId: `sub_other_${tag()}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        terminal: false,
      });

      // Judged by the persisted stamp, the tracked side is stopped: the pair
      // retires in this very reading instead of being refreshed.
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
      const stamp = await readStamp();
      expect(stamp!.getTime()).toBeLessThan(Date.now() - 35 * DAY);
    });

    it('a TERMINAL record for an ownerless checkout creates NO overlap and advances NO stamp', async () => {
      // Round-5 review: the deleted-event settle point beside a
      // grant-preserving ownerless checkout. `clearStripeTerminal` matched
      // zero rows (provider/id never persisted), so the row still says
      // `past_due` with a null id — and the sync used to read the event's id
      // as fresh billing evidence, building a false overlap between a
      // KNOWN-DEAD subscription and the rider's live chain, stamped as
      // observed-now, for a full fallback window.
      await givenStripeSide({
        subId: null,
        status: 'past_due',
        periodEnd: null,
      });
      await writer.applyChainState(await claimInput());
      const checkoutId = `sub_checkout_${tag()}`;

      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId, {
        subscriptionId: checkoutId,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        terminal: true,
      });

      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
      // A terminal reading contributes no liveness anchor.
      expect(await readStamp()).toBeNull();
    });

    it('a TERMINAL record retires the pair an earlier ALIVE observation recorded — same identity, opposite meaning', async () => {
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);
      const stampAfterAlive = await readStamp();
      expect(stampAfterAlive).not.toBeNull();

      await writer.syncOverlapsAfterBillingChange(dataSource.manager, userId, {
        subscriptionId: subId,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        terminal: true,
      });

      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
      // The stamp keeps the ALIVE observation's value: terminal readings
      // advance nothing.
      expect((await readStamp())!.getTime()).toBe(stampAfterAlive!.getTime());
    });

    it('the stamp is hidden from whole-entity saves: a stale profile flow cannot regress or null it', async () => {
      // Round-4 review — the `store_subscription_tier` hazard, same remedy:
      // `updateProfile`/`uploadAvatar` load a `User` and save it later, and
      // `save()` writes back loaded values that differ. A default-selected
      // stamp loaded BEFORE the sync advanced it would be persisted from that
      // stale snapshot. With `select: false` the property is never loaded, so
      // the save cannot touch it.
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);

      // The profile flow loads its entity FIRST (default selection)…
      const repo = dataSource.getRepository(User);
      const loaded = await repo.findOneByOrFail({ id: userId });
      // …then the sync moves the stamp (sentinel value, distinct from the
      // claim-time one)…
      await dataSource.query(
        `UPDATE users SET subscription_stripe_observed_at = now() - interval '10 days'
          WHERE id = $1`,
        [userId],
      );
      const sentinel = await readStamp();
      // …and the profile flow saves its stale snapshot last.
      loaded.display_name = 'Stale Profile Save';
      await repo.save(loaded);

      const after = await readStamp();
      expect(after).not.toBeNull();
      expect(after!.getTime()).toBe(sentinel!.getTime());
    });

    it('the sync serializes on the users row: a concurrent committed write is SEEN, never overwritten from a stale read', async () => {
      // Round-3 review (lost-lease staleness): a sync whose holder lost its
      // lease must not commit conclusions from a read that predates a newer
      // holder's committed write. The users-row lock makes the read-and-write
      // atomic: this test holds the row lock in an open transaction, fires
      // the sync (which must BLOCK), cancels the subscription inside the held
      // transaction, commits — and the sync, unblocked, must act on the
      // CANCELED state it re-read, not the live state that existed when it
      // was called.
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
          userId,
        ]);
        const syncDone = writer.syncOverlapsAfterBillingChange(
          dataSource.manager,
          userId,
          null,
        );
        // Give the sync time to reach its row lock and block — without the
        // lock this window is where it would complete against LIVE state.
        await new Promise((resolve) => setTimeout(resolve, 150));
        // The newer holder's write, committed while the sync is blocked.
        await runner.query(
          `UPDATE users SET subscription_status = 'canceled' WHERE id = $1`,
          [userId],
        );
        await runner.commitTransaction();
        await syncDone;
      } finally {
        await runner.release();
      }

      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
    });

    it('the Codex regression: a lost-terminal null-period Stripe side ages OUT — the sweep anchors to the LAST observation, not the read time', async () => {
      // Terminal webhook lost: status stays 'active', period end is null, and
      // no further Stripe event ever arrives. Before the stamp, every sweep
      // pass minted observedAt = now, re-armed the fallback window, and the
      // pair could never age out locally.
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);
      await dataSource.query(
        `UPDATE users SET subscription_stripe_observed_at = now() - interval '36 days'
          WHERE id = $1`,
        [userId],
      );
      await dataSource.query(
        `UPDATE store_billing_reconciliations SET escalate_after = now() - interval '1 minute'
          WHERE user_id = $1`,
        [userId],
      );

      const result = await writer.sweepDueOverlaps(50);
      expect(result.retired).toBe(1);
      const rows = await listOverlaps(userId);
      expect(rows.filter((row) => row.status === 'provisional')).toHaveLength(
        0,
      );
      expect(rows[0]?.resolution).toBe('purchase_inactive');
    });

    it('a NON-observing chain renewal neither refreshes the stamp nor keeps the aged-out side alive', async () => {
      const subId = `sub_${tag()}`;
      const chain = await givenNullPeriodPair(subId);
      await dataSource.query(
        `UPDATE users SET subscription_stripe_observed_at = now() - interval '36 days'
          WHERE id = $1`,
        [userId],
      );

      // The renewal observes the STORE, not Stripe (`stripe: null`): its sync
      // must judge the Stripe side by the persisted stamp — aged out — and
      // must not advance the stamp as a side effect.
      await writer.applyChainState({
        ...chain,
        stripe: null,
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
        observedAt: new Date(chain.observedAt.getTime() + 1000),
        fenceToken: await mintFence(),
      });

      const stamp = await readStamp();
      expect(stamp).not.toBeNull();
      expect(stamp!.getTime()).toBeLessThan(Date.now() - 35 * DAY);
      expect(
        (await listOverlaps(userId)).filter(
          (row) => row.status === 'provisional',
        ),
      ).toHaveLength(0);
    });

    it('a FRESH stamp keeps the null-period side billing: the due pair waits and its deadline moves to stamp + fallback + grace', async () => {
      const subId = `sub_${tag()}`;
      await givenNullPeriodPair(subId);
      const stamp = await readStamp();
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
      // The refreshed deadline is anchored to the persisted observation (the
      // chain member's end is ~30d out, the stripe member's effective end is
      // stamp + fallback ≈ the same scale; min + grace lands in the future
      // either way — the point is it no longer re-arms from the read time).
      expect(rows[0]?.escalate_after?.getTime()).toBeGreaterThan(Date.now());
      expect(await readStamp()).toEqual(stamp);
    });
  });
});
