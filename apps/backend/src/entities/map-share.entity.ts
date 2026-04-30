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
import { User } from './user.entity.js';

/**
 * US-50 — shareable read-only personal road map.
 *
 * Captures the rider's exploration totals + ridden-segment list at share
 * time so the public viewer renders a stable snapshot even after the
 * underlying ride history changes. Mirrors the trip-shares pattern (US-35)
 * to keep the share-token / view-count surface consistent across products.
 */
@Entity('map_shares')
@Index('idx_map_shares_owner', ['owner_id'])
@Index('idx_map_shares_token', ['share_token'], { unique: true })
export class MapShare {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  share_token!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @Column({ type: 'int', default: 0 })
  view_count!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner!: User;
}
