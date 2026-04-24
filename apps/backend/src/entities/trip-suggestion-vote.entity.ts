import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { TripSuggestion } from './trip-suggestion.entity.js';
import { User } from './user.entity.js';

/**
 * One member's up/down vote on a trip suggestion. The unique
 * `(suggestion_id, user_id)` constraint enforces one-vote-per-member
 * so tallies are well-defined; changing a vote is an UPDATE rather
 * than a new row.
 */
@Entity('trip_suggestion_votes')
@Unique('uq_trip_suggestion_votes_member', ['suggestion_id', 'user_id'])
export class TripSuggestionVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  suggestion_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 4 })
  vote!: 'up' | 'down';

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => TripSuggestion, (s) => s.votes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'suggestion_id' })
  suggestion!: TripSuggestion;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
