import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';

export type CrashAlertSeverity = 'low' | 'medium' | 'high';

export type CrashAlertContactStatus = 'sent' | 'failed' | 'skipped';

export type CrashAlertContactChannel = 'sms' | 'voice' | 'log';

/**
 * Per-contact dispatch outcome captured for audit + idempotency.
 * Stored as JSONB on the crash_alerts row so a single audit fetch
 * yields the full per-recipient delivery picture.
 */
export interface CrashAlertContactResult {
  contact_id: string;
  name: string;
  phone: string;
  channel: CrashAlertContactChannel;
  status: CrashAlertContactStatus;
  provider_message_id: string | null;
  error: string | null;
}

/**
 * Append-only crash alert audit row. Doubles as the idempotency key
 * store: dispatch is keyed off `id`, so a duplicate POST with the same
 * `alert_id` short-circuits to the previously recorded outcome instead
 * of re-sending SMS to every emergency contact.
 */
@Entity('crash_alerts')
// Composite index mirrors the migration's `(user_id, created_at DESC)`
// so `migration:generate` does not see drift and emit a recreate.
@Index('idx_crash_alerts_user', ['user_id', 'created_at'])
export class CrashAlert {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  ride_id!: string | null;

  @Column({ type: 'double precision' })
  lat!: number;

  @Column({ type: 'double precision' })
  lng!: number;

  @Column({ type: 'double precision', nullable: true })
  speed_at_impact!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'medium' })
  severity!: CrashAlertSeverity;

  @Column({ type: 'varchar', length: 16, nullable: true })
  locale!: string | null;

  @Column({ type: 'integer', default: 0 })
  contacts_notified!: number;

  @Column({ type: 'integer', default: 0 })
  contacts_total!: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  contact_results!: CrashAlertContactResult[];

  /**
   * Set once dispatch finishes (after every per-contact send returns).
   * NULL means the row is the placeholder created at request entry, so
   * concurrent retries can tell "in-flight" apart from "completed".
   */
  @Column({ type: 'timestamptz', nullable: true })
  dispatch_completed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
