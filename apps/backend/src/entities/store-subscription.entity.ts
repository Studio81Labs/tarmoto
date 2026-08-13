import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { SubscriptionTier } from '@tarmoto/shared';

/**
 * One row per (rider, store subscription chain) — the storage this design exists for.
 *
 * A rider used to hold exactly one chain per provider, in
 * `users.apple_original_transaction_id` / `users.google_original_transaction_id`, and
 * `claimForGoogle`'s identity guard was equality-only. RevenueCat confirmed that a Google
 * Play base-plan change **rebases** `original_transaction_id`, so that guard rejects a
 * legitimate upgrade — and it never prevented the double-billing it was written for, since
 * refusing to record a second subscription does not stop the store charging for it.
 *
 * Entitlement is now the max over LIVE chains (rolled up onto `users` so the resolver stays
 * synchronous), and an overlap is detected and reconciled rather than refused.
 *
 * Design: `docs/superpowers/specs/2026-08-12-store-subscription-chains-design.md`.
 */
@Entity('store_subscriptions')
// PRIMARY cross-rider guard: a chain belongs to exactly one rider. Keyed on `target_key`,
// not `original_transaction_id` — the latter is NULL for every chain created by the
// deletion enumeration or restore, and PostgreSQL treats NULLs as distinct, so an
// identity-keyed guard would not constrain them at all.
@Index('uq_ss_provider_target_key', ['provider', 'target_key'], {
  unique: true,
})
// SECONDARY, where non-null: still worth enforcing once the stable id is known.
@Index('uq_ss_provider_original_txn', ['provider', 'original_transaction_id'], {
  unique: true,
  where: 'original_transaction_id IS NOT NULL',
})
@Index('idx_ss_user', ['user_id'])
export class StoreSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Cascades on user delete — this is live entitlement state, not a support record. */
  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: 'apple' | 'google';

  /**
   * RevenueCat's `original_transaction_id` — stable for the chain's whole life.
   *
   * NULLABLE: the subscriber response carries no original transaction id (open item (b)),
   * so a chain discovered by the deletion enumeration or recreated on restore exists
   * before its stable id is known. A NOT NULL column would abort that insert and leave a
   * rider free while still being billed. Enrichment fills it from the Scheduled Data
   * Export, which does carry it.
   */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  original_transaction_id!: string | null;

  /**
   * The identity actually used for dedup, pairing and matching — a STAGED key.
   *
   * `original_transaction_id` once known, otherwise the observed `store_transaction_id` as
   * a provisional value. Staged because **no identifier stable across renewals is
   * available on both discovery paths**: the original id is stable but the enumeration
   * frequently cannot obtain it, while the store id is always available and advances on
   * every renewal.
   *
   * Enrichment re-keys this to the original and MERGES any row of the SAME rider that
   * resolves to it. A cross-rider collision is never a merge — it raises an ownership
   * conflict, because merging across riders would transfer a paid subscription between
   * people.
   */
  @Column({ type: 'varchar', length: 1024 })
  target_key!: string;

  /** True while {@link target_key} holds an observed id rather than the stable original. */
  @Column({ type: 'boolean', default: false })
  target_key_provisional!: boolean;

  /** RevenueCat's product identifier — the (b) correlation key on re-query. */
  @Column({ type: 'varchar', length: 255 })
  product_id!: string;

  /**
   * The store's own chronology, which decides the overlap refund target.
   *
   * Ingestion order cannot: an older subscription whose webhook was lost and later
   * recovered by the export arrives AFTER the newer one, so "whichever was already local"
   * inverts exactly when repair happens — pointing an operator at the rider's intended
   * newer plan. Where this is unavailable for either member, or the two are EQUAL (Stripe's
   * `created` has second granularity), the refund target is recorded ambiguous rather than
   * guessed.
   */
  @Column({ type: 'timestamptz', nullable: true })
  original_purchase_date!: Date | null;

  /** What this chain entitles. Entitlement is the max over live chains, not this alone. */
  @Column({ type: 'varchar', length: 16 })
  tier!: SubscriptionTier;

  /**
   * Store lifecycle status.
   *
   * Note this does NOT decide entitlement on its own — see {@link current_period_end}.
   * `past_due` entitles (billing retry), and `canceled` entitles until the period ends.
   */
  @Column({ type: 'varchar', length: 16 })
  status!: 'active' | 'trialing' | 'past_due' | 'canceled';

  /**
   * The period the rider has paid for, and the thing entitlement is actually derived from.
   *
   * A status allowlist is the natural mistake and revokes access the instant a rider
   * cancels, from a period they already paid for. Immediate revocation (refund, store
   * revocation) is expressed by TRUNCATING this to the revocation instant, so one
   * predicate covers both endings.
   *
   * NULL means "no known end" and is bounded by the fallback window rather than treated as
   * expired — the same bound the rollup expiry and `futureBilling` use, so all three agree
   * by construction.
   */
  @Column({ type: 'timestamptz', nullable: true })
  current_period_end!: Date | null;

  @Column({ type: 'boolean', default: false })
  cancel_at_period_end!: boolean;

  /**
   * The read-ordering key (`request_date_ms`), now PER CHAIN.
   *
   * Shared at rider level it lets an event for chain B advance the value a later-but-valid
   * event for chain A is then checked against — silently dropping it as stale. That is a
   * live bug in the pre-chain code with no test; per-chain ordering removes the class.
   */
  @Column({ type: 'timestamptz' })
  store_signed_date!: Date;

  /**
   * Stamped from the per-rider lock token; guards stay `lock_fence <= :token`.
   *
   * The transformer is required, not stylistic: node-postgres returns `bigint` as a STRING,
   * so without it this property breaks its own type and every fencing comparison becomes a
   * string operation — `"10"` increments to `"101"`, and `"9" <= "10"` is FALSE, which lets
   * a stale flow's guard pass. That is the exact failure the fence exists to prevent.
   * Mirrors `User.subscription_lock_fence`, whose token this stores.
   */
  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  lock_fence!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
