import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import type { DevicePlatform } from '@tarmoto/shared';
import { User } from './user.entity.js';

/**
 * One row per (user, platform-issued push token). A single user can
 * register multiple devices (phone + tablet, or two phones), and the
 * same physical device can rotate its token at any time — both
 * scenarios coexist via the unique-on-(user, token) index.
 *
 * Soft-deleted via `deleted_at` rather than removed. Provider feedback
 * (FCM `UNREGISTERED`, APN `Unregistered`) means the token will never
 * accept another payload, but we keep the row for analytics
 * (re-registration latency, churn) and to fail closed on a returning
 * row that already had its push permissions stripped.
 */
@Entity('device_tokens')
@Index('idx_device_tokens_user', ['user_id'])
@Index('uq_device_tokens_user_token', ['user_id', 'token'], { unique: true })
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  platform!: DevicePlatform;

  @Column({ type: 'text' })
  token!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  app_version!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
