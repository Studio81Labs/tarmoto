import { DataSource, Repository } from 'typeorm';
import { AppDataSource } from '../src/data-source.js';
import { User } from '../src/entities/user.entity.js';

/**
 * Schema-level guarantees of the store-subscription-chains expand migration (1837).
 *
 * ## Why these are real-Postgres tests and not unit tests
 *
 * Every assertion here is about a **CHECK constraint or a partial unique index**, and a
 * mocked repository evaluates neither. The design says so explicitly, and this review found
 * the failure twice: a widened vocabulary that omitted a value the prose used would pass any
 * entity-level test and fail with `23514` on the first real insert — rolling back the whole
 * atomic re-key and leaving the row it was fixing in place.
 *
 * Several of these are **negative** assertions. A constraint that admits what it should
 * reject is invisible to a test that only exercises the happy path, and most of the defects
 * these encode were of exactly that shape.
 *
 * ## Running it
 *
 *   pnpm db:up && pnpm db:migrate && pnpm --filter @tarmoto/backend test:e2e
 *
 * NOTE: backend CI runs `test`, not `test:e2e`, and provisions no database — so nothing
 * automated executes this file today. The Postgres-backed job is blocked on the migration
 * chain not building from empty; both are tracked in #1193.
 */
describe('store subscription chains — schema (migration 1837, #1191)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let userId: string;
  let otherUserId: string;

  const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  /** A chain row with every NOT NULL column filled, overridable per test. */
  const chain = (over: Record<string, unknown> = {}) => ({
    user_id: userId,
    provider: 'google',
    original_transaction_id: null,
    target_key: `tk-${tag()}`,
    target_key_provisional: true,
    product_id: 'pro_monthly',
    tier: 'pro',
    status: 'active',
    current_period_end: null,
    store_signed_date: new Date(),
    ...over,
  });

  type InsertedRow = { id: string };

  const insertChain = (
    over: Record<string, unknown> = {},
  ): Promise<InsertedRow[]> => {
    const row = chain(over);
    return dataSource.query<InsertedRow[]>(
      `INSERT INTO store_subscriptions
         (user_id, provider, original_transaction_id, target_key,
          target_key_provisional, product_id, tier, status,
          current_period_end, store_signed_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        row.user_id,
        row.provider,
        row.original_transaction_id,
        row.target_key,
        row.target_key_provisional,
        row.product_id,
        row.tier,
        row.status,
        row.current_period_end,
        row.store_signed_date,
      ],
    );
  };

  const insertObligation = (
    over: Record<string, unknown> = {},
  ): Promise<InsertedRow[]> => {
    const row = {
      kind: 'cancellation',
      attempt_id: crypto.randomUUID(),
      user_id: userId,
      app_user_id: `pat-${tag()}`,
      provider: 'google',
      product_id: 'pro_monthly',
      target_key: `tk-${tag()}`,
      store_transaction_id: `GPA.${tag()}`,
      status: 'pending',
      resolved_at: null,
      retention_expires_at: new Date(Date.now() + 86_400_000),
      export_matchable: true,
      original_transaction_id: null,
      // No original id, so target_key necessarily holds a per-renewal store transaction id
      // and must be flagged provisional — the state enrichment keys off.
      target_key_provisional: true,
      ...over,
    };
    return dataSource.query<InsertedRow[]>(
      `INSERT INTO store_deletion_obligations
         (kind, attempt_id, user_id, app_user_id, provider, product_id, target_key,
          store_transaction_id, status, resolved_at, retention_expires_at,
          export_matchable, original_transaction_id, target_key_provisional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        row.kind,
        row.attempt_id,
        row.user_id,
        row.app_user_id,
        row.provider,
        row.product_id,
        row.target_key,
        row.store_transaction_id,
        row.status,
        row.resolved_at,
        row.retention_expires_at,
        row.export_matchable,
        row.original_transaction_id,
        row.target_key_provisional,
      ],
    );
  };

  beforeAll(async () => {
    dataSource = new DataSource(AppDataSource.options);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    const mk = async (label: string) => {
      const saved = await userRepo.save(
        userRepo.create({
          email: `chains-${label}-${tag()}@tarmoto.test`,
          password_hash: 'x',
          display_name: 'Chains',
        }),
      );
      return saved.id;
    };
    userId = await mk('a');
    otherUserId = await mk('b');
  });

  afterEach(async () => {
    await dataSource.query(
      `DELETE FROM store_deletion_obligations WHERE user_id = ANY($1)`,
      [[userId, otherUserId]],
    );
    await userRepo.delete([userId, otherUserId]);
  });

  describe('chains', () => {
    it('accepts an UNIDENTIFIED chain — the restore and enumeration case', async () => {
      // The subscriber response carries no original transaction id, so this insert is the
      // one a NOT NULL identity would abort — leaving a restored rider free while billed.
      const [row] = await insertChain({ original_transaction_id: null });
      expect(row?.id).toBeTruthy();
    });

    it('rejects the same (provider, target_key) for a SECOND rider', async () => {
      // The cross-rider guard. Keyed on target_key because original_transaction_id is NULL
      // here and PostgreSQL treats NULLs as distinct — an identity-keyed unique would not
      // constrain provisional rows at all.
      const key = `tk-shared-${tag()}`;
      await insertChain({ target_key: key });
      await expect(
        insertChain({ target_key: key, user_id: otherUserId }),
      ).rejects.toThrow(/duplicate key|23505/i);
    });

    it('allows TWO chains of the same product for one rider', async () => {
      // The case the single-slot binding could not represent, and the reason a
      // product-scoped key is wrong.
      await insertChain({ product_id: 'pro_monthly' });
      const [row] = await insertChain({ product_id: 'pro_monthly' });
      expect(row?.id).toBeTruthy();
    });

    it('accepts a NULL current_period_end', async () => {
      // "No known end" is bounded by the fallback window, not rejected: a NOT NULL column
      // aborts the write and denies a paying rider entitlement outright.
      const [row] = await insertChain({ current_period_end: null });
      expect(row?.id).toBeTruthy();
    });
  });

  describe('the rollup pairing', () => {
    it('REJECTS a tier stored without an expiry', async () => {
      // Without the CHECK this row is accepted, never invalidated by the resolver's time
      // comparison, and unselectable by the sweep — so paid access persists forever.
      await expect(
        dataSource.query(
          `UPDATE users SET store_subscription_tier = 'pro',
             store_subscription_tier_expires_at = NULL WHERE id = $1`,
          [userId],
        ),
      ).rejects.toThrow(/users_store_rollup_paired_check|23514/i);
    });

    it('accepts both NULL — every existing rider has no store side', async () => {
      await expect(
        dataSource.query(
          `UPDATE users SET store_subscription_tier = NULL,
             store_subscription_tier_expires_at = NULL WHERE id = $1`,
          [userId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('reconciliation vocabulary', () => {
    const insertRec = (
      reason: string,
      status: string,
      escalateAfter: Date | null = null,
    ): Promise<InsertedRow[]> =>
      dataSource.query<InsertedRow[]>(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status, escalate_after)
         VALUES ($1, 'google', $2, $3, $4) RETURNING id`,
        [userId, reason, status, escalateAfter],
      );

    it.each([
      // `provisional` carries a deadline — the CHECK requires one, and a provisional row
      // without it would never be swept.
      ['provisional_overlap', 'provisional', new Date(Date.now() + 3_600_000)],
      ['exclusivity_conflict', 'open', null],
      ['ownership_conflict', 'open', null],
      ['exclusivity_conflict', 'retired', null],
    ])('accepts reason=%s status=%s', async (reason, status, escalateAfter) => {
      const [row] = await insertRec(reason, status, escalateAfter);
      expect(row?.id).toBeTruthy();
    });

    it('STILL accepts unrecognized_product after the widening', async () => {
      // Migration 1825 added it. Recreating the check from 1822's three values would have
      // silently dropped it and broken an existing insert — which is why the migration
      // enumerates from the live schema rather than from the design document.
      const [row] = await insertRec('unrecognized_product', 'open');
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS a provisional row with no escalate_after', async () => {
      // A null deadline is never swept — `escalate_after <= now()` cannot select it — so the
      // overlap sits unresolved forever. The never-fires hole, reintroduced by a nullable
      // column.
      await expect(
        insertRec('provisional_overlap', 'provisional'),
      ).rejects.toThrow(/sbr_provisional_deadline_check|23514/i);
    });

    it('still dedups a LEGACY Apple conflict with no pair columns', async () => {
      // openConflict emits these and depends on this index for race-safe dedup. Narrowing
      // the index by reason instead of by structure would silently drop that protection,
      // and the pair index cannot cover it — its predicate needs the pair columns.
      const otid = `otid-${tag()}`;
      await dataSource.query(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, apple_original_transaction_id, reason, status)
         VALUES ($1, 'apple', $2, 'exclusivity_conflict', 'open')`,
        [userId, otid],
      );
      await expect(
        dataSource.query(
          `INSERT INTO store_billing_reconciliations
             (user_id, provider, apple_original_transaction_id, reason, status)
           VALUES ($1, 'apple', $2, 'exclusivity_conflict', 'open')`,
          [userId, otid],
        ),
      ).rejects.toThrow(/duplicate key|23505/i);
    });

    it('allows TWO Apple PAIR rows sharing one OTID', async () => {
      // One Apple source overlapping both Stripe and Google. Excluding by reason left this
      // colliding; excluding by structure is what lets both promotions land.
      const otid = `otid-pair-${tag()}`;
      const mkPair = (other: string) =>
        dataSource.query(
          `INSERT INTO store_billing_reconciliations
             (user_id, provider, apple_original_transaction_id, reason, status,
              overlap_pair_low, overlap_pair_high)
           VALUES ($1, 'apple', $2, 'exclusivity_conflict', 'open', $3, $4)`,
          [userId, otid, `apple:${otid}`, other],
        );
      await mkPair(`stripe:sub_${tag()}`);
      await expect(mkPair(`google:GPA.${tag()}`)).resolves.toBeDefined();
    });

    const mkPairRow = (
      low: string,
      high: string,
      status = 'open',
      older: string | null = null,
    ): Promise<InsertedRow[]> =>
      dataSource.query<InsertedRow[]>(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status, overlap_pair_low, overlap_pair_high,
            overlap_older_member, escalate_after)
         VALUES ($1, 'google', 'exclusivity_conflict', $2, $3, $4, $5, NULL)
         RETURNING id`,
        [userId, status, low, high, older],
      );

    it('REJECTS a pair written in REVERSE order', async () => {
      // The pair is unordered, so only a canonical encoding dedups. Reversed, the row is a
      // distinct key to uq_sbr_unresolved_overlap_pair: one billing overlap becomes two
      // unresolved rows, two escalations, and a refund path asked to settle it twice.
      const t = tag();
      await expect(
        mkPairRow(`google:GPA.${t}`, `apple:otid-${t}`),
      ).rejects.toThrow(/sbr_overlap_pair_order_check|23514/i);
    });

    it('REJECTS a LIVE self-pair', async () => {
      // A chain cannot overlap itself; escalating one refunds a rider for a single
      // subscription. Strictness is what excludes it — `<=` would admit it.
      const same = `apple:otid-${tag()}`;
      await expect(mkPairRow(same, same)).rejects.toThrow(
        /sbr_overlap_pair_order_check|23514/i,
      );
    });

    it('ACCEPTS a RETIRED self-pair — the re-key collapse depends on it', async () => {
      // Re-keying X to O rewrites every pair containing X, so the pair (X, O) becomes (O, O)
      // and is retired outright. An unexempted constraint fails that atomic re-key with
      // 23514, leaving the self-pair live — the convergence block the design calls out.
      const same = `apple:otid-${tag()}`;
      const [row] = await mkPairRow(same, same, 'retired');
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS an older member that is not IN its pair', async () => {
      // The stale-re-key case: the pair moves, the role does not, and it is left naming a
      // retired identity the refund workflow cannot resolve.
      const t = tag();
      await expect(
        mkPairRow(
          `apple:otid-${t}`,
          `google:GPA.${t}`,
          'open',
          `apple:stale-${t}`,
        ),
      ).rejects.toThrow(/sbr_overlap_older_member_check|23514/i);
    });

    it('REJECTS an older member on a row with NO pair', async () => {
      // `x IN (NULL, NULL)` is NULL, which a CHECK accepts — so the membership rule needs an
      // explicit pair-present guard or this row passes unnoticed.
      await expect(
        dataSource.query(
          `INSERT INTO store_billing_reconciliations
             (user_id, provider, reason, status, overlap_older_member)
           VALUES ($1, 'google', 'exclusivity_conflict', 'open', $2)`,
          [userId, `apple:orphan-${tag()}`],
        ),
      ).rejects.toThrow(/sbr_overlap_older_member_check|23514/i);
    });

    it('accepts a canonical pair naming either member as older', async () => {
      // Both roles are legal, and NULL stays legal too — that is how an ambiguous refund
      // target is recorded when the store chronology cannot decide one.
      const t = tag();
      const low = `apple:otid-${t}`;
      const high = `google:GPA.${t}`;
      for (const older of [low, high, null]) {
        const [row] = await mkPairRow(low, high, 'resolved', older);
        expect(row?.id).toBeTruthy();
      }
    });

    it('rejects an unknown reason', async () => {
      await expect(insertRec('not_a_reason', 'open')).rejects.toThrow(
        /sbr_reason_check|23514/i,
      );
    });
  });

  describe('deletion obligations', () => {
    it('accepts an ERASURE row with no provider, chain or target', async () => {
      // An erasure is per rider and names no chain. A NOT NULL chain identity makes the
      // durable erasure row uninsertable — leaving a failed RevenueCat erasure with nothing
      // to retry from, which is the entire reason the row exists.
      const [row] = await insertObligation({
        kind: 'erasure',
        provider: null,
        product_id: null,
        target_key: null,
        store_transaction_id: null,
        target_key_provisional: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS an erasure row CARRYING chain fields', async () => {
      // Symmetric on purpose: a writer reusing a populated cancellation payload would
      // otherwise leave billing identifiers in a purge-safe table about a rider who asked to
      // be deleted — the one thing this table must not do.
      await expect(
        insertObligation({ kind: 'erasure', provider: 'google' }),
      ).rejects.toThrow(/sdo_kind_fields_check|23514/i);
    });

    it('REJECTS a no-original-id cancellation marked NOT provisional', async () => {
      // target_key then holds a per-renewal id presented as stable, so enrichment — which
      // keys on the flag — never sees it: duplicates never merge, and a failed duplicate
      // keeps erasure blocked after its sibling succeeded.
      await expect(
        insertObligation({
          original_transaction_id: null,
          target_key_provisional: false,
        }),
      ).rejects.toThrow(/sdo_staged_key_check|23514/i);
    });

    it('accepts an ENRICHED cancellation: original id known, not provisional', async () => {
      // The other legal branch, and the one a tightened constraint silently breaks. Requiring
      // every cancellation to be provisional passes all the tests above, yet makes the state
      // enrichment writes unreachable: the re-key sets original_transaction_id, target_key and
      // the flag in ONE statement (design §"re-key and merge"), so a rule that never admits
      // the post-re-key row fails the whole atomic update with 23514 and the duplicate stays.
      const otid = `otid-${tag()}`;
      const [row] = await insertObligation({
        original_transaction_id: otid,
        target_key: otid,
        target_key_provisional: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS a cancellation row with no target', async () => {
      // Loosening the column types for erasure must not admit a cancellation the worker
      // could never execute.
      await expect(insertObligation({ target_key: null })).rejects.toThrow(
        /sdo_kind_fields_check|23514/i,
      );
    });

    it('REJECTS an actionable row with no app_user_id', async () => {
      // Every cancellation attempt re-queries RevenueCat for the current order id using
      // this handle; a row without it can never execute or recover.
      await expect(insertObligation({ app_user_id: null })).rejects.toThrow(
        /sdo_handle_required_check|23514/i,
      );
    });

    it('REJECTS an unidentified support_only row with no app_user_id', async () => {
      // A lost-webhook Apple row is support_only IMMEDIATELY, so an actionable-only rule
      // would admit it without the one key that can match the export — forcing it down the
      // unmatchable path while the handle was still available.
      await expect(
        insertObligation({
          status: 'support_only',
          resolved_at: new Date(),
          app_user_id: null,
          export_matchable: true,
          original_transaction_id: null,
        }),
      ).rejects.toThrow(/sdo_handle_required_check|23514/i);
    });

    it('allows app_user_id to be cleared once erasure has resolved it', async () => {
      const [row] = await insertObligation({
        status: 'support_only',
        resolved_at: new Date(),
        export_matchable: false,
        app_user_id: null,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS a pending row with resolved_at set', async () => {
      // resolved_at IS NULL <=> actionable. The sweep indexes partition on this column, so
      // a status its timestamp disagrees with is invisible to one sweep and wrong in the
      // other.
      await expect(
        insertObligation({ status: 'pending', resolved_at: new Date() }),
      ).rejects.toThrow(/sdo_resolved_at_check|23514/i);
    });

    it('dedups an unresolved cancellation per (attempt, provider, target)', async () => {
      const attempt = crypto.randomUUID();
      const key = `tk-dup-${tag()}`;
      await insertObligation({ attempt_id: attempt, target_key: key });
      await expect(
        insertObligation({ attempt_id: attempt, target_key: key }),
      ).rejects.toThrow(/duplicate key|23505/i);
    });

    it('still dedups after the first row SUCCEEDS', async () => {
      // Scoped to the actionable states, a row drops out of the index the moment it
      // succeeds — and a later claim inserts a second obligation whose failure then blocks
      // erasure for work already done.
      const attempt = crypto.randomUUID();
      const key = `tk-succ-${tag()}`;
      await insertObligation({
        attempt_id: attempt,
        target_key: key,
        status: 'succeeded',
        resolved_at: new Date(),
      });
      await expect(
        insertObligation({ attempt_id: attempt, target_key: key }),
      ).rejects.toThrow(/duplicate key|23505/i);
    });

    it('allows a RETIRED row to be replaced — a restored rider deletes again', async () => {
      const attempt = crypto.randomUUID();
      const key = `tk-ret-${tag()}`;
      await insertObligation({
        attempt_id: attempt,
        target_key: key,
        status: 'retired',
        resolved_at: new Date(),
      });
      const [row] = await insertObligation({
        attempt_id: attempt,
        target_key: key,
      });
      expect(row?.id).toBeTruthy();
    });
  });
});
