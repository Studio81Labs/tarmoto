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
@Index(
  'uq_sbr_open_apple_otid_reason',
  ['apple_original_transaction_id', 'reason'],
  {
    unique: true,
    where: "status = 'open' AND apple_original_transaction_id IS NOT NULL",
  },
)
export class StoreBillingReconciliation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: 'stripe' | 'apple' | 'google';

  @Column({ type: 'varchar', length: 255, nullable: true })
  apple_original_transaction_id!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  google_store_transaction_id!: string | null;

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
    | 'unrecognized_product';

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: 'open' | 'resolved';

  @Column({ type: 'varchar', length: 32, nullable: true })
  resolution!:
    | 'rider_canceled'
    | 'refunded'
    | 'expired'
    | 'server_canceled'
    | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;
}
