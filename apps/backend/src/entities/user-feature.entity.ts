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
 * Per-user feature override. Presence of a row is the override: `enabled =
 * true` force-grants the feature, `enabled = false` force-revokes it; no
 * row means the user resolves via registry default + tier grant. The flag
 * vocabulary itself is code-defined in `FEATURE_DEFINITIONS`
 * (`@tarmoto/shared`) — rows with keys that leave the registry are simply
 * ignored by the resolver.
 */
@Entity('user_features')
@Unique('uq_user_features_user_feature', ['user_id', 'feature'])
@Index('idx_user_features_feature', ['feature'])
export class UserFeature {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64 })
  feature!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
