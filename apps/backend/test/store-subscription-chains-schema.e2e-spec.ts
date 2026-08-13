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
 * automated executes this file today, and a Postgres-backed job cannot be added until the
 * migration chain builds from empty. It does not: `InitSchema1713000000000` executes
 * `docs/database/schema.sql`, which is maintained as CURRENT state while being used as the
 * BASELINE, so it forward-references `admin_users` (created by 1751) and already contains
 * tables and columns that 1715, 1793, 1714400, 1717, 1792 and 1783 go on to create. Every
 * one of those fails on a fresh database. Diagnosis and the exact job to restore are in
 * #1193.
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

  /**
   * Ids this suite inserted, so cleanup can delete exactly those.
   *
   * The documented workflow points at the ordinary DEV database, and a purged obligation
   * has a null user_id by construction — so a rider-keyed predicate cannot reach the rows
   * this file creates, and widening it to "or null" would delete every purged obligation in
   * that database, including real outstanding work.
   */
  const createdObligationIds: string[] = [];

  const insertObligation = async (
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
      // Both belong in the column list, not merely in the defaults: an override of a column
      // the INSERT does not name is silently dropped, and a rejection test that inserts a
      // legal row instead passes for the wrong reason.
      attempt_outcome: 'running',
      enrichment_deadline_at: null,
      ...over,
    };
    const rows = await dataSource.query<InsertedRow[]>(
      `INSERT INTO store_deletion_obligations
         (kind, attempt_id, user_id, app_user_id, provider, product_id, target_key,
          store_transaction_id, status, resolved_at, retention_expires_at,
          export_matchable, original_transaction_id, target_key_provisional,
          attempt_outcome, enrichment_deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
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
        row.attempt_outcome,
        row.enrichment_deadline_at,
      ],
    );
    for (const inserted of rows) createdObligationIds.push(inserted.id);
    return rows;
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
    if (createdObligationIds.length) {
      await dataSource.query(
        `DELETE FROM store_deletion_obligations WHERE id = ANY($1)`,
        [createdObligationIds],
      );
      createdObligationIds.length = 0;
    }
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

    it('accepts an ENRICHED chain: key re-pointed at the original id', async () => {
      // The post-re-key state, written in one statement with the identity and the flag. A
      // constraint that cannot admit it fails the whole atomic update with 23514.
      const otid = `otid-${tag()}`;
      const [row] = await insertChain({
        original_transaction_id: otid,
        target_key: otid,
        target_key_provisional: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS a stable chain whose target_key is NOT the original id', async () => {
      // Identified but not re-keyed: it claims a canonical key while still keyed by a
      // per-renewal id, so the same chain is insertable a second time under its original id
      // and uq_ss_provider_target_key — the cross-rider guard — never sees the collision.
      await expect(
        insertChain({
          original_transaction_id: `otid-${tag()}`,
          target_key: `GPA.stale-${tag()}`,
          target_key_provisional: false,
        }),
      ).rejects.toThrow(/ss_staged_key_check|23514/i);
    });

    it('rejects an IDENTIFIED chain claimed by a second rider', async () => {
      // Note which guard this proves. Since a stable row's target_key EQUALS its original id,
      // uq_ss_provider_target_key already covers every case uq_ss_provider_original_txn
      // covers, and fires first — the secondary index is redundant once the equality
      // invariant holds, and is kept only so relaxing that invariant cannot silently drop
      // the identity guard. Either way the second rider is refused, which is the behaviour
      // worth pinning.
      const otid = `otid-dup-${tag()}`;
      await insertChain({
        original_transaction_id: otid,
        target_key: otid,
        target_key_provisional: false,
      });
      await expect(
        insertChain({
          original_transaction_id: otid,
          target_key: otid,
          target_key_provisional: false,
          user_id: otherUserId,
        }),
      ).rejects.toThrow(/duplicate key|23505/i);
    });

    it.each(['free', 'vip'])('REJECTS a chain at tier=%s', async (tier) => {
      // A store product confers a PAID tier; 'free' is the absence of a store subscription,
      // which this table represents by having no row. Both survive an unconstrained column
      // and then vanish silently: higherTier() ranks an unrecognised value at -1 — the same
      // rank as null — so the rollup resolves to 'free' and a billed rider loses access.
      await expect(insertChain({ tier })).rejects.toThrow(
        /ss_tier_check|23514/i,
      );
    });

    it('accepts a NULL current_period_end', async () => {
      // "No known end" is bounded by the fallback window, not rejected: a NOT NULL column
      // aborts the write and denies a paying rider entitlement outright.
      const [row] = await insertChain({ current_period_end: null });
      expect(row?.id).toBeTruthy();
    });
  });

  describe('the rollup pairing', () => {
    it('survives a concurrent whole-entity save', async () => {
      // The regression this pair's `select: false` exists for. updateProfile and
      // uploadAvatar load a User and save it later; save() diffs the loaded entity against
      // a fresh reload and writes back every column that differs, so a default-selected
      // rollup is persisted from a stale snapshot.
      //
      // The dangerous direction is the one asserted here: the stale value is NULL, which
      // removes paid access from a rider who just paid AND takes the row out of the expiry
      // sweep's partial index — so the repair path is the very thing the write destroys.
      const stale = await userRepo.findOne({ where: { id: userId } });
      expect(stale).toBeTruthy();

      // Loaded without the columns, they are absent rather than null — which is precisely
      // why save() cannot write them back.
      expect(stale).not.toHaveProperty('store_subscription_tier', null);

      // A chain writer lands between the load and the save.
      await dataSource.query(
        `UPDATE users SET store_subscription_tier = 'premium',
           store_subscription_tier_expires_at = now() + interval '30 days'
         WHERE id = $1`,
        [userId],
      );

      stale!.display_name = 'Renamed';
      await userRepo.save(stale!);

      const [after] = await dataSource.query<
        { store_subscription_tier: string | null }[]
      >(`SELECT store_subscription_tier FROM users WHERE id = $1`, [userId]);
      expect(after?.store_subscription_tier).toBe('premium');
    });

    it('REJECTS a rollup tier outside the paid vocabulary', async () => {
      // NULL is how "no store entitlement" is spelled here, so 'free' would be a second
      // encoding of the same fact that every reader would have to know about.
      await expect(
        dataSource.query(
          `UPDATE users SET store_subscription_tier = 'free',
             store_subscription_tier_expires_at = now() + interval '1 day' WHERE id = $1`,
          [userId],
        ),
      ).rejects.toThrow(/users_store_rollup_tier_check|23514/i);
    });

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
    ): Promise<InsertedRow[]> => {
      // A provisional row carries its pair or it is unactionable, so the vocabulary check
      // has to supply one — this inserted a pairless provisional row until the constraint
      // existed to reject it.
      const pair =
        status === 'provisional'
          ? [`apple:otid-${tag()}`, `google:GPA.${tag()}`]
          : [null, null];
      return dataSource.query<InsertedRow[]>(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status, escalate_after,
            overlap_pair_low, overlap_pair_high)
         VALUES ($1, 'google', $2, $3, $4, $5, $6) RETURNING id`,
        [userId, reason, status, escalateAfter, pair[0], pair[1]],
      );
    };

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
      reason = 'exclusivity_conflict',
    ): Promise<InsertedRow[]> =>
      dataSource.query<InsertedRow[]>(
        `INSERT INTO store_billing_reconciliations
           (user_id, provider, reason, status, overlap_pair_low, overlap_pair_high,
            overlap_older_member, escalate_after)
         VALUES ($1, 'google', $2, $3, $4, $5, $6, NULL)
         RETURNING id`,
        [userId, reason, status, low, high, older],
      );

    it('REJECTS a provisional row carrying NO pair', async () => {
      // The escalation index selects on status = 'provisional' alone, so this row is picked
      // up forever and can never be acted on: nothing to re-query, nothing to retire on,
      // nothing to promote. Permanently selected, permanently unactionable.
      await expect(
        dataSource.query(
          `INSERT INTO store_billing_reconciliations
             (user_id, provider, reason, status, escalate_after)
           VALUES ($1, 'google', 'provisional_overlap', 'provisional', $2)`,
          [userId, new Date(Date.now() + 3_600_000)],
        ),
      ).rejects.toThrow(/sbr_provisional_pair_required_check|23514/i);
    });

    // Each pair is CANONICALLY ORDERED on purpose, so the format check is what rejects it.
    // Ordered the other way the order check fires first and the test passes on the generic
    // 23514 while proving nothing — the trap this file has already fallen into twice.
    it.each([
      ['unqualified', 'apple:otid-1', 'otid-plain'],
      ['misprefixed', 'apple:otid-1', 'bogus:otid-2'],
      ['qualifier with no identity', 'apple:', 'google:GPA.1'],
    ])('REJECTS a %s pair member', async (_label, low, high) => {
      // Every consumer decodes these on the provider-qualified contract, and none of the
      // other checks looks inside the string — so the row reaches the deadline worker as a
      // source it cannot decode or re-query, and no retry changes that.
      //
      // The qualifier also carries meaning: store identifiers are unique only WITHIN a
      // provider, so an unqualified member can collide with a different provider's pair and
      // merge two unrelated overlaps.
      await expect(mkPairRow(low, high)).rejects.toThrow(
        /sbr_overlap_pair_format_check|23514/i,
      );
    });

    it.each(['ownership_conflict', 'deletion_cancel_failed'])(
      'REJECTS pair columns on a %s row',
      async (reason) => {
        // Such a row takes over the pair's slot in uq_sbr_unresolved_overlap_pair, so the
        // genuine provisional_overlap that follows for the same rider and identities fails
        // with 23505 — the double-billing work item suppressed by a row unrelated to it.
        await expect(
          mkPairRow(
            `apple:otid-${tag()}`,
            `google:GPA.${tag()}`,
            'open',
            null,
            reason,
          ),
        ).rejects.toThrow(/sbr_pair_reason_check|23514/i);
      },
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

    it('REJECTS provisional_overlap left OPEN without promotion', async () => {
      // The vocabulary is a promotion: provisional_overlap on creation, exclusivity_conflict
      // once escalated. Open under the creation reason puts an UNCONFIRMED overlap straight
      // in front of an operator — and the refund path then acts on a duplicate that may not
      // be one, which is the whole reason the provisional status exists.
      await expect(
        mkPairRow(
          `apple:otid-${tag()}`,
          `google:GPA.${tag()}`,
          'open',
          null,
          'provisional_overlap',
        ),
      ).rejects.toThrow(/sbr_provisional_reason_status_check|23514/i);
    });

    it('REJECTS a provisional row under a NON-overlap reason', async () => {
      // The converse: the overlap deadline sweep selects on status alone, so this row is
      // routed through pair reconciliation under a reason that knows nothing about pairs.
      // exclusivity_conflict rather than an arbitrary reason, so the row is invalid for
      // exactly one reason: it is a legal pair reason (sbr_pair_reason_check passes) and
      // carries its pair (sbr_provisional_pair_required_check passes), leaving only the
      // promotion rule to reject it.
      await expect(
        dataSource.query(
          `INSERT INTO store_billing_reconciliations
             (user_id, provider, reason, status, escalate_after,
              overlap_pair_low, overlap_pair_high)
           VALUES ($1, 'google', 'exclusivity_conflict', 'provisional', $2, $3, $4)`,
          [
            userId,
            new Date(Date.now() + 3_600_000),
            `apple:otid-${tag()}`,
            `google:GPA.${tag()}`,
          ],
        ),
      ).rejects.toThrow(/sbr_provisional_reason_status_check|23514/i);
    });

    it('accepts provisional_overlap at a terminal status', async () => {
      // Stated as two implications rather than a status allowlist so that retiring or
      // resolving the creation reason stays writable — only the unpromoted OPEN state is
      // wrong.
      const [row] = await mkPairRow(
        `apple:otid-${tag()}`,
        `google:GPA.${tag()}`,
        'retired',
        null,
        'provisional_overlap',
      );
      expect(row?.id).toBeTruthy();
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

    it('REJECTS a stable cancellation whose target_key is NOT the original id', async () => {
      // Enrichment cleared the flag but left the old per-renewal key. The row now claims to
      // be canonical while deduping under an id that still advances, so the next observation
      // keyed by the stable original inserts a SECOND non-retired obligation — and a failed
      // duplicate keeps gating erasure after its sibling has succeeded.
      await expect(
        insertObligation({
          original_transaction_id: `otid-${tag()}`,
          target_key: `GPA.stale-${tag()}`,
          target_key_provisional: false,
        }),
      ).rejects.toThrow(/sdo_staged_key_check|23514/i);
    });

    it('REJECTS a RUNNING obligation with no user_id', async () => {
      // The retry protocol picks its locking path by whether user_id is present. Null while
      // still running sends a pre-purge attempt down the post-purge path, skipping the
      // account-deletion lock and its re-check — so an irreversible cancellation can
      // complete for a rider who has just restored.
      await expect(insertObligation({ user_id: null })).rejects.toThrow(
        /sdo_purge_phase_check|23514/i,
      );
    });

    it('REJECTS a PURGED obligation still carrying a user_id', async () => {
      // The mirror: a post-purge retry takes the pre-purge path and reads a User row that no
      // longer exists — and the account link outlives the deletion, which is the one thing
      // this table's minimisation rule forbids.
      await expect(
        insertObligation({
          attempt_outcome: 'purged',
          enrichment_deadline_at: new Date(),
        }),
      ).rejects.toThrow(/sdo_purge_phase_check|23514/i);
    });

    it('allows a LATER purge to clear an ABANDONED row', async () => {
      // The repeat-deletion path: the rider restores attempt A, then completes attempt B.
      // A's rows are abandoned but still carry the user id, and B's purge must clear THEM
      // TOO — a biconditional either fails that update with 23514 or forces the purge to
      // skip them, leaving the deleted rider's UUID in the purge-safe ledger.
      const [row] = await insertObligation({
        attempt_outcome: 'abandoned',
        status: 'retired',
        resolved_at: new Date(),
        user_id: null,
        // Abandoning the attempt cleared these; user_id is what the LATER purge clears.
        app_user_id: null,
        export_matchable: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it('accepts an ABANDONED row that still holds its user id', async () => {
      // The other side of the same allowance: while the restored rider still exists, the
      // link is legitimate — support correlates on it.
      const [row] = await insertObligation({
        attempt_outcome: 'abandoned',
        status: 'retired',
        resolved_at: new Date(),
        app_user_id: null,
        export_matchable: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it.each(['pending', 'failed'])(
      'REJECTS an ABANDONED attempt with an actionable row (%s)',
      async (status) => {
        // A restore ends the attempt and retires its unresolved rows. Miss one and the
        // retention sweep treats the attempt as finished while the null resolved_at keeps
        // the row in the outstanding cohort — so obsolete cancellation work goes on
        // retrying, or escalates, for a rider who came back.
        //
        // This row is invalid under sdo_abandoned_handle_check too (an abandoned attempt
        // holds no handle), and PostgreSQL reports whichever it evaluates first — hence the
        // 23514 alternative rather than a claim of isolation. The combination is
        // unreachable on purpose: an abandoned attempt has no actionable rows to hold one.
        await expect(
          insertObligation({
            attempt_outcome: 'abandoned',
            status,
            resolved_at: null,
          }),
        ).rejects.toThrow(/sdo_abandoned_not_actionable_check|23514/i);
      },
    );

    it.each(['retired', 'succeeded'])(
      'REJECTS an ABANDONED attempt keeping its handle (%s)',
      async (status) => {
        // The rule is about the ATTEMPT, not the row's status — and succeeded is why. A
        // succeeded cancellation is never retired, and the restore retires the erasure row,
        // so no later erasure will ever run to clear the handle: the record would hold a
        // subscriber identifier until retention cleanup for a rider no longer being deleted.
        await expect(
          insertObligation({
            attempt_outcome: 'abandoned',
            status,
            resolved_at: new Date(),
            export_matchable: false,
          }),
        ).rejects.toThrow(/sdo_abandoned_handle_check|23514/i);
      },
    );

    it('REJECTS an ABANDONED row still owing an export match', async () => {
      // Clearing the handle alone is not the write: a support_only row with no stable id
      // still owes enrichment, so abandonment cancels that obligation in the same statement.
      await expect(
        insertObligation({
          attempt_outcome: 'abandoned',
          status: 'retired',
          resolved_at: new Date(),
          app_user_id: null,
          export_matchable: true,
        }),
      ).rejects.toThrow(/sdo_abandoned_handle_check|23514/i);
    });

    it('REJECTS a RUNNING cancellation created UNMATCHABLE', async () => {
      // The flag records that enrichment FAILED, so it cannot be true at creation. Set up
      // front it disarms three rules at once: the handle stops being required on a
      // support_only row, the purge stops being required to stamp a deadline, and erasure
      // proceeds without the export wait — leaving a support record with neither a stable
      // identity nor the handle that could have obtained one.
      await expect(
        insertObligation({ export_matchable: false }),
      ).rejects.toThrow(/sdo_running_export_matchable_check|23514/i);
    });

    it('REJECTS a RUNNING obligation that already carries a deadline', async () => {
      // Set at deletion request, the deadline is anchored ~30 days too early and is already
      // overdue when purge makes enrichment actionable: the first attempt marks the row
      // unmatchable and erases the only handle that could have matched the export, without
      // ever waiting the export cycle it promises.
      await expect(
        insertObligation({ enrichment_deadline_at: new Date() }),
      ).rejects.toThrow(/sdo_running_no_deadline_check|23514/i);
    });

    it('REJECTS a PURGED unidentified cancellation with no enrichment deadline', async () => {
      // The purge is what makes enrichment actionable and must stamp its deadline. Left
      // null, the row is unreachable: the sweep selects on `enrichment_deadline_at <= now()`
      // and NULL never satisfies it, so erasure stays gated on this row indefinitely.
      await expect(
        insertObligation({
          attempt_outcome: 'purged',
          // Null because the purge nulls it — the phase discriminator, not incidental.
          user_id: null,
          enrichment_deadline_at: null,
          original_transaction_id: null,
          export_matchable: true,
        }),
      ).rejects.toThrow(/sdo_purged_enrichment_deadline_check|23514/i);
    });

    it.each([
      ['the deadline is stamped', { enrichment_deadline_at: new Date() }],
      ['it is already identified', { identified: true }],
      ['it is unmatchable', { export_matchable: false }],
    ])('accepts a PURGED cancellation when %s', async (_label, over) => {
      // The exemptions are the rows with nothing left to wait for. An unmatchable row is
      // pinned to the maximum retention window instead of an extendable deadline, so a
      // deadline would be meaningless rather than merely absent.
      const { identified, ...rest } = over as Record<string, unknown>;
      const otid = `otid-${tag()}`;
      const [row] = await insertObligation({
        attempt_outcome: 'purged',
        user_id: null,
        ...(identified
          ? {
              original_transaction_id: otid,
              target_key: otid,
              target_key_provisional: false,
            }
          : {}),
        ...rest,
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
          provider: 'apple',
          status: 'support_only',
          resolved_at: new Date(),
          app_user_id: null,
          export_matchable: true,
          original_transaction_id: null,
        }),
      ).rejects.toThrow(/sdo_handle_required_check|23514/i);
    });

    it('allows app_user_id to be cleared once erasure has resolved it', async () => {
      // Apple, because support_only is an APPLE cancellation state — this read as a Google
      // one until the constraint below existed to say so. And PURGED, because that is when
      // erasure resolves it: export_matchable is an enrichment OUTCOME, so a still-running
      // row may not carry false.
      const [row] = await insertObligation({
        provider: 'apple',
        status: 'support_only',
        resolved_at: new Date(),
        attempt_outcome: 'purged',
        user_id: null,
        export_matchable: false,
        app_user_id: null,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS a GOOGLE cancellation marked support_only', async () => {
      // Google HAS a server-side cancel, so "never actionable" is false for it — and
      // sdo_resolved_at_check counts the row as resolved, so erasure gating proceeds while
      // the renewal is still live. The rider is purged and goes on being billed.
      await expect(
        insertObligation({
          provider: 'google',
          status: 'support_only',
          resolved_at: new Date(),
        }),
      ).rejects.toThrow(/sdo_support_only_check|23514/i);
    });

    it.each(['pending', 'failed'])(
      'REJECTS an APPLE cancellation left actionable (%s)',
      async (status) => {
        // There is no server-side cancel to run, so the row can never resolve: it gates
        // erasure indefinitely and holds app_user_id for exactly as long.
        await expect(
          insertObligation({
            provider: 'apple',
            status,
            resolved_at: null,
          }),
        ).rejects.toThrow(/sdo_apple_not_actionable_check|23514/i);
      },
    );

    it.each(['retired', 'succeeded'])(
      'accepts an APPLE cancellation at a terminal status (%s)',
      async (status) => {
        // The reason this is not the literal "Apple implies support_only": a restore moves
        // unresolved rows to retired, and a re-query that finds the subscription already
        // ended resolves one succeeded. The strict form would reject both.
        const [row] = await insertObligation({
          provider: 'apple',
          status,
          resolved_at: new Date(),
        });
        expect(row?.id).toBeTruthy();
      },
    );

    it.each(['succeeded', 'failed'])(
      'REJECTS an ERASURE resolved while its attempt still RUNS (%s)',
      async (status) => {
        // The two kinds are on different clocks on purpose: cancellation runs at deletion
        // REQUEST, erasure waits for the PURGE because it is irreversible. Resolved while
        // the attempt still runs, the subscriber was destroyed while the deletion could
        // still be restored — for a rider who may come back and whose data cannot.
        await expect(
          insertObligation({
            kind: 'erasure',
            provider: null,
            product_id: null,
            target_key: null,
            store_transaction_id: null,
            target_key_provisional: false,
            status,
            // Per status, so each row is invalid for exactly ONE reason: a succeeded
            // erasure must have cleared the handle, while a failed one is actionable and
            // must still hold it. Keeping either fixed makes the row fail two rules and the
            // assertion stops distinguishing which.
            ...(status === 'succeeded'
              ? { app_user_id: null, resolved_at: new Date() }
              : { resolved_at: null }),
          }),
        ).rejects.toThrow(/sdo_erasure_awaits_purge_check|23514/i);
      },
    );

    it('REJECTS a SUCCEEDED erasure still holding the handle', async () => {
      // Confirmed erasure is the documented clearing trigger, and the general handle rule
      // only PERMITS null once a row is non-actionable — so without this the identifier
      // survives until the retention sweep, after the one operation it exists for is done.
      await expect(
        insertObligation({
          kind: 'erasure',
          provider: null,
          product_id: null,
          target_key: null,
          store_transaction_id: null,
          target_key_provisional: false,
          status: 'succeeded',
          resolved_at: new Date(),
          attempt_outcome: 'purged',
          user_id: null,
        }),
      ).rejects.toThrow(/sdo_erasure_handle_cleared_check|23514/i);
    });

    it('accepts the attempt-wide clearing update erasure performs', async () => {
      // The write the constraint above exists to force: one attempt, its erasure row and a
      // sibling cancellation, both losing the handle in the same statement once erasure is
      // confirmed. The cancellation is identified, so it owes no further export match and
      // the general handle rule permits its null too.
      const attemptId = crypto.randomUUID();
      const otid = `otid-${tag()}`;
      await insertObligation({
        attempt_id: attemptId,
        attempt_outcome: 'purged',
        user_id: null,
        status: 'succeeded',
        resolved_at: new Date(),
        original_transaction_id: otid,
        target_key: otid,
        target_key_provisional: false,
      });
      await insertObligation({
        attempt_id: attemptId,
        kind: 'erasure',
        provider: null,
        product_id: null,
        target_key: null,
        store_transaction_id: null,
        target_key_provisional: false,
        attempt_outcome: 'purged',
        user_id: null,
        status: 'pending',
      });

      await expect(
        dataSource.query(
          `UPDATE store_deletion_obligations
              SET app_user_id = NULL,
                  status = CASE WHEN kind = 'erasure' THEN 'succeeded' ELSE status END,
                  resolved_at = COALESCE(resolved_at, now())
            WHERE attempt_id = $1`,
          [attemptId],
        ),
      ).resolves.toBeDefined();

      const [remaining] = await dataSource.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM store_deletion_obligations
          WHERE attempt_id = $1 AND app_user_id IS NOT NULL`,
        [attemptId],
      );
      expect(remaining?.n).toBe('0');
    });

    it('REJECTS a PURGED erasure marked retired', async () => {
      // A contradiction with teeth: uq_sdo_erasure_attempt excludes retired rows, so the
      // rider loses the record tracking their outstanding erasure, and sdo_resolved_at_check
      // counts it resolved, so nothing reports it. The subscriber stays unerased for good.
      await expect(
        insertObligation({
          kind: 'erasure',
          provider: null,
          product_id: null,
          target_key: null,
          store_transaction_id: null,
          target_key_provisional: false,
          attempt_outcome: 'purged',
          user_id: null,
          status: 'retired',
          resolved_at: new Date(),
          app_user_id: null,
        }),
      ).rejects.toThrow(/sdo_erasure_retired_only_abandoned_check|23514/i);
    });

    it('accepts a retired erasure on an ABANDONED attempt', async () => {
      // Where retirement belongs: the restore that ends the attempt retires the erasure,
      // because there is no longer anything to erase.
      const [row] = await insertObligation({
        kind: 'erasure',
        provider: null,
        product_id: null,
        target_key: null,
        store_transaction_id: null,
        target_key_provisional: false,
        attempt_outcome: 'abandoned',
        status: 'retired',
        resolved_at: new Date(),
        app_user_id: null,
        export_matchable: false,
      });
      expect(row?.id).toBeTruthy();
    });

    it('REJECTS an ERASURE marked support_only', async () => {
      // The RevenueCat erasure is always executable, so it can never be excused as
      // support-only — that would resolve the gate without erasing anything.
      await expect(
        insertObligation({
          kind: 'erasure',
          provider: null,
          product_id: null,
          target_key: null,
          store_transaction_id: null,
          target_key_provisional: false,
          status: 'support_only',
          resolved_at: new Date(),
          // Purged, so sdo_erasure_awaits_purge_check is satisfied and this row is invalid
          // for exactly one reason — the status it is named for.
          attempt_outcome: 'purged',
          user_id: null,
        }),
      ).rejects.toThrow(/sdo_support_only_check|23514/i);
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
