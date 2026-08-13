import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Purge-safe work that must OUTLIVE the rider row: stopping a Google renewal, and erasing
 * the RevenueCat subscriber.
 *
 * `store_subscriptions` cascades on user delete, so it cannot hold either — the purge would
 * remove the very rows listing what still needs doing. This table therefore has **no
 * foreign key** and is minimised: it is a record about someone who asked to be erased.
 *
 * Two kinds, on different clocks. **Cancellation** executes at deletion REQUEST, because
 * `deleted_at` locks the rider out immediately and waiting would charge them for an account
 * they cannot use. **Erasure** waits for the PURGE, because it is finalisation and
 * irreversible — erasing while the deletion is still reversible destroys data for a rider
 * who may restore tomorrow.
 *
 * Design: `docs/superpowers/specs/2026-08-12-store-subscription-chains-design.md`.
 */
@Entity('store_deletion_obligations')
// One unresolved obligation per target within an attempt. `status <> 'retired'` rather than
// the actionable states: a row dropping out of the index the moment it SUCCEEDS lets a
// later claim insert a second obligation for the same target, and a failed duplicate then
// blocks erasure for work already done.
@Index('uq_sdo_cancellation_target', ['attempt_id', 'provider', 'target_key'], {
  unique: true,
  where: "kind = 'cancellation' AND status <> 'retired'",
})
@Index('uq_sdo_erasure_attempt', ['attempt_id'], {
  unique: true,
  where: "kind = 'erasure' AND status <> 'retired'",
})
// Two cohorts at the same deadline. One index without the other means the sweep either
// scans the table to find outstanding rows or never escalates them at all.
@Index('idx_sdo_retention_resolved', ['retention_expires_at'], {
  where: 'resolved_at IS NOT NULL',
})
@Index('idx_sdo_retention_outstanding', ['retention_expires_at'], {
  where: 'resolved_at IS NULL AND escalated_at IS NULL',
})
@Index('idx_sdo_attempt', ['attempt_id'])
export class StoreDeletionObligation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `cancellation` is per still-live chain; `erasure` is per rider. */
  @Column({ type: 'varchar', length: 16 })
  kind!: 'cancellation' | 'erasure';

  /**
   * Stamped when a deletion attempt is created, shared by every row it produces.
   *
   * What makes "the current set" expressible. Without it, a `retired` cancellation from an
   * abandoned attempt can never become `succeeded`, so a later attempt's erasure waits on
   * it **forever** — even after the new cancellation succeeds.
   */
  @Column({ type: 'uuid' })
  attempt_id!: string;

  /**
   * How the attempt ended. Read by the retention sweep, which must distinguish an attempt
   * still in its grace period from an abandoned one — an abandoned attempt never purges,
   * so a purge-gated sweep would retain its rows forever.
   */
  @Column({ type: 'varchar', length: 16, default: 'running' })
  attempt_outcome!: 'running' | 'purged' | 'abandoned';

  /**
   * Plain column, **no foreign key**, and **NULLED BY THE PURGE**.
   *
   * §6.5's minimisation rule is explicit: no Tarmoto user id once the row is gone. It is
   * carried only while the rider row still exists, so support and admin can correlate
   * before deletion.
   */
  @Column({ type: 'uuid', nullable: true })
  user_id!: string | null;

  /**
   * The retained `purchase_account_token` — the only handle that addresses the v1 cancel
   * and matches the Scheduled Data Export.
   *
   * NULLED once erasure is confirmed, which is why it must be nullable: a NOT NULL column
   * makes that update fail and either retains the erased rider's identifier forever or
   * re-runs a completed erasure. Required while ACTIONABLE for either kind, and while an
   * unidentified `support_only` row still owes enrichment.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  app_user_id!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  provider!: 'apple' | 'google' | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  product_id!: string | null;

  /** The stable chain identity — what support recognises a subscription by. */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  original_transaction_id!: string | null;

  /** The chain's staged identity; NULL for `erasure`, which names no chain. */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  target_key!: string | null;

  /**
   * True while {@link target_key} holds an observed store transaction id rather than the
   * stable original — the flag the enrichment merge keys off.
   *
   * An obligation the deletion enumeration creates has no original transaction id (the
   * subscriber response does not carry one), so its key is a per-renewal store id and must
   * be marked as such: enrichment re-keys it to the original and merges any row of the same
   * rider that resolves to it.
   */
  @Column({ type: 'boolean', default: false })
  target_key_provisional!: boolean;

  /**
   * The CURRENT Google order id, which is what the v1 cancel endpoint takes.
   *
   * A starting point, never the argument: it **advances on every renewal**, so it is
   * refreshed from the authoritative subscriber response immediately before each attempt.
   * That same re-query resolves the obligation `succeeded` when the subscription is
   * already non-renewing, rather than calling cancel again and failing permanently.
   */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  store_transaction_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_seen_active_at!: Date | null;

  /**
   * `support_only` is Apple: no server-side cancel exists, so the row is never an
   * actionable retry target. It is **resolved for gating** — it must not block erasure on
   * a cancellation that can never succeed — and **retained for support**.
   */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'succeeded' | 'failed' | 'retired' | 'support_only';

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  /**
   * False when enrichment could not obtain a stable id. Pins retention to the maximum
   * window rather than an extendable deadline: an unverifiable record must fail towards
   * KEEPING evidence, but still be bounded — "retain until we can check" is indefinite
   * retention for a rider who asked to be erased.
   */
  @Column({ type: 'boolean', default: true })
  export_matchable!: boolean;

  /**
   * When to stop waiting for the export to supply a stable id and proceed with erasure.
   *
   * NULL until the **purge**, which stamps it — anchored on when enrichment becomes
   * actionable, not on `created_at`. The row is written at deletion request up to 30 days
   * earlier, so a creation-anchored deadline is already ~28 days overdue at the first
   * attempt and the row would be marked unmatchable immediately, every time.
   */
  @Column({ type: 'timestamptz', nullable: true })
  enrichment_deadline_at!: Date | null;

  /**
   * Stamped when an outstanding obligation is escalated to an operator.
   *
   * An outstanding row stays actionable by design, so its deadline remains due and every
   * sweep re-selects it — and `openConflict` deliberately does not dedup. Without this, one
   * permanent failure files a fresh incident on every tick until someone intervenes.
   */
  @Column({ type: 'timestamptz', nullable: true })
  escalated_at!: Date | null;

  /**
   * Retention bound, per §6.5. The ANCHOR differs by kind because one of them has no
   * subscription: a `cancellation` uses the chain's period end plus the window, while an
   * `erasure` — and any row with no chain — uses `created_at`, since it records an
   * operation rather than a subscription.
   */
  @Column({ type: 'timestamptz' })
  retention_expires_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  /** NULL exactly while {@link status} is actionable — the sweep indexes partition on it. */
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;
}
