import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EXPAND half of the store-subscription-chains move — release A, step 4.9.
 * Design: `docs/superpowers/specs/2026-08-12-store-subscription-chains-design.md`.
 *
 * ## What this replaces, and why
 *
 * `users.apple_original_transaction_id` / `users.google_original_transaction_id` are one
 * nullable column each, so a rider can hold exactly one chain per provider and
 * `claimForGoogle`'s identity guard is equality-only. RevenueCat support confirmed
 * (ticket `ZERPGP-3L1PN`) that a Google Play base-plan change **rebases**
 * `original_transaction_id`, so that guard rejects a legitimate monthly→annual upgrade:
 * the rider keeps paying while their tier, status and period end stay frozen on the
 * subscription they left.
 *
 * The guard could never have prevented the thing it was written for. Refusing to record a
 * second subscription does not stop the store billing for it — it only makes us blind to
 * it. So chains get their own rows, entitlement derives from the live set, and an overlap
 * is **detected and reconciled** rather than refused.
 *
 * ## This migration is EXPAND-ONLY
 *
 * It adds tables, columns and indexes, and widens two CHECK constraints. Nothing reads the
 * new shape yet and no writer is changed, so behaviour is identical on every existing row.
 * Readers and writers move in follow-ups; the legacy columns are dropped in release B,
 * gated on this release being deployed and no longer a rollback target — migration 1831's
 * `42703` rolling-deploy hazard. **Migration 1833's never-deployed shortcut is a statement
 * about deployment state; re-check it then, do not inherit it.**
 *
 * ## No backfill, deliberately
 *
 * No store subscription has ever existed in any environment: Google was never implemented,
 * Apple's `iap/validate` was unmounted before it had a real caller (PR #1136), and the app
 * has never been deployed. Both legacy columns are NULL in every row everywhere, so there
 * is nothing to copy and no dual-write phase to sequence.
 */
export class AddStoreSubscriptionChains1837000000000 implements MigrationInterface {
  name = 'AddStoreSubscriptionChains1837000000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and `users` is the most
  // contended table in the schema — a plain build blocks writes for its duration, at
  // container startup during a rolling deploy. Same reasoning as migration 1831.
  //
  // The cost is that the statements below are no longer atomic with each other, so every
  // one is written to be idempotent (`IF NOT EXISTS` / `IF EXISTS`) and a re-run after a
  // partial failure converges instead of erroring.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- chains
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS store_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(16) NOT NULL
          CONSTRAINT ss_provider_check CHECK (provider IN ('apple','google')),
        -- The stable chain identity. NULLABLE: the RevenueCat subscriber response carries
        -- no original transaction id (open item (b)), so a chain discovered by the
        -- deletion enumeration or recreated on restore exists before its stable id is
        -- known. A NOT NULL column would abort that insert and leave a rider free while
        -- still being billed.
        original_transaction_id VARCHAR(1024),
        -- The identity actually used for dedup and matching: the original id once known,
        -- otherwise the observed store transaction id as a PROVISIONAL value. Staged
        -- because no identifier stable across renewals is available on both discovery
        -- paths; enrichment re-keys to the original and merges.
        target_key VARCHAR(1024) NOT NULL,
        target_key_provisional BOOLEAN NOT NULL DEFAULT FALSE,
        product_id VARCHAR(255) NOT NULL,
        -- The store's own chronology, which decides the overlap refund target. Ingestion
        -- order gets it wrong under export repair: an older purchase recovered later is
        -- observed second.
        original_purchase_date TIMESTAMPTZ,
        -- Paid tiers only. A store product cannot confer 'free' — that is the ABSENCE of a
        -- store subscription, which this table represents by having no row. Unconstrained,
        -- a malformed product mapping persists any string, and higherTier() ranks an
        -- unrecognised value at -1, the same rank as null: the rollup resolves to 'free' and
        -- a billed rider silently loses the entitlement they are paying for.
        tier VARCHAR(16) NOT NULL
          CONSTRAINT ss_tier_check CHECK (tier IN ('pro','premium')),
        status VARCHAR(16) NOT NULL
          CONSTRAINT ss_status_check CHECK
            (status IN ('active','trialing','past_due','canceled')),
        -- NULL means "no known end", bounded by the fallback window rather than treated as
        -- expired. A NOT NULL column would abort the write instead.
        current_period_end TIMESTAMPTZ,
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        -- The ordering key, now PER CHAIN. Shared at rider level it lets an event for one
        -- chain advance the value a later-but-valid event for another is checked against.
        store_signed_date TIMESTAMPTZ NOT NULL,
        lock_fence BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- The staged key's two halves must agree. An unidentified chain necessarily holds a
        -- per-renewal transaction id in target_key, so it MUST be flagged provisional;
        -- enrichment sets the original id, re-keys and clears the flag together. Without
        -- this a restore or enumeration insert that omits the flag is accepted and then
        -- invisible to enrichment, which keys on it — leaving a chain that is never
        -- re-keyed and never merged.
        -- The second clause is what makes the key STABLE rather than merely identified.
        -- Nullness alone accepts a row that learned its original id and cleared the flag
        -- while keeping the old per-renewal target_key: it claims to be canonical and is
        -- keyed by something that still advances, so the next observation keyed by the
        -- original id inserts a SECOND row for one chain, which is what the key exists to
        -- prevent.
        CONSTRAINT ss_staged_key_check CHECK (
          (original_transaction_id IS NULL) = target_key_provisional
          AND (target_key_provisional OR target_key = original_transaction_id)
        )
      );
    `);

    // PRIMARY cross-rider guard — a chain belongs to exactly one rider. Keyed on
    // `target_key` rather than `original_transaction_id`, which is NULL for every chain
    // created by the deletion enumeration or restore: PostgreSQL treats NULLs as distinct,
    // so an identity-keyed guard would not constrain them at all.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_ss_provider_target_key;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_ss_provider_target_key
        ON store_subscriptions (provider, target_key);
    `);
    // SECONDARY, where non-null: the stable identity is still worth enforcing once known,
    // it simply cannot be the primary guard while unidentified chains are supported.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_ss_provider_original_txn;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_ss_provider_original_txn
        ON store_subscriptions (provider, original_transaction_id)
        WHERE original_transaction_id IS NOT NULL;
    `);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_ss_user;`);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ss_user
        ON store_subscriptions (user_id);
    `);

    // ------------------------------------------------------- deletion ledger
    // Purge-safe: `store_subscriptions` cascades on user delete, so it cannot hold what the
    // purge must outlive — a failed Google cancellation retry, or a failed RevenueCat
    // erasure. Deliberately NO foreign key: the rider row is gone by the time these rows
    // do their job, and §6.5's minimisation rule forbids retaining a Tarmoto user id once
    // it is.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS store_deletion_obligations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(16) NOT NULL
          CONSTRAINT sdo_kind_check CHECK (kind IN ('cancellation','erasure')),
        -- Stamped when a deletion attempt is created and shared by every row it produces.
        -- What makes "the current set" expressible, so a retired row from an abandoned
        -- attempt cannot gate a later attempt's erasure forever.
        attempt_id UUID NOT NULL,
        attempt_outcome VARCHAR(16) NOT NULL DEFAULT 'running'
          CONSTRAINT sdo_attempt_outcome_check CHECK
            (attempt_outcome IN ('running','purged','abandoned')),
        -- Plain column, no FK, and NULLED BY THE PURGE. Carried only while the rider row
        -- exists so support can correlate before deletion.
        user_id UUID,
        -- Nullable for erasure, which names no chain — but constrained when present, like
        -- store_subscriptions.provider. Without it a Stripe or malformed provider can enter
        -- the durable retry ledger and stay actionable forever, since no supported store
        -- cancellation path can ever process it.
        --   (declared below with the other chain fields; see sdo_provider_check)
        -- The retained purchase_account_token. NULLED once erasure is confirmed — a NOT
        -- NULL column makes that update fail and either retains the erased rider's
        -- identifier forever or re-runs a completed erasure.
        app_user_id VARCHAR(255),
        provider VARCHAR(16)
          CONSTRAINT sdo_provider_check CHECK
            (provider IS NULL OR provider IN ('apple','google')),
        product_id VARCHAR(255),
        original_transaction_id VARCHAR(1024),
        target_key VARCHAR(1024),
        -- True while target_key holds an observed store transaction id rather than the
        -- stable original — the flag the enrichment merge keys off. Without it the writer
        -- cannot record which rows still need re-keying, and reading the documented column
        -- fails with 42703.
        target_key_provisional BOOLEAN NOT NULL DEFAULT FALSE,
        -- The CURRENT order id the v1 cancel takes. Refreshed before every attempt, since
        -- it advances on renewal; only meaningful while a cancellation is outstanding.
        store_transaction_id VARCHAR(1024),
        last_seen_active_at TIMESTAMPTZ,
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CONSTRAINT sdo_status_check CHECK
            (status IN ('pending','succeeded','failed','retired','support_only')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        -- False when enrichment could not obtain a stable id; pins retention to the
        -- maximum window, since an unverifiable record must fail towards keeping evidence.
        export_matchable BOOLEAN NOT NULL DEFAULT TRUE,
        -- Stamped when enrichment first becomes actionable (at the purge), NOT at row
        -- creation: the row is written at deletion request up to 30 days earlier, so a
        -- creation-anchored deadline is already expired at the first attempt.
        enrichment_deadline_at TIMESTAMPTZ,
        -- Stamped when an outstanding obligation is escalated. The outstanding sweep
        -- requires this to be NULL, so one permanent failure files one incident rather
        -- than one per tick.
        escalated_at TIMESTAMPTZ,
        retention_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,

        -- A cancellation names a chain; an erasure is per rider and names none. Without
        -- this the loosened column types would admit a cancellation row with no target.
        -- Symmetric on purpose. The erasure branch REQUIRES the chain fields to be null
        -- rather than merely not requiring them: a writer reusing a populated cancellation
        -- payload would otherwise leave billing identifiers in a purge-safe table about a
        -- rider who asked to be deleted, which is the one thing this table must not do.
        CONSTRAINT sdo_kind_fields_check CHECK (
          (kind = 'cancellation'
             AND provider IS NOT NULL
             AND product_id IS NOT NULL
             AND store_transaction_id IS NOT NULL
             AND target_key IS NOT NULL)
          OR (kind = 'erasure'
             AND provider IS NULL
             AND product_id IS NULL
             AND store_transaction_id IS NULL
             AND target_key IS NULL
             AND target_key_provisional = FALSE
             AND original_transaction_id IS NULL
             AND last_seen_active_at IS NULL)
        ),
        -- Hold the handle for as long as something still needs it: while actionable for
        -- either kind, AND while an unidentified support_only row still owes enrichment.
        -- A lost-webhook Apple row is support_only immediately, so an actionable-only rule
        -- would admit it without the one key that can match the export.
        CONSTRAINT sdo_handle_required_check CHECK (
          app_user_id IS NOT NULL
          OR (status NOT IN ('pending','failed')
              AND NOT (status = 'support_only'
                       AND export_matchable
                       AND original_transaction_id IS NULL))
        ),
        -- resolved_at IS NULL <=> status is actionable. The sweep indexes partition on
        -- exactly this column, so a status its timestamp disagrees with is invisible to
        -- one sweep and wrong in the other.
        CONSTRAINT sdo_resolved_at_check CHECK (
          (resolved_at IS NULL) = (status IN ('pending','failed'))
        ),
        -- The same staged-key invariant store_subscriptions carries, scoped to the kind that
        -- names a chain. A no-original-id obligation necessarily holds a per-renewal
        -- store_transaction_id in target_key and MUST be flagged provisional; marked stable
        -- it is invisible to enrichment, which keys on the flag, so duplicate obligations
        -- never merge and a failed duplicate keeps erasure blocked after its sibling has
        -- succeeded.
        --
        -- Scoped to cancellation deliberately: an erasure row has a null original id AND
        -- target_key_provisional = FALSE, which the biconditional alone would reject.
        -- The equality clause matters MORE here than on the chain table: this table's unique
        -- index is keyed on target_key, so a row that cleared the flag without re-keying is
        -- deduped under an id that still advances. A later observation keyed by the stable
        -- original inserts a second non-retired obligation, and if that duplicate fails it
        -- goes on gating erasure after its sibling has already succeeded.
        CONSTRAINT sdo_staged_key_check CHECK (
          kind <> 'cancellation'
          OR ((original_transaction_id IS NULL) = target_key_provisional
              AND (target_key_provisional
                   OR target_key = original_transaction_id))
        ),
        -- support_only means "no server-side cancel exists, so this will never be executed" —
        -- true ONLY of Apple. sdo_resolved_at_check then counts the row as resolved, so a
        -- Google cancellation in this state lets deletion gating proceed while the renewal
        -- is still live: the rider is purged and goes on being billed with no record left to
        -- act on. An erasure is likewise always executable, so it may never claim it either.
        CONSTRAINT sdo_support_only_check CHECK (
          status <> 'support_only'
          OR (kind = 'cancellation' AND provider = 'apple')
        ),
        -- ...and the converse: an Apple cancellation may never be ACTIONABLE. There is no
        -- server-side cancel to run, so a pending or failed Apple row can never resolve —
        -- it gates erasure indefinitely and holds app_user_id for exactly as long.
        --
        -- Deliberately NOT the literal reverse implication (apple cancellation =>
        -- support_only). A restore moves unresolved rows to retired, and a re-query that
        -- observes the subscription already ended resolves one succeeded; both are legal
        -- terminal states that the strict form would reject. What must be excluded is the
        -- actionable pair, which is the set sdo_resolved_at_check defines.
        CONSTRAINT sdo_apple_not_actionable_check CHECK (
          kind <> 'cancellation'
          OR provider <> 'apple'
          OR status NOT IN ('pending','failed')
        ),
        -- The purge is what makes enrichment actionable, and what must stamp its deadline —
        -- the column is null until then BY DESIGN, anchored here rather than on created_at
        -- because the row is written up to 30 days earlier and a creation-anchored deadline
        -- would already be overdue at the first attempt.
        --
        -- Left null at purge, a row that still awaits a stable id is unreachable: the sweep
        -- selects on enrichment_deadline_at <= now(), which NULL never satisfies, so
        -- erasure stays gated on it indefinitely. Tying the two together makes the purge
        -- write them in one statement rather than trusting it to remember.
        --
        -- The exemptions are the rows with nothing to wait for: an erasure names no chain,
        -- an identified row already has the id, and an unmatchable one is pinned to the
        -- maximum retention window instead of an extendable deadline.
        -- user_id is the PHASE DISCRIMINATOR, not merely a convenience: the retry protocol
        -- picks its locking path by whether it is still present, and the purge is the write
        -- that nulls it. Both halves of the biconditional are load-bearing.
        --
        -- A running attempt with a null user_id takes the POST-purge path and skips the
        -- account-deletion lock and its re-check, while a restore is still possible — so an
        -- irreversible cancellation can complete for a rider who has just come back.
        --
        -- A purged attempt still carrying one takes the PRE-purge path, which reads a User
        -- row that no longer exists, and retains the account link past deletion — the one
        -- thing this table's minimisation rule forbids.
        -- NOT a biconditional, which is the shape this wants to be and cannot: a rider who
        -- restores attempt A and later completes attempt B leaves A's rows abandoned but
        -- still carrying the user id. B's purge must clear THEM TOO, so the equality form
        -- either fails that update with 23514 or forces the purge to skip them — leaving the
        -- deleted rider's UUID in the purge-safe ledger, which is the leak this exists to
        -- stop.
        --
        -- So the rule is stated per outcome: running MUST have one, purged MUST NOT, and
        -- abandoned may go either way — populated while the rider lives, nulled once a later
        -- purge erases them. That is sound because an abandoned attempt is terminal
        -- (sdo_abandoned_not_actionable_check), so nothing retries against it and the
        -- phase discriminator is never consulted for its rows.
        CONSTRAINT sdo_purge_phase_check CHECK (
          (attempt_outcome = 'running' AND user_id IS NOT NULL)
          OR (attempt_outcome = 'purged' AND user_id IS NULL)
          OR attempt_outcome = 'abandoned'
        ),
        -- An abandoned attempt is one a restore ended, and the restore retires its
        -- unresolved rows. Constrained independently, a missed row stays pending: the
        -- retention sweep treats the attempt as finished while a null resolved_at keeps that
        -- row in the outstanding cohort, so obsolete cancellation work goes on retrying —
        -- or escalates to an operator — for a rider who came back.
        CONSTRAINT sdo_abandoned_not_actionable_check CHECK (
          attempt_outcome <> 'abandoned'
          OR status NOT IN ('pending','failed')
        ),
        -- Abandoning an attempt clears its handles, WHATEVER state its rows reached — the
        -- design states this per attempt rather than per status, and the succeeded row is
        -- why. A succeeded cancellation is never retired, it cannot be undone, and the
        -- restore retires the erasure row, so no later erasure will ever run to clear the
        -- handle: the record would hold a subscriber identifier until retention cleanup for
        -- a rider who is no longer being deleted.
        --
        -- export_matchable rides along because the two are one write. A support_only row
        -- with no stable id still OWES enrichment under sdo_handle_required_check, so
        -- clearing the handle alone would be rejected; abandonment cancels that obligation,
        -- since an abandoned attempt is not erasing and has nothing left to match for.
        CONSTRAINT sdo_abandoned_handle_check CHECK (
          attempt_outcome <> 'abandoned'
          OR (app_user_id IS NULL AND NOT export_matchable)
        ),
        -- Erasure waits for the PURGE, and this is the half of that rule the schema can
        -- state. The two kinds are on different clocks deliberately: cancellation runs at
        -- deletion REQUEST, because the rider is locked out immediately and waiting would
        -- bill them for an account they cannot use, while erasure is finalisation and
        -- IRREVERSIBLE. A succeeded erasure on a still-running attempt means the subscriber
        -- was destroyed while the deletion could still be restored — for a rider who may
        -- come back tomorrow and whose data cannot be brought back with them.
        --
        -- Pending is the only state a running erasure has: it is not attempted before the
        -- purge, so it can neither fail nor succeed, and retirement belongs to the restore
        -- path, which makes the attempt abandoned rather than leaving it running.
        CONSTRAINT sdo_erasure_awaits_purge_check CHECK (
          kind <> 'erasure'
          OR attempt_outcome <> 'running'
          OR status = 'pending'
        ),
        -- Confirmed erasure is the documented clearing trigger for the handle, and the
        -- handle rule above only PERMITS null once a row is non-actionable rather than
        -- requiring it. So a succeeded erasure could keep the RevenueCat subscriber
        -- identifier until the retention sweep — holding it after the one operation it
        -- exists to address has completed, for a rider who has been erased.
        CONSTRAINT sdo_erasure_handle_cleared_check CHECK (
          kind <> 'erasure'
          OR status <> 'succeeded'
          OR app_user_id IS NULL
        ),
        CONSTRAINT sdo_purged_enrichment_deadline_check CHECK (
          attempt_outcome <> 'purged'
          OR kind <> 'cancellation'
          OR enrichment_deadline_at IS NOT NULL
          OR original_transaction_id IS NOT NULL
          OR NOT export_matchable
        ),
        -- The other half of the same invariant: null BEFORE the purge, not merely present
        -- after it. Initialised at deletion request the deadline is anchored ~30 days too
        -- early, so it is already overdue the moment purge makes enrichment actionable —
        -- the first attempt marks the row unmatchable and erases the only handle that could
        -- have matched the export, without ever waiting the export cycle it promises.
        --
        -- Scoped to running rather than "not purged", for the reason the phase check is:
        -- abandoned is terminal and its rows are nobody's to re-stamp, so forbidding a value
        -- there would constrain a state no writer is defined to produce and could reject a
        -- legitimate write later. The harm is specific to a deadline set at REQUEST time,
        -- and at request time the attempt is running.
        CONSTRAINT sdo_running_no_deadline_check CHECK (
          attempt_outcome <> 'running'
          OR enrichment_deadline_at IS NULL
        )
      );
    `);

    // Unresolved obligations are unique per target within an attempt. `status <> 'retired'`
    // rather than the actionable states: a row dropping out of the index the moment it
    // SUCCEEDS lets a later claim insert a second obligation for the same target, and a
    // failed duplicate then blocks erasure for work already done.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_sdo_cancellation_target;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sdo_cancellation_target
        ON store_deletion_obligations (attempt_id, provider, target_key)
        WHERE kind = 'cancellation' AND status <> 'retired';
    `);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_sdo_erasure_attempt;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sdo_erasure_attempt
        ON store_deletion_obligations (attempt_id)
        WHERE kind = 'erasure' AND status <> 'retired';
    `);
    // Retention cleanup and escalation are two cohorts at the same deadline. One partial
    // index without the other means the sweep either scans the table or never escalates.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sdo_retention_resolved;`,
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdo_retention_resolved
        ON store_deletion_obligations (retention_expires_at)
        WHERE resolved_at IS NOT NULL;
    `);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sdo_retention_outstanding;`,
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdo_retention_outstanding
        ON store_deletion_obligations (retention_expires_at)
        WHERE resolved_at IS NULL AND escalated_at IS NULL;
    `);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sdo_attempt;`,
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdo_attempt
        ON store_deletion_obligations (attempt_id);
    `);

    // ------------------------------------------------------------ the rollup
    // The store side rolled up onto the rider, so `resolveEntitledTier` stays SYNCHRONOUS
    // and no feature check gains a query. This is a tier aggregate, not the retired
    // identity slot: `store_subscriptions` remains the source of truth for identity,
    // lifecycle and periods.
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS store_subscription_tier VARCHAR(16);
    `);
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS store_subscription_tier_expires_at TIMESTAMPTZ;
    `);
    // Enforce the pairing rather than trusting writers: a tier stored without an expiry is
    // never invalidated by the resolver's time comparison and cannot be selected by the
    // sweep, so paid access persists indefinitely.
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_store_rollup_paired_check;
    `);
    // NOT VALID, then VALIDATE as a separate statement. A plain ADD CONSTRAINT scans every
    // existing row to validate it WHILE HOLDING ACCESS EXCLUSIVE, which blocks all reads and
    // writes on the most contended table in the schema — the exact cost this migration pays
    // `CREATE INDEX CONCURRENTLY` to avoid a few statements earlier, so doing it here would
    // be inconsistent with its own stated reasoning.
    //
    // NOT VALID still takes ACCESS EXCLUSIVE, but only long enough to write the catalog
    // entry; it does not scan. VALIDATE then does the scan under SHARE UPDATE EXCLUSIVE,
    // which readers and writers do not block on. New rows are checked from the moment the
    // constraint exists either way, so nothing is unguarded in between.
    await queryRunner.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_store_rollup_paired_check CHECK (
          store_subscription_tier IS NULL
          OR store_subscription_tier_expires_at IS NOT NULL
        ) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE users VALIDATE CONSTRAINT users_store_rollup_paired_check;
    `);
    // Same vocabulary as the chains it summarises, for the same reason — and NULL is how
    // "no store entitlement" is spelled here, so storing 'free' would be a second encoding
    // of it that every reader would have to know about.
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_store_rollup_tier_check;
    `);
    // Same treatment, and the reason it matters twice: back to back, two validating
    // ADD CONSTRAINTs scan the table twice under the exclusive lock.
    await queryRunner.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_store_rollup_tier_check CHECK (
          store_subscription_tier IS NULL
          OR store_subscription_tier IN ('pro','premium')
        ) NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE users VALIDATE CONSTRAINT users_store_rollup_tier_check;
    `);
    // Partial on the TIER being present, not on the expiry: keyed on the expiry, a row
    // that violated the pairing would be invisible to the very sweep meant to fix it. Also
    // keeps the index off the overwhelming majority of rows, which have no store side.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_users_store_rollup_expiry;`,
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_store_rollup_expiry
        ON users (store_subscription_tier_expires_at)
        WHERE store_subscription_tier IS NOT NULL;
    `);

    // ------------------------------------------------- overlaps on the ledger
    for (const column of [
      'overlap_pair_low VARCHAR(1100)',
      'overlap_pair_high VARCHAR(1100)',
      'overlap_older_member VARCHAR(1100)',
      'escalate_after TIMESTAMPTZ',
    ]) {
      await queryRunner.query(`
        ALTER TABLE store_billing_reconciliations
          ADD COLUMN IF NOT EXISTS ${column};
      `);
    }

    // Both halves of a pair, or neither. Independently nullable, a row with a low member and
    // a null high member is accepted — and PostgreSQL's null uniqueness semantics then allow
    // UNLIMITED copies of it, bypassing the pairwise dedup entirely and leaving a work item
    // that can neither re-query nor retire its second source.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_complete_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_overlap_pair_complete_check CHECK (
          (overlap_pair_low IS NULL) = (overlap_pair_high IS NULL)
        );
    `);

    // A provisional row IS the pair machinery — the status exists for nothing else. Without
    // its two identities the escalation sweep still selects it (that index is keyed on
    // status = 'provisional' alone), but the worker cannot re-query either source, cannot
    // retire on either, and cannot promote: an item that is permanently selected and
    // permanently unactionable, which no amount of retrying drains.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_pair_required_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_provisional_pair_required_check CHECK (
          status <> 'provisional' OR overlap_pair_low IS NOT NULL
        );
    `);

    // The pair is UNORDERED, so its key only dedups if the encoding is canonical. Nothing
    // above forces that: written (B, A) instead of (A, B), the row is a distinct key to
    // uq_sbr_unresolved_overlap_pair and one billing overlap becomes two unresolved rows —
    // two escalations, and a refund path asked to settle the same duplicate twice.
    //
    // COLLATE "C" is load-bearing. The writer sorts in JS, which compares code units, while
    // a varchar comparison uses the database collation: under a locale collation punctuation
    // and case sort differently, so identifiers separated by the ':' provider qualifier can
    // order one way in the writer and the other way here. That disagreement rejects rows the
    // writer canonicalised correctly. Byte ordering is the rule the design states, and this
    // is how to say it in SQL.
    //
    // Exempt at 'retired' deliberately. Re-keying X to O rewrites every pair containing X,
    // which turns the pair (X, O) into the self-pair (O, O) that step 2 retires outright. A
    // bare strict comparison fails that atomic re-key with 23514 — leaving the self-pair
    // live and escalating a rider for overlapping themselves, the precise failure the
    // status vocabulary was widened to avoid.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_order_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_overlap_pair_order_check CHECK (
          overlap_pair_low IS NULL
          OR status = 'retired'
          OR overlap_pair_low COLLATE "C" < overlap_pair_high COLLATE "C"
        );
    `);

    // Members are provider-QUALIFIED by contract, and every consumer decodes them on that
    // assumption. Nothing above looks inside the string: completeness, ordering and
    // uniqueness all accept a bare or misprefixed identity, and the row then reaches the
    // deadline worker as a source it cannot decode or re-query — provisional forever, in a
    // shape no retry fixes.
    //
    // The qualifier is not decoration either: store identifiers are unique only WITHIN a
    // provider, so an unqualified member can collide with a different provider's pair and
    // silently merge two unrelated overlaps.
    //
    // overlap_older_member needs no format rule of its own — it is already constrained to
    // be null or one of these two, so it inherits this one.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_format_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_overlap_pair_format_check CHECK (
          overlap_pair_low IS NULL
          OR (overlap_pair_low ~ '^(stripe|apple|google):.+'
              AND overlap_pair_high ~ '^(stripe|apple|google):.+')
        );
    `);

    // The refund ROLE must name a member of its own pair. Unconstrained, a re-key that
    // rewrites the pair but not the role leaves it pointing at a retired identity, and the
    // refund workflow cannot resolve the member it was told to settle — a genuine duplicate
    // billing stuck behind a dangling pointer.
    //
    // The IS NOT NULL guard is not redundant: `x IN (NULL, NULL)` evaluates to NULL, which a
    // CHECK accepts, so without it a role on a row carrying NO pair would pass unnoticed.
    // NULL stays legal throughout — it is how an ambiguous refund target is recorded when
    // the store chronology cannot decide one.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_older_member_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_overlap_older_member_check CHECK (
          overlap_older_member IS NULL
          OR (overlap_pair_low IS NOT NULL
              AND overlap_older_member IN (overlap_pair_low, overlap_pair_high))
        );
    `);

    // Reason and status are separately valid and jointly meaningless in two combinations,
    // because the vocabulary is a PROMOTION: provisional_overlap on creation, becoming
    // exclusivity_conflict when escalated.
    //
    //  - provisional_overlap + open puts an unconfirmed overlap straight in front of an
    //    operator, which is what the provisional status exists to avoid — the refund path
    //    then acts on a duplicate that may not be one.
    //  - any other reason + provisional is selected by the overlap deadline sweep and routed
    //    through pair reconciliation, which is machinery its reason knows nothing about.
    //
    // Stated as two implications rather than a status allowlist so that retiring or
    // resolving a provisional_overlap row stays writable — only the unpromoted OPEN state
    // is wrong.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_reason_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_provisional_reason_status_check CHECK (
          (status <> 'provisional' OR reason = 'provisional_overlap')
          AND (reason <> 'provisional_overlap' OR status <> 'open')
        );
    `);

    // A provisional row without a deadline is never swept: `escalate_after <= now()` cannot
    // select NULL, so the overlap sits unresolved forever — the never-fires hole the durable
    // deadline exists to close, reintroduced by a nullable column.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_deadline_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_provisional_deadline_check CHECK (
          status <> 'provisional' OR escalate_after IS NOT NULL
        );
    `);

    // Widen the vocabulary. Enumerated from the LIVE schema: migration 1825 already added
    // `unrecognized_product`, so recreating from 1822's three values would silently drop
    // it and make the existing insert fail with 23514.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_reason_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_reason_check CHECK (reason IN (
          'ineligible_trial_rejected',
          'exclusivity_conflict',
          'deletion_cancel_failed',
          'unrecognized_product',
          'provisional_overlap',
          'ownership_conflict'
        ));
    `);
    // `retired` as well as `provisional`: the pair re-key and the self-pair collapse both
    // write it, so widening for `provisional` alone fails the atomic re-key with 23514 and
    // leaves the duplicate in place.
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_status_check CHECK (
          status IN ('open','resolved','provisional','retired')
        );
    `);

    // Re-scope the legacy Apple dedup index. It keys one OPEN Apple reconciliation per
    // (otid, reason) and predates pairwise overlaps: an Apple source overlapping both
    // Stripe and Google promotes two rows sharing that OTID and reason, and the second
    // fails 23505 — silently losing a real double-billing case on the escalation path.
    //
    // Narrowed by STRUCTURE (`overlap_pair_low IS NULL`), not by reason vocabulary.
    //
    // Excluding reasons was the wrong axis: `StoreReconciliationService.openConflict` still
    // emits LEGACY Apple `exclusivity_conflict` rows with null pair columns and relies on
    // this index for race-safe dedup, so a reason-based exclusion silently removes that
    // protection — and `uq_sbr_unresolved_overlap_pair` cannot take over, because its own
    // predicate requires the pair columns to be present.
    //
    // Keying on "is this a pair row?" keeps every legacy row deduped exactly as before while
    // letting pairwise rows — which necessarily carry pair columns — out of an index whose
    // unit of uniqueness they do not match.
    // BUILD FIRST, then swap. This is the one index here whose absence costs correctness
    // rather than speed: `openConflict` is a check-then-insert that treats a 23505 from
    // THIS index as "the other validation won", so dropping it first leaves a window — the
    // whole duration of a concurrent build — in which two racing Apple opens both commit.
    //
    // And the damage does not stop at a duplicate row. The very next statement is the
    // unique build, which then FAILS on the duplicates it just allowed — in a migration
    // that deliberately runs outside a transaction, so there is no rollback and a re-run
    // cannot converge until someone deletes rows by hand. Every other index here is either
    // new, on a new table, or non-unique, so the plain drop-then-create is fine for them.
    //
    // Re-run safety: interrupted after the build, the temp index survives, the DROP is a
    // no-op and the RENAME completes; interrupted after the rename, the build recreates a
    // temp copy and the swap repeats. Wasteful in that last case, never wrong.
    // An interrupted CREATE INDEX CONCURRENTLY leaves the index behind marked INVALID, and
    // `IF NOT EXISTS` only checks that the NAME is taken — so a retry would skip the build,
    // drop the valid legacy index, and rename the invalid one into its place. The migration
    // then records success while `openConflict` has no working guard, which is worse than
    // the failure it replaced because nothing reports it.
    //
    // Every OTHER concurrent build here is immune already: each is preceded by a
    // `DROP INDEX CONCURRENTLY IF EXISTS` of the same name, which removes an invalid
    // leftover before rebuilding. This swap is the one place that pattern had to be given
    // up — dropping first is exactly what it exists to avoid — so it needs the check
    // spelled out instead.
    const invalidTemp = (await queryRunner.query(`
      SELECT 1 FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = 'uq_sbr_open_apple_otid_reason_new'
         AND NOT i.indisvalid;
    `)) as unknown[];
    if (invalidTemp.length > 0) {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS uq_sbr_open_apple_otid_reason_new;`,
      );
    }
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sbr_open_apple_otid_reason_new
        ON store_billing_reconciliations (apple_original_transaction_id, reason)
        WHERE status = 'open'
          AND apple_original_transaction_id IS NOT NULL
          AND overlap_pair_low IS NULL;
    `);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_sbr_open_apple_otid_reason;`,
    );
    await queryRunner.query(`
      ALTER INDEX IF EXISTS uq_sbr_open_apple_otid_reason_new
        RENAME TO uq_sbr_open_apple_otid_reason;
    `);

    // One UNRESOLVED row per pair. Keyed on the unordered pair, and NOT including `reason`:
    // promotion rewrites it, so a reason-scoped key stops deduping exactly when it starts
    // mattering and a later event inserts a second provisional row beside the open one.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS uq_sbr_unresolved_overlap_pair;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sbr_unresolved_overlap_pair
        ON store_billing_reconciliations (user_id, overlap_pair_low, overlap_pair_high)
        WHERE status IN ('open','provisional')
          AND overlap_pair_low IS NOT NULL;
    `);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sbr_provisional_escalate_after;`,
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sbr_provisional_escalate_after
        ON store_billing_reconciliations (escalate_after)
        WHERE status = 'provisional';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // NOT `DROP INDEX CONCURRENTLY` here, deliberately, even though `up` builds
    // concurrently. TypeORM honours `transaction = false` only on the up path:
    // `undoLastMigration` starts a transaction whenever the executor-level mode is not
    // `"none"` and never consults the per-migration flag (typeorm 0.3.28). Since this
    // project sets `migrationsTransactionMode: 'each'`, a `CONCURRENTLY` statement in a
    // `down` ALWAYS fails with "cannot run inside a transaction block". Verified against
    // PostgreSQL 16 by migration 1831, not inferred.
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_sbr_provisional_escalate_after;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_sbr_unresolved_overlap_pair;`,
    );

    // Clear pairwise rows FIRST. Once the follow-up writers exist this table can hold
    // reconciliations the pre-migration schema cannot represent, and each blocks a different
    // step below: two open Apple pair rows share `(otid, exclusivity_conflict)` and raise
    // `23505` on the legacy index, while a single `provisional` or `retired` row makes the
    // narrowed status CHECK unaddable.
    //
    // This DELETES data, which a `down` normally should not. It is the right trade here: the
    // rows are pair-shaped reconciliations whose columns this migration is about to drop, so
    // they cannot survive the rollback in any form — and a `down` that cannot run is worse
    // than one that is explicit about what it discards.
    await queryRunner.query(`
      DELETE FROM store_billing_reconciliations
        WHERE overlap_pair_low IS NOT NULL
           OR status IN ('provisional','retired')
           OR reason IN ('provisional_overlap','ownership_conflict');
    `);

    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_deadline_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_complete_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_order_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_older_member_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_pair_required_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_overlap_pair_format_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_provisional_reason_status_check;
    `);

    // Restore the legacy Apple index to its pre-widening scope. The temp name is dropped
    // too, in case down() runs after an up() that failed between the build and the rename.
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_sbr_open_apple_otid_reason_new;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_sbr_open_apple_otid_reason;`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sbr_open_apple_otid_reason
        ON store_billing_reconciliations (apple_original_transaction_id, reason)
        WHERE status = 'open' AND apple_original_transaction_id IS NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_status_check CHECK (status IN ('open','resolved'));
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        DROP CONSTRAINT IF EXISTS sbr_reason_check;
    `);
    await queryRunner.query(`
      ALTER TABLE store_billing_reconciliations
        ADD CONSTRAINT sbr_reason_check CHECK (reason IN (
          'ineligible_trial_rejected',
          'exclusivity_conflict',
          'deletion_cancel_failed',
          'unrecognized_product'
        ));
    `);

    for (const column of [
      'escalate_after',
      'overlap_older_member',
      'overlap_pair_high',
      'overlap_pair_low',
    ]) {
      await queryRunner.query(`
        ALTER TABLE store_billing_reconciliations DROP COLUMN IF EXISTS ${column};
      `);
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_users_store_rollup_expiry;`,
    );
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_store_rollup_paired_check;
    `);
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_store_rollup_tier_check;
    `);
    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS store_subscription_tier_expires_at;
    `);
    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS store_subscription_tier;
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS store_deletion_obligations;`);
    await queryRunner.query(`DROP TABLE IF EXISTS store_subscriptions;`);
  }
}
