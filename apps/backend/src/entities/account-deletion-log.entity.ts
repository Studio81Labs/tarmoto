import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type AccountDeletionEvent = 'requested' | 'restored' | 'purged';

/**
 * Append-only audit row for GDPR account-deletion events. Survives the
 * hard delete it audits — `user_id` is a plain UUID with no FK back to
 * `users`, and `email` is captured at request time so support can
 * correlate after the user row is gone.
 */
@Entity('account_deletion_log')
@Index('idx_account_deletion_log_user', ['user_id', 'created_at'])
export class AccountDeletionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 20 })
  event!: AccountDeletionEvent;

  @Column({ type: 'timestamptz', nullable: true })
  scheduled_for!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripe_customer_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripe_subscription_id!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  details!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
