import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Transactional inbox for Apple App Store Server Notifications v2 and Google
 * Play RTDN webhooks. Each inbound notification is upserted here (unique on
 * `(provider, notification_id)`) before any side-effecting work runs, so a
 * redelivered webhook is a no-op instead of double-applying a purchase or
 * renewal. `locked_by` + `lease_expires_at` back a lease-based worker claim
 * so retries and dead-lettering can run out of band from the webhook
 * request itself.
 */
@Entity('processed_store_notifications')
// Mirrors the migration's composite UNIQUE (provider, notification_id) so the
// entity documents the constraint the inbox dedup relies on. Harmless under
// `synchronize:false`; aids a future inbox-upsert `ON CONFLICT` target.
@Unique(['provider', 'notification_id'])
@Index('idx_psn_status_lease', ['status', 'lease_expires_at'])
export class ProcessedStoreNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: 'apple' | 'google';

  @Column({ type: 'varchar', length: 255 })
  notification_id!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'completed' | 'dead_letter';

  @Column({ type: 'varchar', length: 64, nullable: true })
  event_type!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  locked_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lease_expires_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 10 })
  max_attempts!: number;

  @Column({ type: 'varchar', length: 16, nullable: true })
  failure_class!: 'transient' | 'permanent' | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  dead_letter_reason!: 'permanent_reject' | 'corrupt_context' | null;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @Column({ type: 'timestamptz' })
  first_seen_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  dead_lettered_at!: Date | null;
}
