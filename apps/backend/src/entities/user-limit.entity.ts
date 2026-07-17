import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';

/**
 * Per-user numeric limit override. Presence of a row is the override:
 * `value` replaces the tier value (`NULL` = unlimited); no row means the
 * user resolves via registry tier value. The limit vocabulary is
 * code-defined in `FEATURE_DEFINITIONS` (`@tarmoto/shared`) — rows with
 * keys that leave the registry are simply ignored by the resolver.
 */
@Entity('user_limits')
@Unique('uq_user_limits_user_feature', ['user_id', 'feature'])
@Index('idx_user_limits_feature', ['feature'])
export class UserLimit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64 })
  feature!: string;

  @Column({ type: 'integer', nullable: true })
  value!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
