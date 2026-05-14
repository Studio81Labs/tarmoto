import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import type { NotificationCategory } from '@tarmoto/shared';
import { User } from './user.entity.js';

/**
 * In-app notification feed row. Push/email delivery can be transient,
 * but this table is the durable recent feed the companion bell reads.
 */
@Entity('user_notifications')
@Index('idx_user_notifications_user_created', ['user_id', 'created_at'])
@Index('idx_user_notifications_user_unread', ['user_id', 'read_at'])
export class UserNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64 })
  category!: NotificationCategory;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  data!: Record<string, string>;

  @Column({ type: 'timestamptz', nullable: true })
  read_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
