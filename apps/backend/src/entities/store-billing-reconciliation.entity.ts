import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Durable work items for store-billing states that can't be resolved
 * synchronously inside a webhook or request handler: a rejected ineligible
 * trial, a cross-provider (Stripe/Apple/Google) exclusivity conflict, or a
 * cancellation that failed to reach the store during account deletion. Ops
 * or a follow-up job drains `status = 'open'` rows and records how each was
 * resolved.
 */
@Entity('store_billing_reconciliations')
@Index('idx_sbr_status_reason', ['status', 'reason'])
@Index('idx_sbr_user', ['user_id'])
// Race-safe dedup: at most one OPEN Apple reconciliation per
// (original transaction id, reason). Partial + Apple-specific, so the Stripe
// path is unaffected. Enforced by migration 1823 (`uq_sbr_open_apple_otid_reason`).
// RE-SCOPED for pairwise overlaps (migration 1837). It assumes one open Apple
// reconciliation per identity, which is false once overlaps are pairs: an Apple source
// overlapping BOTH Stripe and Google promotes two rows sharing that OTID and reason, and
// the second fails `23505` — silently losing a real double-billing case on the escalation
// path, which is the worst place for a silent loss.
@Index(
  'uq_sbr_open_apple_otid_reason',
  ['apple_original_transaction_id', 'reason'],
  {
    unique: true,
    where:
      "status = 'open' AND apple_original_transaction_id IS NOT NULL " +
      'AND reason NOT IN ' +
      "('provisional_overlap','exclusivity_conflict','ownership_conflict')",
  },
)
// One UNRESOLVED row per pair. Deliberately excludes `reason`, which is MUTABLE — promotion
// rewrites `provisional_overlap` to `exclusivity_conflict`, so a reason-scoped key stops
// deduping exactly when it starts mattering and a later event inserts a second provisional
// row beside the open one.
@Index(
  'uq_sbr_unresolved_overlap_pair',
  ['user_id', 'overlap_pair_low', 'overlap_pair_high'],
  {
    unique: true,
    where: "status IN ('open','provisional') AND overlap_pair_low IS NOT NULL",
  },
)
@Index('idx_sbr_provisional_escalate_after', ['escalate_after'], {
  where: "status = 'provisional'",
})
export class StoreBillingReconciliation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: 'stripe' | 'apple' | 'google';

  @Column({ type: 'varchar', length: 255, nullable: true })
  apple_original_transaction_id!: string | null;

  /**
   * RevenueCat's `original_transaction_id` for the Play subscription this row is
   * about — the identifier stable across the subscription's lifetime, matching
   * `users.google_original_transaction_id`. See that column's doc for why the
   * per-renewal `store_transaction_id` is not used.
   */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  google_original_transaction_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripe_subscription_id!: string | null;

  @Column({ type: 'varchar', length: 48 })
  reason!:
    | 'ineligible_trial_rejected'
    | 'exclusivity_conflict'
    | 'deletion_cancel_failed'
    // An ACTIVE (still-charging) Apple subscription whose product is absent from
    // `IAP_PRODUCTS`: the rider keeps renewing without entitlement and Apple has
    // no server-side cancel API, so ops needs a durable record. Enforced by
    // migration 1825 (extends the `sbr_reason_check` constraint).
    | 'unrecognized_product'
    // A rider observed holding two FUTURE-BILLING sources. Opened as `provisional`, not as
    // operator work: at first observation this design cannot tell a legitimate Play plan
    // replacement (which leaves chain A live until its terminal) from an independent
    // duplicate, and firing here would queue EVERY upgrade for refund. Promoted to
    // `exclusivity_conflict` only once the overlap is confirmed to survive.
    | 'provisional_overlap'
    // Enrichment resolved one rider's provisional key to an identity ALREADY HELD BY
    // ANOTHER rider. Deliberately not `exclusivity_conflict`: routing another rider's
    // identity into the refund-oriented overlap workflow is the unsafe action this branch
    // exists to avoid. Operator-only — no refund, no cancellation, no entitlement change,
    // because the design cannot know which rider is the rightful owner and a wrong guess
    // moves a paid subscription between people.
    | 'ownership_conflict';

  /**
   * `provisional` is an overlap that has been RECORDED but not escalated — durable enough
   * to re-evaluate, and deliberately NOT an operator item, so it must be excluded from
   * every open-item query and count. `retired` is written by the pair re-key and the
   * self-pair collapse; widening for `provisional` alone fails the atomic re-key with
   * `23514` and leaves the duplicate in place.
   */
  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: 'open' | 'resolved' | 'provisional' | 'retired';

  /**
   * How the row was closed. The first four are the ORIGINAL outcomes — an
   * operator or the retry worker acted on the work item. The last four are
   * RETIREMENT outcomes (migration 1834): the row was invalidated by later state
   * rather than actioned, and closing it is what stops an operator refunding or
   * revoking a subscription that has since become valid.
   *
   * Kept as four distinct retirement values rather than one, because they answer
   * different operational questions — a rising `claimed_on_drain` rate means
   * webhooks are failing to land, which `superseded_by_claim` would hide.
   *
   * No `resolved_` prefix, matching the original four: `status` already says
   * `resolved`, so it would be redundant on a column only ever non-NULL on
   * resolved rows.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  resolution!:
    | 'rider_canceled'
    | 'refunded'
    | 'expired'
    | 'server_canceled'
    // Retirement outcomes — see §4 step 6 of the RevenueCat design spec.
    | 'superseded_by_claim'
    | 'claimed_on_drain'
    | 'stale_on_drain'
    | 'purchase_inactive'
    | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  /**
   * The overlapping pair, as an UNORDERED pair of provider-qualified identities
   * (`<provider>:<identity>`), assigned low/high by byte-wise comparison of the encoded
   * strings.
   *
   * Provider-qualification is load-bearing: store identifiers are unique only WITHIN a
   * provider, so bare ids could map an Apple/Google pair onto the same key as a different
   * pair and silently merge two unrelated overlaps. The identity is the chain's
   * `target_key`, not its `original_transaction_id` — an unidentified chain has none, and a
   * pair built on it could not be constructed at all.
   */
  @Column({ type: 'varchar', length: 1100, nullable: true })
  overlap_pair_low!: string | null;

  @Column({ type: 'varchar', length: 1100, nullable: true })
  overlap_pair_high!: string | null;

  /**
   * Which member the STORE says was purchased first — the refund target.
   *
   * Byte-sorting the pair preserves both identities and destroys the role, and it cannot be
   * re-derived: chains have `created_at`, but the Stripe side has no subscription-created
   * timestamp. NULL is the AMBIGUITY sentinel — set where a purchase time is unavailable
   * for either member, or the two are EQUAL (Stripe's `created` has second granularity).
   * Readers must treat NULL as "do not infer a target" and surface it as unknown, never
   * backfill it from ingestion order.
   */
  @Column({ type: 'varchar', length: 1100, nullable: true })
  overlap_older_member!: string | null;

  /**
   * When a `provisional` overlap stops waiting and escalates.
   *
   * The minimum of both members' EFFECTIVE period ends plus a grace margin, substituting
   * the bounded fallback for each null member — not the earliest non-null end, which leaves
   * a null-period source paired with an annual one unchecked for most of a year. NOT NULL
   * by construction on provisional rows: a null deadline is never swept, which is the
   * never-fires hole the durable deadline exists to close.
   *
   * The deadline is a prompt to CHECK, not a verdict: the sweep re-queries both members and
   * escalates only on confirmation that both are still billing.
   */
  @Column({ type: 'timestamptz', nullable: true })
  escalate_after!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;
}
