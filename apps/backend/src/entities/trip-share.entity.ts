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
import { Trip } from './trip.entity.js';

/**
 * US-35 — shareable invite link for a trip snapshot.
 *
 * Trip state currently lives client-side in the companion's Zustand store, so
 * this row captures the entire trip payload at share time in `snapshot` and
 * serves it back to anonymous viewers via a random `share_token`. When the
 * share was minted from a persisted server trip, `trip_id` also lets signed-in
 * recipients accept the share into trip membership and open the live
 * collaboration surface.
 */
@Entity('trip_shares')
@Index('idx_trip_shares_owner', ['owner_id'])
@Index('idx_trip_shares_trip', ['trip_id'])
@Index('idx_trip_shares_token', ['share_token'], { unique: true })
export class TripShare {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'uuid', nullable: true })
  trip_id!: string | null;

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

  @ManyToOne(() => Trip, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip | null;
}
