import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import type {
  EmailDigestFrequency,
  NotificationCategory,
  NotificationChannelToggles,
} from '@tarmoto/shared';
import { User } from './user.entity.js';

/**
 * Per-user notification preferences — one row per user, keyed by
 * `user_id` (PK). Created lazily: most users will never visit the
 * preferences page, and writing a row at registration time would
 * leave us with a population of stale rows the day we add a new
 * category. Reads at dispatch time fall back to the canonical
 * defaults from `@tarmoto/shared` when no row exists.
 *
 * `categories` is JSONB — a typed bag rather than a column-per-toggle
 * because new categories ship roughly once per quarter and we don't
 * want a migration every time. Validation and defaulting live in
 * the service layer (see `mergeWithDefaults`).
 */
@Entity('notification_preferences')
export class NotificationPreferencesRow {
  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16, default: 'weekly' })
  email_digest!: EmailDigestFrequency;

  @Column({ type: 'boolean', default: false })
  marketing_emails!: boolean;

  /** Minutes from local midnight (0–1439). `start === end` disables. */
  @Column({ type: 'integer', default: 0 })
  quiet_hours_start!: number;

  @Column({ type: 'integer', default: 0 })
  quiet_hours_end!: number;

  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  quiet_hours_timezone!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  categories!: Partial<
    Record<NotificationCategory, NotificationChannelToggles>
  >;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
