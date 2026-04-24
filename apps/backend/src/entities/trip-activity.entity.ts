import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Trip } from './trip.entity.js';
import { User } from './user.entity.js';

/**
 * Append-only audit entry for a trip. The `action` column is a stable
 * discriminator (snake_case) and `payload` carries action-specific detail
 * as JSONB. The companion renders a single timeline by dispatching on
 * `action` without joining against every feature's table.
 */
export type TripActivityAction =
  | 'member_joined'
  | 'member_left'
  | 'trip_updated'
  | 'suggestion_created'
  | 'suggestion_deleted'
  | 'suggestion_voted'
  | 'suggestion_vote_removed'
  | 'suggestion_accepted'
  | 'suggestion_rejected';

@Entity('trip_activity')
@Index('idx_trip_activity_trip', ['trip_id', 'created_at'])
export class TripActivity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: TripActivityAction;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'actor_id' })
  actor!: User | null;
}
